// File: src/web/components/McpConsent.tsx
//
// MCP-native OAuth consent screen (MUS-29). Reachable at /mcp/authorize,
// outside the normal /projects/:id app shell — GET /api/v1/oauth/authorize
// redirects here once it has validated the client and redirect_uri.
//
// The crux of this screen: it asks which AGENT identity and role the
// connecting MCP client should act as — never the signed-in human's own
// session. See design doc §4 and §7.3.

import React, { useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';
import { AuthMe, McpAuthorizeDetails } from '../types.js';
import { ShieldAlert, Bot, Loader2 } from 'lucide-react';
import { consentRequestParams } from '../mcp-oauth-view.js';

function currentQueryString(): string {
  return window.location.search.replace(/^\?/, '');
}

export const McpConsent: React.FC = () => {
  const [me, setMe] = useState<AuthMe | null>(null);
  const [details, setDetails] = useState<McpAuthorizeDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [agentChoice, setAgentChoice] = useState<'new' | string>('new');
  const [newAgentName, setNewAgentName] = useState('');
  const [roleId, setRoleId] = useState('');

  useEffect(() => {
    api.getMe()
      .then(setMe)
      .catch(() => setMe({ authenticated: false, admitted: false, user: null, role: null, workspace: null, auth_mode: 'enforced' }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!me?.authenticated) return;
    api.mcpAuthorizeDetails(new URLSearchParams(window.location.search).get('client_id') || '')
      .then((d) => {
        setDetails(d);
        if (d.roles.length > 0) setRoleId(d.roles[0].id);
      })
      .catch((err) => setError(err instanceof ApiError ? 'This request is invalid or has expired.' : 'Failed to load the request.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.authenticated]);

  const handleDecision = async (decision: 'approve' | 'deny') => {
    setSubmitting(true);
    setError(null);
    try {
      const payload: Record<string, string> = {
        ...consentRequestParams(window.location.search),
        decision,
        role_id: roleId,
      };
      if (decision === 'approve') {
        if (agentChoice === 'new') {
          if (newAgentName.trim()) payload.new_agent_name = newAgentName.trim();
        } else {
          payload.agent_id = agentChoice;
        }
      }
      const result = await api.mcpAuthorizeConsent(payload);
      window.location.href = result.redirect_uri;
    } catch {
      setError('Failed to complete the request. Try again from the MCP client.');
      setSubmitting(false);
    }
  };

  const signInUrl = `/api/v1/auth/login?redirect_to=${encodeURIComponent(`/mcp/authorize?${currentQueryString()}`)}`;

  return (
    <div className="min-h-screen flex items-center justify-center bg-muster-base muster-text-primary font-sans px-4">
      <div className="muster-dialog w-full max-w-md p-6 space-y-5">
        <div className="flex items-center space-x-2 border-b border-muster-border pb-4">
          <Bot className="w-6 h-6 muster-accent" />
          <h1 className="text-base font-bold uppercase tracking-wide">Connect MCP Client</h1>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8 muster-text-muted text-sm">
            <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Loading…
          </div>
        ) : !me?.authenticated ? (
          <div className="space-y-4">
            <p className="text-xs muster-text-muted">Sign in to approve this connection.</p>
            <a href={signInUrl} className="muster-btn muster-btn-lg muster-btn-primary w-full justify-center">
              Sign in
            </a>
          </div>
        ) : !details ? (
          error ? null : (
            <div className="flex items-center justify-center py-8 muster-text-muted text-sm">
              <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Loading request…
            </div>
          )
        ) : (
          <div className="space-y-4">
            <div className="p-3 bg-muster-base border border-muster-border rounded-md text-xs space-y-1.5">
              <p className="muster-text-muted">
                <span className="font-semibold muster-text-primary">{details.client_name}</span> wants to connect directly
                to this workspace over MCP.
              </p>
              <p className="muster-text-warning">
                It will act as an <span className="font-semibold">agent you operate</span>, not as you — its permissions
                are capped by both the agent's role and your own.
              </p>
            </div>

            <div>
              <label className="muster-label uppercase">Agent Identity</label>
              <select
                value={agentChoice}
                onChange={(e) => setAgentChoice(e.target.value)}
                className="muster-input font-mono cursor-pointer"
              >
                <option value="new">Register a new agent…</option>
                {details.agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>

            {agentChoice === 'new' && (
              <div>
                <label className="muster-label uppercase">New Agent Name</label>
                <input
                  type="text"
                  value={newAgentName}
                  onChange={(e) => setNewAgentName(e.target.value)}
                  placeholder={details.client_name}
                  className="muster-input"
                />
              </div>
            )}

            <div>
              <label className="muster-label uppercase">Role</label>
              <select
                value={roleId}
                onChange={(e) => setRoleId(e.target.value)}
                className="muster-input font-mono cursor-pointer"
              >
                {details.roles.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </div>

            <div className="flex space-x-3">
              <button
                onClick={() => handleDecision('deny')}
                disabled={submitting}
                className="muster-btn muster-btn-lg muster-btn-secondary flex-1 justify-center"
              >
                Deny
              </button>
              <button
                onClick={() => handleDecision('approve')}
                disabled={submitting || !roleId}
                className="muster-btn muster-btn-lg muster-btn-primary flex-1 justify-center"
              >
                Approve
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="muster-badge muster-badge-danger w-full">
            <ShieldAlert className="w-3.5 h-3.5" /> {error}
          </div>
        )}
      </div>
    </div>
  );
};
