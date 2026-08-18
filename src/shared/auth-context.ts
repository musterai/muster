// File: src/shared/auth-context.ts
//
// AuthContext is resolved once per request in middleware and threaded through
// both the REST and MCP entry points. Under MUSTER_AUTH_MODE=open it is a
// permissive stub so local development stays zero-config.
//
// Permissions is an empty stub here — the shape is what matters. Full
// permission enforcement lands in MUS-21/MUS-22.

export type PrincipalKind = 'user' | 'agent';

export interface PrincipalRef {
  kind: PrincipalKind;
  id: string;
}

export interface AuthContext {
  /** Resolved principal — null when unauthenticated in open mode. */
  principal: PrincipalRef | null;
  /** The workspace this request acts within, if known. */
  workspace_id: string | null;
  /**
   * Whether the credential resolves to an active member of workspace_id.
   * Read access is implicit for members, including observer roles with an
   * intentionally empty write-permission set, so it cannot be inferred from
   * permissions.length.
   */
  is_workspace_member: boolean;
  /** Permission strings the principal holds (effective set). */
  permissions: string[];
  /** True when the request carries operator-override authority. */
  is_operator_override: boolean;
  /** Human-friendly role name for refusal payloads — null when unknown. */
  role_name: string | null;
}

/**
 * Default AuthContext used under MUSTER_AUTH_MODE=open.
 * Everything is permitted — no principal, no restrictions.
 */
export const OPEN_AUTH_CONTEXT: AuthContext = {
  principal: null,
  workspace_id: null,
  is_workspace_member: false,
  permissions: [],
  is_operator_override: false,
  role_name: null,
};
