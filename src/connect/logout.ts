import { createCredentialStore, type CredentialStore } from './credentials.js';
import { RemoteError, revokeToken, type RevokeResult } from './remote-client.js';

export type LogoutStatus =
  | 'logged_out'
  | 'already_revoked'
  | 'local_only'
  | 'not_logged_in'
  | 'untracked_remote_token'
  | 'network_failure'
  | 'server_refusal';

export interface LogoutResult {
  status: LogoutStatus;
  message: string;
}

export interface LogoutOptions {
  localOnly?: boolean;
  store?: CredentialStore;
  revoke?: (server: string, token: string, tokenId: string) => Promise<RevokeResult>;
}

/**
 * Revoke first and delete second. Any unconfirmed remote outcome deliberately
 * leaves the recovery credential in place for retry or explicit local-only
 * removal.
 */
export async function logoutCredential(server: string, options: LogoutOptions = {}): Promise<LogoutResult> {
  const store = options.store ?? createCredentialStore();
  const credential = store.getCredential(server);
  if (!credential) return { status: 'not_logged_in', message: `No saved credentials for ${server}.` };

  if (options.localOnly) {
    store.removeCredential(server);
    return {
      status: 'local_only',
      message: `Removed only the local credential for ${server}; remote revocation was not confirmed.`,
    };
  }

  if (!credential.token_id) {
    return {
      status: 'untracked_remote_token',
      message: `Cannot identify the remote token for ${server}; local credentials were retained. Retry login/logout, or use --local-only to remove only the local copy.`,
    };
  }

  try {
    const outcome = await (options.revoke ?? revokeToken)(server, credential.token, credential.token_id);
    store.removeCredential(server);
    return outcome === 'already_revoked'
      ? { status: 'already_revoked', message: `Remote access was already revoked; removed the local credential for ${server}.` }
      : { status: 'logged_out', message: `Logged out of ${server}.` };
  } catch (error) {
    if (error instanceof RemoteError) {
      return {
        status: error.status === undefined ? 'network_failure' : 'server_refusal',
        message: error.message,
      };
    }
    throw error;
  }
}
