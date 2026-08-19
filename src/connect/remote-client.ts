// File: src/connect/remote-client.ts
//
// Small fetch wrapper for the handful of calls `muster login`/`logout` make
// directly against the remote server — validating a pasted token, finding
// its own token_id (by prefix) for clean revocation, and revoking it.

export interface RemoteMe {
  authenticated: boolean;
  admitted: boolean;
  user: { id: string; display_name: string } | null;
}

export interface RemoteTokenSummary {
  id: string;
  prefix: string;
  name: string;
  revoked_at: string | null;
}

export class RemoteError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

async function get(server: string, path: string, token: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${server}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err: any) {
    throw new RemoteError(`Cannot reach ${server}: ${err.message}`);
  }
  if (!res.ok) throw new RemoteError(`${server}${path} returned ${res.status}`);
  return res.json();
}

export async function whoAmI(server: string, token: string): Promise<RemoteMe> {
  return get(server, '/api/v1/auth/me', token);
}

export async function listMyTokens(server: string, token: string): Promise<RemoteTokenSummary[]> {
  return get(server, '/api/v1/tokens', token);
}

/** The token's own prefix segment — `muster_pat_<prefix>_<secret>` — used to find its record without ever transmitting the secret again. */
export function tokenPrefix(token: string): string | null {
  const parts = token.split('_');
  // muster_pat_<prefix>_<secret> — parts: ['muster','pat',prefix,secret]
  if (parts.length !== 4 || parts[0] !== 'muster' || parts[1] !== 'pat') return null;
  return parts[2];
}

export type RevokeResult = 'revoked' | 'already_revoked';

export async function revokeToken(server: string, token: string, tokenId: string): Promise<RevokeResult> {
  let response: Response;
  try {
    response = await fetch(`${server}/api/v1/tokens/${tokenId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error: any) {
    throw new RemoteError(`Cannot confirm remote token revocation at ${server}: ${error.message}`);
  }

  if (response.ok) return 'revoked';
  if (response.status === 404 || response.status === 410) return 'already_revoked';
  throw new RemoteError(`Remote token revocation was refused by ${server} (${response.status}); local credentials were retained.`, response.status);
}

// ─── Device Authorization Grant (RFC 8628, MUS-28) ─────────────────────────

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export async function requestDeviceCode(server: string): Promise<DeviceCodeResponse> {
  let res: Response;
  try {
    res = await fetch(`${server}/api/v1/oauth/device/code`, { method: 'POST' });
  } catch (err: any) {
    throw new RemoteError(`Cannot reach ${server}: ${err.message}`);
  }
  if (!res.ok) throw new RemoteError(`${server} refused to start a device login (${res.status})`);
  return res.json();
}

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls until the user approves, denies, or the code expires — honouring
 * the server's interval and slow_down exactly as RFC 8628 requires, never
 * looping on a terminal error.
 */
export async function pollForDeviceToken(server: string, deviceCode: string, intervalSeconds: number, expiresInSeconds: number): Promise<string> {
  const deadline = Date.now() + expiresInSeconds * 1000;
  let interval = intervalSeconds;

  while (Date.now() < deadline) {
    await sleep(interval * 1000);

    let res: Response;
    try {
      res = await fetch(`${server}/api/v1/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: DEVICE_GRANT_TYPE, device_code: deviceCode }),
      });
    } catch (err: any) {
      throw new RemoteError(`Cannot reach ${server}: ${err.message}`);
    }

    const body = await res.json().catch(() => ({}));

    if (res.ok) {
      return body.access_token;
    }

    switch (body.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        interval += 5;
        continue;
      case 'access_denied':
        throw new RemoteError('Login was denied.');
      case 'expired_token':
        throw new RemoteError('The login code expired before it was approved. Run "muster login" again.');
      default:
        throw new RemoteError(`Unexpected response from ${server}: ${body.error || res.status}`);
    }
  }

  throw new RemoteError('The login code expired before it was approved. Run "muster login" again.');
}
