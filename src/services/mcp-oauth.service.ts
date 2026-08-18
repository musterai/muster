// File: src/services/mcp-oauth.service.ts
//
// MCP-native OAuth (MUS-29) — RFC 7591 dynamic client registration plus
// Authorization Code + PKCE per the current MCP Authorization spec (OAuth
// 2.1 draft, RFC 8707 resource indicators). The consent step mints/reuses
// an AGENT principal owned by the approving user and issues a normal
// api_token for it — the exact same object PATs and the device grant issue,
// so verification, revocation, and effective-permission intersection
// (design doc §4, via RoleService.getEffectivePermissions) are unchanged.

import crypto from 'node:crypto';
import { ulid } from 'ulid';
import { DatabaseAdapter } from '../db/adapter.js';
import { TokenService, hashToken } from './token.service.js';
import { AgentService } from './agent.service.js';
import { AuditService } from './audit.service.js';
import { CreatedApiToken } from '../shared/types.js';
import { PermissionDeniedError } from '../shared/permission-enforcer.js';
import { ValidationError } from '../shared/errors.js';

const AUTH_CODE_TTL_SECONDS = 120;

export interface OAuthClient {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
}

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string;
  agentPrincipalId: string;
  operatorUserId: string;
  workspaceId: string;
}

export type TokenResult =
  | { ok: true; token: CreatedApiToken; refreshToken: string }
  | { ok: false; error: string; error_description?: string };

/** Loopback redirect URIs (RFC 8252 §7.3) may vary in port even if not pre-registered with that exact port. */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '[::1]' || host === 'localhost';
}

export function redirectUriMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const r = new URL(registered);
    const q = new URL(requested);
    if (!isLoopbackHost(r.hostname) || !isLoopbackHost(q.hostname)) return false;
    return r.protocol === q.protocol && r.pathname === q.pathname && r.search === q.search;
  } catch {
    return false;
  }
}

/** RFC 7636 S256: BASE64URL(SHA256(code_verifier)) === code_challenge. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
  // Both sides are short, non-secret-once-exchanged strings tied to a
  // single-use code — timing-safe comparison is defense in depth, not the
  // primary protection (that's the code being single-use and short-lived).
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export class McpOAuthService {
  constructor(
    private db: DatabaseAdapter,
    private tokenService: TokenService,
    private agentService: AgentService,
    private auditService?: AuditService,
  ) {}

  async registerClient(data: { client_name?: string; redirect_uris: string[]; token_endpoint_auth_method?: string }): Promise<OAuthClient> {
    if (!Array.isArray(data.redirect_uris) || data.redirect_uris.length === 0) {
      throw new Error('redirect_uris is required and must be a non-empty array');
    }
    for (const uri of data.redirect_uris) {
      try {
        const parsed = new URL(uri);
        if (parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname) && parsed.protocol !== 'http:') {
          throw new Error(`Invalid redirect_uri: ${uri}`);
        }
      } catch {
        throw new Error(`Invalid redirect_uri: ${uri}`);
      }
    }

    const clientId = `mcp_${crypto.randomBytes(16).toString('hex')}`;
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO oauth_client (client_id, client_name, redirect_uris_json, token_endpoint_auth_method, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [clientId, data.client_name || null, JSON.stringify(data.redirect_uris), data.token_endpoint_auth_method || 'none', now],
    );

    return {
      client_id: clientId,
      client_name: data.client_name || null,
      redirect_uris: data.redirect_uris,
      token_endpoint_auth_method: data.token_endpoint_auth_method || 'none',
    };
  }

  async getClient(clientId: string, db: DatabaseAdapter = this.db): Promise<OAuthClient | null> {
    const rows = await db.query<any>('SELECT * FROM oauth_client WHERE client_id = ?', [clientId]);
    if (rows.length === 0) return null;
    return {
      client_id: rows[0].client_id,
      client_name: rows[0].client_name,
      redirect_uris: JSON.parse(rows[0].redirect_uris_json),
      token_endpoint_auth_method: rows[0].token_endpoint_auth_method,
    };
  }

  /** Issued after the consent screen picks (or creates) the agent identity and role. */
  async createAuthorizationCode(params: AuthorizeParams): Promise<string> {
    // Consent normally performs this check through the REST handler, but the
    // service boundary repeats it so another transport cannot forge a code
    // for an unrelated agent or workspace.
    await this.tokenService.authorizeForOperatorOwnedAgent(
      params.operatorUserId,
      params.workspaceId,
      params.agentPrincipalId,
      { name: 'MCP authorization' },
    );

    const code = crypto.randomBytes(32).toString('hex');
    const now = new Date();
    await this.db.execute(
      `INSERT INTO oauth_authorization_code
         (code_hash, client_id, redirect_uri, code_challenge, code_challenge_method, resource, agent_principal_id, operator_user_id, workspace_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        hashToken(code), params.clientId, params.redirectUri, params.codeChallenge, params.codeChallengeMethod,
        params.resource, params.agentPrincipalId, params.operatorUserId, params.workspaceId,
        new Date(now.getTime() + AUTH_CODE_TTL_SECONDS * 1000).toISOString(), now.toISOString(),
      ],
    );
    return code;
  }

  /** Authorization Code grant — single-use: the row is deleted whether the exchange succeeds or fails on a later check. */
  async exchangeAuthorizationCode(params: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
    resource: string;
  }): Promise<TokenResult> {
    const codeHash = hashToken(params.code);
    return this.db.transaction(async tx => {
      const rows = await tx.query<any>('SELECT * FROM oauth_authorization_code WHERE code_hash = ?', [codeHash]);
      const row = rows[0];
      if (!row) return { ok: false, error: 'invalid_grant', error_description: 'Unknown or already-used authorization code' };

      // Claim before validation. Expected validation/policy failures return
      // normally and commit this one-time consumption; unexpected storage or
      // audit failures throw and restore the code with the rest of the tx.
      const consumed = await tx.execute('DELETE FROM oauth_authorization_code WHERE code_hash = ?', [codeHash]);
      if (consumed.changes !== 1) {
        return { ok: false, error: 'invalid_grant', error_description: 'Unknown or already-used authorization code' };
      }

      if (new Date(row.expires_at).getTime() <= Date.now()) {
        return { ok: false, error: 'invalid_grant', error_description: 'Authorization code expired' };
      }
      if (row.client_id !== params.clientId) {
        return { ok: false, error: 'invalid_grant', error_description: 'client_id mismatch' };
      }
      if (row.redirect_uri !== params.redirectUri) {
        return { ok: false, error: 'invalid_grant', error_description: 'redirect_uri mismatch' };
      }
      if (row.resource !== params.resource) {
        return { ok: false, error: 'invalid_target', error_description: 'resource mismatch' };
      }
      if (!verifyPkce(params.codeVerifier, row.code_challenge)) {
        return { ok: false, error: 'invalid_grant', error_description: 'PKCE verification failed' };
      }

      try {
        return await this.issueTokenFamily({
          clientId: row.client_id,
          agentPrincipalId: row.agent_principal_id,
          operatorUserId: row.operator_user_id,
          workspaceId: row.workspace_id,
          resource: row.resource,
          familyId: ulid(),
        }, tx);
      } catch (error) {
        if (!(error instanceof PermissionDeniedError) && !(error instanceof ValidationError)) throw error;
        await this.auditIssuanceRefusal(row.workspace_id, row.operator_user_id, 'mcp_oauth', tx);
        return { ok: false, error: 'invalid_grant', error_description: 'Authorization could not be completed' };
      }
    });
  }

  /** Refresh Token grant — rotates on every use; a replayed (already-used) token revokes the whole family. */
  async refreshToken(params: { refreshToken: string; clientId: string; resource: string }): Promise<TokenResult> {
    const hash = hashToken(params.refreshToken);
    return this.db.transaction(async tx => {
      let rows = await tx.query<any>('SELECT * FROM oauth_refresh_token WHERE token_hash = ?', [hash]);
      let row = rows[0];
      if (!row) return { ok: false, error: 'invalid_grant', error_description: 'Unknown refresh token' };

      // Validate caller-controlled bindings before replay handling: a client
      // that does not own this token must not be able to revoke its family.
      if (row.client_id !== params.clientId) {
        return { ok: false, error: 'invalid_grant', error_description: 'client_id mismatch' };
      }
      if (row.resource !== params.resource) {
        return { ok: false, error: 'invalid_target', error_description: 'resource mismatch' };
      }

      await this.lockRefreshFamily(tx, row.family_id);
      rows = await tx.query<any>('SELECT * FROM oauth_refresh_token WHERE token_hash = ?', [hash]);
      row = rows[0];
      if (!row) return { ok: false, error: 'invalid_grant', error_description: 'Unknown refresh token' };

      if (row.revoked || row.used) {
        await this.revokeFamilyInTransaction(tx, row.family_id);
        return { ok: false, error: 'invalid_grant', error_description: 'Refresh token reuse detected; the token family has been revoked' };
      }

      const claimed = await tx.execute(
        `UPDATE oauth_refresh_token
            SET used = 1
          WHERE token_hash = ? AND used = 0 AND revoked = 0`,
        [hash],
      );
      if (claimed.changes !== 1) {
        await this.revokeFamilyInTransaction(tx, row.family_id);
        return { ok: false, error: 'invalid_grant', error_description: 'Refresh token reuse detected; the token family has been revoked' };
      }

      const tokenService = this.tokenServiceFor(tx);
      if (row.current_api_token_id) {
        await tokenService.revoke(row.current_api_token_id);
      }

      try {
        return await this.issueTokenFamily({
          clientId: row.client_id,
          agentPrincipalId: row.agent_principal_id,
          workspaceId: row.workspace_id,
          resource: row.resource,
          familyId: row.family_id,
        }, tx);
      } catch (error) {
        if (!(error instanceof PermissionDeniedError) && !(error instanceof ValidationError)) throw error;
        await this.auditIssuanceRefusalForAgent(row.workspace_id, row.agent_principal_id, 'mcp_oauth', tx);
        return { ok: false, error: 'invalid_grant', error_description: 'Authorization could not be completed' };
      }
    });
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.db.transaction(async tx => {
      await this.lockRefreshFamily(tx, familyId);
      await this.revokeFamilyInTransaction(tx, familyId);
    });
  }

  private async revokeFamilyInTransaction(db: DatabaseAdapter, familyId: string): Promise<void> {
    const rows = await db.query<{ current_api_token_id: string | null; agent_principal_id: string; workspace_id: string }>(
      'SELECT current_api_token_id, agent_principal_id, workspace_id FROM oauth_refresh_token WHERE family_id = ? AND revoked = 0',
      [familyId],
    );
    const tokenService = this.tokenServiceFor(db);
    const auditService = this.auditServiceFor(db);
    for (const row of rows) {
      if (row.current_api_token_id) {
        await tokenService.revoke(row.current_api_token_id);
        await auditService?.log({
          workspace_id: row.workspace_id,
          actor: { id: row.agent_principal_id, kind: 'agent' },
          action: 'token.revoke',
          target_type: 'api_token',
          target_id: row.current_api_token_id,
          payload: { reason: 'refresh_token_reuse_detected', family_id: familyId },
        });
      }
    }
    await db.execute('UPDATE oauth_refresh_token SET revoked = 1 WHERE family_id = ?', [familyId]);
  }

  private async issueTokenFamily(params: {
    clientId: string;
    agentPrincipalId: string;
    operatorUserId?: string;
    workspaceId: string;
    resource: string;
    familyId: string;
  }, db: DatabaseAdapter = this.db): Promise<TokenResult> {
    const client = await this.getClient(params.clientId, db);
    const tokenData = { name: `MCP client: ${client?.client_name || params.clientId}` };
    const tokenService = this.tokenServiceFor(db);
    const auditService = this.auditServiceFor(db);
    const actorId = params.operatorUserId || (await db.query<{ operator_user_id: string | null }>(
      'SELECT operator_user_id FROM agent WHERE id = ? AND workspace_id = ?',
      [params.agentPrincipalId, params.workspaceId],
    ))[0]?.operator_user_id;
    if (!actorId) throw new PermissionDeniedError('agent.register', null);

    const token = params.operatorUserId
      ? await tokenService.issueForOperatorOwnedAgent(
          params.operatorUserId,
          params.workspaceId,
          params.agentPrincipalId,
          tokenData,
        )
      : await tokenService.issueForCurrentAgentOwner(
          params.agentPrincipalId,
          params.workspaceId,
          tokenData,
        );

    const refreshToken = crypto.randomBytes(32).toString('hex');
    const now = new Date().toISOString();
    await db.execute(
      `INSERT INTO oauth_refresh_token (token_hash, family_id, client_id, agent_principal_id, workspace_id, resource, current_api_token_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [hashToken(refreshToken), params.familyId, params.clientId, params.agentPrincipalId, params.workspaceId, params.resource, token.id, now],
    );

    await auditService?.log({
      workspace_id: params.workspaceId,
      actor: { id: actorId, kind: 'user' },
      action: 'token.create',
      target_type: 'api_token',
      target_id: token.id,
      payload: { via: 'mcp_oauth', client_id: params.clientId },
    });

    return { ok: true, token, refreshToken };
  }

  private tokenServiceFor(db: DatabaseAdapter): TokenService {
    return db === this.db ? this.tokenService : new TokenService(db);
  }

  private auditServiceFor(db: DatabaseAdapter): AuditService | undefined {
    if (!this.auditService) return undefined;
    return db === this.db ? this.auditService : new AuditService(db);
  }

  private async lockRefreshFamily(db: DatabaseAdapter, familyId: string): Promise<void> {
    if (db.dialect !== 'postgres') return;
    await db.execute('SELECT pg_advisory_xact_lock(hashtext(?))', [`muster:oauth-refresh:${familyId}`]);
  }

  private async auditIssuanceRefusal(
    workspaceId: string,
    actorId: string,
    via: string,
    db: DatabaseAdapter = this.db,
  ): Promise<void> {
    const auditService = this.auditServiceFor(db);
    if (!auditService) return;
    try {
      await auditService.log({
        workspace_id: workspaceId,
        actor: { id: actorId, kind: 'user' },
        action: 'token.create_refused',
        target_type: 'api_token',
        target_id: undefined,
        payload: { via, reason: 'authorization_changed' },
      });
    } catch {
      // Do not expose audit sink failures to an OAuth client.
    }
  }

  private async auditIssuanceRefusalForAgent(
    workspaceId: string,
    agentId: string,
    via: string,
    db: DatabaseAdapter = this.db,
  ): Promise<void> {
    if (!this.auditServiceFor(db)) return;
    const rows = await db.query<{ operator_user_id: string | null }>(
      'SELECT operator_user_id FROM agent WHERE id = ? AND workspace_id = ?',
      [agentId, workspaceId],
    );
    if (!rows[0]?.operator_user_id) return;
    await this.auditIssuanceRefusal(workspaceId, rows[0].operator_user_id, via, db);
  }
}
