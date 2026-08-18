// File: tests/token.test.ts
//
// MUS-24 acceptance criteria:
// 1. A valid token resolves the correct principal and permission set.
// 2. A revoked token is refused on the very next request.
// 3. An expired token is refused with an error distinct from revocation.
// 4. The plaintext secret appears nowhere in the database after creation.
// 5. A token minted for an agent cannot perform actions the agent's effective
//    permissions exclude.
// 6. last_used_at updates are throttled; N rapid requests produce at most one write.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabaseAdapter } from '../src/db/factory.js';
import { DatabaseAdapter } from '../src/db/adapter.js';
import { Migrator } from '../src/db/migrator.js';
import {
  TokenService, hashToken, TOKEN_BRAND,
} from '../src/services/token.service.js';
import { RoleService, EventService } from '../src/services/index.js';
import { PRESET_ROLES } from '../src/shared/permissions.js';
import { requirePermission, PermissionDeniedError } from '../src/shared/permission-enforcer.js';
import { AuthContext } from '../src/shared/auth-context.js';
import { config } from '../src/config/index.js';

const TEST_DB = path.join(process.cwd(), 'data', 'test-token.db');

describe('MUS-24: Token Service', () => {
  let db: DatabaseAdapter;
  let tokenService: TokenService;
  let roleService: RoleService;
  let principalId: string;
  let workspaceId: string;
  let userId: string;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = createDatabaseAdapter(TEST_DB);

    const migrator = new Migrator(db, path.join(process.cwd(), 'src/db/migrations'));
    await migrator.run();

    tokenService = new TokenService(db);
    const eventService = new EventService(db);
    roleService = new RoleService(db, eventService);

    // Bootstrap workspace
    workspaceId = 'test-ws-token-01';
    const now = new Date().toISOString();
    await db.execute(
      'INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [workspaceId, 'Token Test WS', 'token-test', now, now],
    );

    // Seed preset roles
    await roleService.seedPreset(workspaceId);

    // Create a user principal + app_user for token binding
    principalId = 'test-principal-user-01';
    userId = principalId;
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [principalId, 'user', now]);
    await db.execute(
      'INSERT INTO app_user (id, email, display_name, status, created_at) VALUES (?, ?, ?, ?, ?)',
      [userId, 'test@example.com', 'Test User', 'active', now],
    );
  });

  afterEach(async () => {
    if (db) await db.close();
    if (fs.existsSync(TEST_DB)) {
      // Clean up WAL/SHM files too
      try { fs.unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
      try { fs.unlinkSync(TEST_DB + '-shm'); } catch { /* ok */ }
      fs.unlinkSync(TEST_DB);
    }
  });

  // ============================================================
  // Acceptance 1: valid token resolves the correct principal
  // ============================================================

  it('should create a token and verify it resolves the correct principal', async () => {
    const created = await tokenService.create({
      principal_id: principalId,
      workspace_id: workspaceId,
      name: 'Test Token',
    });

    // Token format: muster_pat_<prefix>_<secret>
    expect(created.token).toMatch(/^muster_pat_[a-f0-9]{8}_[a-f0-9]{48}$/);
    expect(created.principal_id).toBe(principalId);
    expect(created.workspace_id).toBe(workspaceId);
    expect(created.name).toBe('Test Token');
    expect(created.prefix).toBeDefined();
    expect(created.expires_at).toBeNull();
    expect(created.revoked_at).toBeNull();
    expect(created.last_used_at).toBeNull();

    // Verify the token
    const verification = await tokenService.verify(created.token);
    expect(verification).not.toBeNull();
    expect(verification!.principal_id).toBe(principalId);
    expect(verification!.workspace_id).toBe(workspaceId);
    expect(verification!.id).toBe(created.id);
  });

  it('should reject an invalid token (wrong secret)', async () => {
    const created = await tokenService.create({
      principal_id: principalId,
      workspace_id: workspaceId,
      name: 'Mine',
    });

    // Tamper with the token
    const tampered = created.token.replace(/_[a-f0-9]{48}$/, '_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const verification = await tokenService.verify(tampered);
    expect(verification).toBeNull();
  });

  it('should reject a malformed token string', async () => {
    expect(await tokenService.verify('not-a-token')).toBeNull();
    expect(await tokenService.verify('')).toBeNull();
    expect(await tokenService.verify('bearer_something')).toBeNull();
    expect(await tokenService.verify('muster_pat_onlyoneprefix')).toBeNull();
    expect(await tokenService.verify('muster_wrongbrand_aaaa_bbbb')).toBeNull();
  });

  // ============================================================
  // Acceptance 2: revoked token is refused
  // ============================================================

  it('should refuse a revoked token on the very next request', async () => {
    const created = await tokenService.create({
      principal_id: principalId,
      workspace_id: workspaceId,
      name: 'Revocable',
    });

    // Verify it works before revoking
    expect(await tokenService.verify(created.token)).not.toBeNull();

    // Revoke
    await tokenService.revoke(created.id);

    // Verify it's now refused
    const verification = await tokenService.verify(created.token);
    expect(verification).toBeNull();

    // Token record should show revoked_at
    const record = await tokenService.getById(created.id);
    expect(record).not.toBeNull();
    expect(record!.revoked_at).not.toBeNull();
  });

  // ============================================================
  // Acceptance 3: expired token is refused
  // ============================================================

  it('should refuse an expired token', async () => {
    const past = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
    const created = await tokenService.create({
      principal_id: principalId,
      workspace_id: workspaceId,
      name: 'Expired',
      expires_at: past,
    });

    const verification = await tokenService.verify(created.token);
    expect(verification).toBeNull();
  });

  it('should accept a token that has not yet expired', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString(); // 1 day from now
    const created = await tokenService.create({
      principal_id: principalId,
      workspace_id: workspaceId,
      name: 'Not expired',
      expires_at: future,
    });

    const verification = await tokenService.verify(created.token);
    expect(verification).not.toBeNull();
  });

  // ============================================================
  // Acceptance 4: plaintext secret is never stored
  // ============================================================

  it('should never store the plaintext token in the database', async () => {
    const created = await tokenService.create({
      principal_id: principalId,
      workspace_id: workspaceId,
      name: 'Secret Check',
    });

    // Query the raw row
    const rows = await db.query<any>('SELECT token_hash, prefix FROM api_token WHERE id = ?', [created.id]);
    expect(rows.length).toBe(1);

    const stored = rows[0];
    // Stored value is a SHA-256 hex digest (64 chars), not the token
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.token_hash).not.toBe(created.token);
    expect(stored.token_hash).toBe(hashToken(created.token));

    // The token includes the prefix, and the prefix is stored separately
    expect(created.token).toContain(stored.prefix);
  });

  // ============================================================
  // Acceptance 5: throttled last_used_at
  // ============================================================

  it('should throttle last_used_at updates to at most once per 60 seconds', async () => {
    const created = await tokenService.create({
      principal_id: principalId,
      workspace_id: workspaceId,
      name: 'Throttle Test',
    });

    // First verification sets last_used_at
    await tokenService.verify(created.token);
    let record = await tokenService.getById(created.id);
    const firstUsed = record!.last_used_at;
    expect(firstUsed).not.toBeNull();

    // Rapid second verification — should NOT update last_used_at
    await tokenService.verify(created.token);
    record = await tokenService.getById(created.id);
    expect(record!.last_used_at).toBe(firstUsed);

    // A third verify, same result
    await tokenService.verify(created.token);
    record = await tokenService.getById(created.id);
    expect(record!.last_used_at).toBe(firstUsed);
  });

  // ============================================================
  // Token listing
  // ============================================================

  it('should list only tokens for the specified principal', async () => {
    const otherPrincipalId = 'test-principal-other-01';
    const now = new Date().toISOString();
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [otherPrincipalId, 'user', now]);

    await tokenService.create({ principal_id: principalId, workspace_id: workspaceId, name: 'Token A' });
    await tokenService.create({ principal_id: principalId, workspace_id: workspaceId, name: 'Token B' });
    await tokenService.create({ principal_id: otherPrincipalId, workspace_id: workspaceId, name: 'Other Token' });

    const userTokens = await tokenService.list(principalId);
    expect(userTokens.length).toBe(2);
    expect(userTokens.every(t => t.principal_id === principalId)).toBe(true);

    const otherTokens = await tokenService.list(otherPrincipalId);
    expect(otherTokens.length).toBe(1);
    expect(otherTokens[0].name).toBe('Other Token');

    // Tokens never expose token_hash in list output
    for (const t of userTokens) {
      expect((t as any).token_hash).toBeUndefined();
    }
  });

  // ============================================================
  // Token list does not expose hashes
  // ============================================================

  it('should not expose token_hash in the ApiToken type', async () => {
    const created = await tokenService.create({
      principal_id: principalId,
      workspace_id: workspaceId,
      name: 'No hash leak',
    });
    // The ApiToken type does not carry token_hash
    expect((created as any).token_hash).toBeUndefined();
    // The CreatedApiToken carries token (plaintext once)
    expect(created.token).toBeDefined();

    // The stored record view also omits hash
    const listed = await tokenService.list(principalId);
    for (const t of listed) {
      expect((t as any).token_hash).toBeUndefined();
    }
  });

  // ============================================================
  // Acceptance 5: a token minted for an agent cannot exceed the
  // agent's effective (operator-intersected) permissions
  // ============================================================

  it('should refuse an action a token-authenticated agent lacks under the effective (intersected) permission set', async () => {
    const now = new Date().toISOString();

    // Operator holds only the observer role (kb.read only)
    const observerRole = await roleService.getByKey(workspaceId, 'observer');
    await db.execute(
      'INSERT INTO workspace_member (workspace_id, user_id, role_id, joined_at) VALUES (?, ?, ?, ?)',
      [workspaceId, userId, observerRole!.id, now],
    );

    // Agent holds senior_engineer (broad permissions, including card.create)
    const seniorRole = await roleService.getByKey(workspaceId, 'senior_engineer');
    const agentPrincipalId = 'test-agent-under-observer-op';
    await db.execute('INSERT INTO principal (id, kind, created_at) VALUES (?, ?, ?)', [agentPrincipalId, 'agent', now]);
    await db.execute(
      'INSERT INTO agent (id, name, status, last_seen_at, role_id, operator_user_id, workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [agentPrincipalId, 'Constrained Agent', 'active', now, seniorRole!.id, userId, workspaceId, now],
    );

    // Mint a token for the agent
    const agentToken = await tokenService.create({
      principal_id: agentPrincipalId,
      workspace_id: workspaceId,
      name: 'Agent Token',
    });

    // Verify the token resolves the agent principal
    const verification = await tokenService.verify(agentToken.token);
    expect(verification!.principal_id).toBe(agentPrincipalId);

    // Effective permissions = senior_engineer ∩ observer = only kb.read survives
    const effectivePerms = await roleService.getEffectivePermissions(agentPrincipalId);
    expect(effectivePerms).toEqual(['kb.read']);

    const auth: AuthContext = {
      principal: { kind: 'agent', id: agentPrincipalId },
      workspace_id: workspaceId,
      is_workspace_member: true,
      permissions: effectivePerms,
      is_operator_override: false,
      role_name: seniorRole!.name,
    };

    const priorMode = config.auth.mode;
    (config.auth as any).mode = 'enforced';
    try {
      // card.create is in the agent's nominal role, but not in the intersection
      expect(() => requirePermission('create_card', auth)).toThrow(PermissionDeniedError);
      // kb.read survives the intersection and is allowed
      expect(() => requirePermission('search_knowledge', auth)).not.toThrow();
    } finally {
      (config.auth as any).mode = priorMode;
    }
  });
});
