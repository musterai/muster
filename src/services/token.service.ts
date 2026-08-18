// File: src/services/token.service.ts
//
// Personal Access Token (PAT) management for MUS-24.
// Tokens are minted as "muster_pat_<prefix>_<secret>" — only the SHA-256 hash
// is stored. The plaintext secret is shown exactly once on creation.

import crypto from 'node:crypto';
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { ApiToken, CreatedApiToken } from '../shared/types.js';
import { AuthContext, PrincipalKind } from '../shared/auth-context.js';
import { ValidationError } from '../shared/errors.js';
import { PermissionDeniedError } from '../shared/permission-enforcer.js';
import { effectivePermissions } from '../shared/permissions.js';

/** Token prefix length in characters. */
const PREFIX_LENGTH = 8;

/** Secret length in bytes (generates hex string 2× this length). */
const SECRET_BYTES = 24;

/** Minimum seconds between last_used_at updates per token. */
const LAST_USED_THROTTLE_MS = 60_000;

/** The bearer-token prefix constant. */
export const TOKEN_BRAND = 'muster_pat';

function parsePermissions(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((permission): permission is string => typeof permission === 'string');
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((permission): permission is string => typeof permission === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Compute SHA-256 hex digest of a token string.
 * Always produces a 64-character lowercase hex string.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf-8').digest('hex');
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf-8');
  const bBuf = Buffer.from(b, 'utf-8');
  if (aBuf.length !== bBuf.length) {
    // Compare against self to keep constant-ish time, then return false
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Generate a cryptographically random hex string.
 */
function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export interface TokenVerification {
  id: string;
  principal_id: string;
  workspace_id: string;
}

/**
 * Request data accepted by the authorization boundary.  The fields are
 * intentionally unknown here: REST, OAuth and device-grant callers all
 * cross this boundary, so validation must not rely on a transport's schema.
 */
export interface TokenIssueInput {
  principal_id?: unknown;
  workspace_id?: unknown;
  name?: unknown;
  expires_at?: unknown;
}

interface NormalizedTokenIssue {
  principal_id: string;
  workspace_id: string;
  name: string;
  expires_at: string | null;
}

interface PrincipalSnapshot {
  id: string;
  kind: PrincipalKind;
  operator_user_id?: string | null;
  permissions: string[];
  role_name: string | null;
}

export class TokenService {
  constructor(private db: DatabaseAdapter) {}

  /**
   * Authorize a token issuance without creating a token.
   *
   * This is the shared policy boundary for every transport.  The legacy
   * `create` method below is the storage primitive used by migration-era
   * fixtures and trusted internal setup; request paths must use `issue` (or
   * one of the grant helpers) so a caller cannot select another principal or
   * workspace by supplying database identifiers.
   */
  async authorize(auth: AuthContext, data: TokenIssueInput): Promise<NormalizedTokenIssue> {
    const normalized = this.normalizeIssueInput(auth, data);
    const actor = await this.resolveActor(auth.principal!.id, auth.principal!.kind, normalized.workspace_id);
    if (!actor) throw this.denied(auth);

    const target = await this.resolveTarget(normalized.principal_id, normalized.workspace_id);
    if (!target) {
      // Deliberately collapse unknown, cross-workspace and inactive targets
      // into the same refusal so target existence cannot be enumerated.
      throw this.denied(auth);
    }

    // Self issuance is valid for either principal kind, but only while the
    // principal has an active workspace membership resolved above.
    if (target.id === actor.id) return normalized;

    // A human may issue a token for an agent only when they operate it and
    // their current role still grants the purpose-appropriate, existing
    // agent.register permission.  No user may issue for another user, and an
    // agent may never issue for a different principal.
    if (
      actor.kind === 'user' &&
      target.kind === 'agent' &&
      target.operator_user_id === actor.id
    ) {
      if (!actor.permissions.includes('agent.register')) throw this.denied(auth);

      // Resolve the effective set here as a defense-in-depth assertion.  The
      // token does not copy permissions; auth middleware recomputes the
      // agent/operator intersection on every use, so later role changes take
      // effect immediately.
      effectivePermissions(target.permissions, actor.permissions);
      return normalized;
    }

    throw this.denied(auth);
  }

  /** Authorize and mint a token for an authenticated request. */
  async issue(auth: AuthContext, data: TokenIssueInput): Promise<CreatedApiToken> {
    const normalized = await this.authorize(auth, data);
    return this.create(normalized);
  }

  /**
   * Mint a self token for a previously approved device grant.  The grant
   * stores only the principal/workspace binding; membership is revalidated
   * at poll time before any secret is generated.
   */
  async issueForPrincipal(
    principalId: string,
    workspaceId: string,
    data: Omit<TokenIssueInput, 'principal_id' | 'workspace_id'> = {},
  ): Promise<CreatedApiToken> {
    const kind = await this.principalKind(principalId);
    if (!kind) throw this.denied();
    return this.issue(
      this.grantAuthContext(kind, principalId, workspaceId),
      { ...data, principal_id: principalId, workspace_id: workspaceId },
    );
  }

  /**
   * Mint a token for an agent only after rechecking its recorded operator,
   * workspace membership and effective role intersection.  OAuth code and
   * refresh-token exchanges use this helper because they occur without the
   * approving user's live HTTP credential.
   */
  async issueForOperatorOwnedAgent(
    operatorUserId: string,
    workspaceId: string,
    agentPrincipalId: string,
    data: Omit<TokenIssueInput, 'principal_id' | 'workspace_id'> = {},
  ): Promise<CreatedApiToken> {
    return this.issue(
      this.grantAuthContext('user', operatorUserId, workspaceId),
      { ...data, principal_id: agentPrincipalId, workspace_id: workspaceId },
    );
  }

  /** Check an OAuth/device binding without minting a secret. */
  async authorizeForOperatorOwnedAgent(
    operatorUserId: string,
    workspaceId: string,
    agentPrincipalId: string,
    data: Omit<TokenIssueInput, 'principal_id' | 'workspace_id'> = {},
  ): Promise<void> {
    await this.authorize(
      this.grantAuthContext('user', operatorUserId, workspaceId),
      { ...data, principal_id: agentPrincipalId, workspace_id: workspaceId },
    );
  }

  /** Re-resolve the current operator before rotating an MCP OAuth token. */
  async issueForCurrentAgentOwner(
    agentPrincipalId: string,
    workspaceId: string,
    data: Omit<TokenIssueInput, 'principal_id' | 'workspace_id'> = {},
  ): Promise<CreatedApiToken> {
    const rows = await this.db.query<{ operator_user_id: string | null }>(
      `SELECT operator_user_id
         FROM agent
        WHERE id = ? AND workspace_id = ?`,
      [agentPrincipalId, workspaceId],
    );
    const operatorUserId = rows[0]?.operator_user_id;
    if (!operatorUserId) throw this.denied();
    return this.issueForOperatorOwnedAgent(operatorUserId, workspaceId, agentPrincipalId, data);
  }

  /**
   * Create a new personal access token.
   * Returns the full token string (shown once) and the stored record.
   */
  async create(data: {
    principal_id: string;
    workspace_id: string;
    name: string;
    expires_at?: string | null;
  }): Promise<CreatedApiToken> {
    const id = ulid();
    const prefix = randomHex(PREFIX_LENGTH / 2); // 8 hex chars
    const secret = randomHex(SECRET_BYTES); // 48 hex chars
    const token = `${TOKEN_BRAND}_${prefix}_${secret}`;
    const tokenHash = hashToken(token);
    const now = new Date().toISOString();

    await this.db.execute(
      `INSERT INTO api_token (id, principal_id, workspace_id, name, token_hash, prefix, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, data.principal_id, data.workspace_id, data.name, tokenHash, prefix, data.expires_at || null, now],
    );

    return {
      id,
      principal_id: data.principal_id,
      workspace_id: data.workspace_id,
      name: data.name,
      prefix,
      expires_at: data.expires_at || null,
      revoked_at: null,
      last_used_at: null,
      created_at: now,
      token,
    };
  }

  private normalizeIssueInput(auth: AuthContext, data: TokenIssueInput): NormalizedTokenIssue {
    if (!auth.principal || !auth.workspace_id) throw this.denied(auth);

    const workspaceId = data.workspace_id;
    if (workspaceId !== undefined && workspaceId !== null && (typeof workspaceId !== 'string' || workspaceId !== auth.workspace_id)) {
      throw this.denied(auth);
    }

    if (typeof data.name !== 'string') {
      throw new ValidationError('Token name is required');
    }
    const name = data.name.trim();
    if (name.length === 0 || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new ValidationError('Token name must be between 1 and 200 printable characters');
    }

    let expiresAt: string | null = null;
    if (data.expires_at !== undefined && data.expires_at !== null) {
      if (typeof data.expires_at !== 'string' || data.expires_at.trim().length === 0) {
        throw new ValidationError('expires_at must be a future ISO timestamp');
      }
      const parsed = Date.parse(data.expires_at);
      if (!Number.isFinite(parsed) || parsed <= Date.now()) {
        throw new ValidationError('expires_at must be a future ISO timestamp');
      }
      expiresAt = new Date(parsed).toISOString();
    }

    const principalId = data.principal_id === undefined || data.principal_id === null
      ? auth.principal.id
      : data.principal_id;
    if (typeof principalId !== 'string' || principalId.trim().length === 0) {
      throw new ValidationError('target_principal_id must be a non-empty string');
    }

    return {
      principal_id: principalId.trim(),
      workspace_id: auth.workspace_id,
      name,
      expires_at: expiresAt,
    };
  }

  private async principalKind(principalId: string): Promise<PrincipalKind | null> {
    const rows = await this.db.query<{ kind: PrincipalKind }>('SELECT kind FROM principal WHERE id = ?', [principalId]);
    return rows[0]?.kind || null;
  }

  private grantAuthContext(kind: PrincipalKind, id: string, workspaceId: string): AuthContext {
    return {
      principal: { kind, id },
      workspace_id: workspaceId,
      is_workspace_member: false,
      permissions: [],
      is_operator_override: false,
      role_name: null,
    };
  }

  private async resolveActor(id: string, kind: PrincipalKind, workspaceId: string): Promise<PrincipalSnapshot | null> {
    const principalRows = await this.db.query<{ kind: PrincipalKind }>('SELECT kind FROM principal WHERE id = ?', [id]);
    if (principalRows.length === 0 || principalRows[0].kind !== kind) return null;

    if (kind === 'user') {
      const rows = await this.db.query<any>(
        `SELECT wm.role_id, r.name AS role_name, r.permissions_json
           FROM app_user u
           JOIN workspace_member wm ON wm.user_id = u.id AND wm.workspace_id = ?
           JOIN role r ON r.id = wm.role_id AND r.workspace_id = wm.workspace_id
          WHERE u.id = ?
          LIMIT 1`,
        [workspaceId, id],
      );
      if (rows.length === 0) return null;
      return {
        id,
        kind,
        permissions: parsePermissions(rows[0].permissions_json),
        role_name: rows[0].role_name || null,
      };
    }

    const rows = await this.db.query<any>(
      `SELECT a.operator_user_id,
              ar.permissions_json AS agent_permissions,
              opr.permissions_json AS operator_permissions,
              opr.name AS role_name
         FROM agent a
         JOIN app_user op ON op.id = a.operator_user_id
         JOIN workspace_member wm
           ON wm.user_id = a.operator_user_id
          AND wm.workspace_id = a.workspace_id
         JOIN role ar ON ar.id = a.role_id AND ar.workspace_id = a.workspace_id
         JOIN role opr ON opr.id = wm.role_id AND opr.workspace_id = wm.workspace_id
        WHERE a.id = ? AND a.workspace_id = ?
        LIMIT 1`,
      [id, workspaceId],
    );
    if (rows.length === 0) return null;

    const agentPermissions = parsePermissions(rows[0].agent_permissions);
    const operatorPermissions = parsePermissions(rows[0].operator_permissions);
    return {
      id,
      kind,
      operator_user_id: rows[0].operator_user_id,
      permissions: effectivePermissions(agentPermissions, operatorPermissions),
      role_name: rows[0].role_name || null,
    };
  }

  private async resolveTarget(id: string, workspaceId: string): Promise<PrincipalSnapshot | null> {
    const userRows = await this.db.query<any>(
      `SELECT r.permissions_json, r.name AS role_name
         FROM principal p
         JOIN app_user u ON u.id = p.id
         JOIN workspace_member wm ON wm.user_id = u.id AND wm.workspace_id = ?
         JOIN role r ON r.id = wm.role_id AND r.workspace_id = wm.workspace_id
        WHERE p.id = ? AND p.kind = 'user'
        LIMIT 1`,
      [workspaceId, id],
    );
    if (userRows.length > 0) {
      return {
        id,
        kind: 'user',
        permissions: parsePermissions(userRows[0].permissions_json),
        role_name: userRows[0].role_name || null,
      };
    }

    const agentRows = await this.db.query<any>(
      `SELECT a.operator_user_id,
              ar.permissions_json AS agent_permissions,
              opr.permissions_json AS operator_permissions,
              opr.name AS role_name
         FROM principal p
         JOIN agent a ON a.id = p.id
         JOIN app_user op ON op.id = a.operator_user_id
         JOIN workspace_member wm
           ON wm.user_id = a.operator_user_id
          AND wm.workspace_id = a.workspace_id
         JOIN role ar ON ar.id = a.role_id AND ar.workspace_id = a.workspace_id
         JOIN role opr ON opr.id = wm.role_id AND opr.workspace_id = wm.workspace_id
        WHERE p.id = ? AND p.kind = 'agent' AND a.workspace_id = ?
        LIMIT 1`,
      [id, workspaceId],
    );
    if (agentRows.length === 0) return null;

    return {
      id,
      kind: 'agent',
      operator_user_id: agentRows[0].operator_user_id,
      permissions: effectivePermissions(
        parsePermissions(agentRows[0].agent_permissions),
        parsePermissions(agentRows[0].operator_permissions),
      ),
      role_name: agentRows[0].role_name || null,
    };
  }

  private denied(auth?: AuthContext): PermissionDeniedError {
    return new PermissionDeniedError('agent.register', auth?.role_name || null);
  }

  /**
   * Verify a bearer token string.
   * Returns the token record's identity info on success, null on failure.
   * Throttles last_used_at updates to once per minute per token.
   */
  async verify(tokenString: string): Promise<TokenVerification | null> {
    // Parse token format: muster_pat_<prefix>_<secret>
    if (!tokenString.startsWith(`${TOKEN_BRAND}_`)) return null;
    const rest = tokenString.slice(TOKEN_BRAND.length + 1);
    const parts = rest.split('_');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

    const hash = hashToken(tokenString);

    const rows = await this.db.query<any>(
      'SELECT id, principal_id, workspace_id, token_hash, expires_at, revoked_at, last_used_at FROM api_token WHERE token_hash = ?',
      [hash],
    );

    if (rows.length === 0) return null;

    const row = rows[0];

    // Constant-time re-verify the hash
    if (!timingSafeEqual(hash, row.token_hash)) return null;

    // Check revocation
    if (row.revoked_at) return null;

    // Check expiry
    if (row.expires_at && new Date(row.expires_at) <= new Date()) return null;

    // Throttled last_used_at update (once per minute)
    const now = new Date();
    const lastUsed = row.last_used_at ? new Date(row.last_used_at) : null;
    if (!lastUsed || now.getTime() - lastUsed.getTime() > LAST_USED_THROTTLE_MS) {
      await this.db.execute(
        'UPDATE api_token SET last_used_at = ? WHERE id = ?',
        [now.toISOString(), row.id],
      );
    }

    return {
      id: row.id,
      principal_id: row.principal_id,
      workspace_id: row.workspace_id,
    };
  }

  /**
   * Revoke a token immediately by setting revoked_at.
   */
  async revoke(id: string): Promise<void> {
    await this.db.execute(
      'UPDATE api_token SET revoked_at = ? WHERE id = ?',
      [new Date().toISOString(), id],
    );
  }

  /**
   * List tokens for a principal (or all tokens if no principal_id given).
   */
  async list(principalId?: string): Promise<ApiToken[]> {
    let rows: any[];
    if (principalId) {
      rows = await this.db.query(
        'SELECT id, principal_id, workspace_id, name, prefix, expires_at, revoked_at, last_used_at, created_at FROM api_token WHERE principal_id = ? ORDER BY created_at DESC',
        [principalId],
      );
    } else {
      rows = await this.db.query(
        'SELECT id, principal_id, workspace_id, name, prefix, expires_at, revoked_at, last_used_at, created_at FROM api_token ORDER BY created_at DESC',
      );
    }

    return rows.map(this.mapRow);
  }

  /**
   * Get a single token by ID.
   */
  async getById(id: string): Promise<ApiToken | null> {
    const rows = await this.db.query<any>(
      'SELECT id, principal_id, workspace_id, name, prefix, expires_at, revoked_at, last_used_at, created_at FROM api_token WHERE id = ?',
      [id],
    );
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  private mapRow(row: any): ApiToken {
    return {
      id: row.id,
      principal_id: row.principal_id,
      workspace_id: row.workspace_id,
      name: row.name,
      prefix: row.prefix,
      expires_at: row.expires_at || null,
      revoked_at: row.revoked_at || null,
      last_used_at: row.last_used_at || null,
      created_at: row.created_at,
    };
  }
}
