import React, { useEffect, useState } from 'react';
import { Agent, Card, User, Role } from '../types.js';
import { Bot, Clock, RefreshCw, UserPlus, Trash2, ShieldCheck, Edit3, Pencil, X, Save } from 'lucide-react';
import { api } from '../api.js';
import { effectivePermissions } from '../../shared/permissions.js';
import { PrincipalChip } from './PrincipalChip.js';
import { AccessibleDialog } from './AccessibleDialog.js';

function getOperatorName(users: User[], operatorUserId?: string | null): string | null {
  if (!operatorUserId) return null;
  const op = users.find(u => u.id === operatorUserId);
  return op ? op.display_name : null;
}

/** Agents grouped under their operator — the relationship the permission
 * intersection (design doc §4) is computed from, so a flat roster would hide it. */
function groupByOperator(agents: Agent[], users: User[]): { operator: User | null; agents: Agent[] }[] {
  const byOperator = new Map<string, Agent[]>();
  const unassigned: Agent[] = [];

  for (const agent of agents) {
    if (!agent.operator_user_id) {
      unassigned.push(agent);
      continue;
    }
    const bucket = byOperator.get(agent.operator_user_id) || [];
    bucket.push(agent);
    byOperator.set(agent.operator_user_id, bucket);
  }

  const groups = Array.from(byOperator.entries())
    .map(([operatorId, groupAgents]) => ({
      operator: users.find(u => u.id === operatorId) || null,
      agents: groupAgents,
    }))
    .sort((a, b) => (a.operator?.display_name || '').localeCompare(b.operator?.display_name || ''));

  if (unassigned.length > 0) {
    groups.push({ operator: null, agents: unassigned });
  }

  return groups;
}

interface AgentGridProps {
  agents: Agent[];
  users: User[];
  cards: Card[];
  workspaceId: string | null;
  onHeartbeat: (agentId: string) => void;
  onUnregisterAgent: (agentId: string) => void;
  onOpenRegisterAgent: () => void;
  onRefresh?: () => void;
}

export const AgentGrid: React.FC<AgentGridProps> = ({
  agents,
  users,
  cards,
  workspaceId,
  onHeartbeat,
  onUnregisterAgent,
  onOpenRegisterAgent,
  onRefresh,
}) => {
  const [roles, setRoles] = useState<Role[]>([]);

  useEffect(() => {
    if (!workspaceId) return;
    api.getRoles(workspaceId).then(setRoles).catch((err) => console.error('Failed to load roles:', err));
  }, [workspaceId]);

  const roleById = new Map(roles.map(r => [r.id, r]));

  /** effective = agent.role ∩ operator.role — design doc §4, "an agent can never exceed its operator". */
  function effectiveFor(agent: Agent): { nominal: string[]; effective: string[]; reducedBy: string | null } {
    const agentRole = agent.role_id ? roleById.get(agent.role_id) : undefined;
    const nominal = agentRole?.permissions || [];
    if (!agent.operator_user_id) return { nominal, effective: nominal, reducedBy: null };

    const operator = users.find(u => u.id === agent.operator_user_id);
    const operatorRole = operator ? roleById.get(operator.role_id) : undefined;
    if (!operatorRole) return { nominal, effective: nominal, reducedBy: null };

    const effective = effectivePermissions(nominal, operatorRole.permissions);
    return { nominal, effective, reducedBy: effective.length < nominal.length ? operator!.display_name : null };
  }

  // Edit Modal State
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [editName, setEditName] = useState('');
  const [editOperatorId, setEditOperatorId] = useState<string>('');
  const [editCapabilities, setEditCapabilities] = useState('');
  const [editStatus, setEditStatus] = useState<'active' | 'idle' | 'offline'>('active');
  const [isSaving, setIsSaving] = useState(false);

  const handleOpenEdit = (agent: Agent) => {
    setEditingAgent(agent);
    setEditName(agent.name);
    setEditOperatorId(agent.operator_user_id || '');
    setEditCapabilities(agent.capabilities ? agent.capabilities.join(', ') : '');
    setEditStatus(agent.status);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingAgent) return;

    setIsSaving(true);
    try {
      await api.updateAgent(editingAgent.id, {
        name: editName,
        operator_user_id: editOperatorId || null,
        capabilities: editCapabilities,
        status: editStatus,
      });
      setEditingAgent(null);
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error('Failed to update agent:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const getStatusBadge = (status: Agent['status']) => {
    switch (status) {
      case 'active':
        return (
          <span className="muster-badge muster-badge-success">
            <span className="w-2 h-2 rounded-full bg-success-400 mr-1.5 animate-ping"></span>
            Active
          </span>
        );
      case 'idle':
        return (
          <span className="muster-badge muster-badge-warning">
            <span className="w-2 h-2 rounded-full bg-warning-400 mr-1.5"></span>
            Idle
          </span>
        );
      case 'offline':
      default:
        return (
          <span className="muster-badge muster-badge-neutral">
            <span className="w-2 h-2 rounded-full bg-neutral-600 mr-1.5"></span>
            Offline
          </span>
        );
    }
  };

  const formatLastSeen = (isoDate: string) => {
    const diffMs = Date.now() - new Date(isoDate).getTime();
    const secs = Math.floor(diffMs / 1000);
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
  };

  return (
    <div className="flex flex-col flex-1 h-full min-h-0 font-sans space-y-6">

      {/* Agents Header */}
      <div className="flex-none flex items-center justify-between border-b border-muster-border pb-4">
        <div>
          <h2 className="text-lg font-sans font-bold muster-text-primary flex items-center">
            <Bot className="w-5 h-5 mr-2 muster-accent" />
            Registered Agents
          </h2>
          <p className="text-xs font-sans muster-text-muted mt-0.5">
            AI agents registered on the platform
          </p>
        </div>
        <button
          onClick={onOpenRegisterAgent}
          className="muster-btn muster-btn-primary"
        >
          <UserPlus className="w-3.5 h-3.5 mr-1.5" /> Register Agent
        </button>
      </div>

      {/* Grid of Agents */}
      {agents.length === 0 ? (
        <div className="text-center py-16 bg-muster-surface rounded-lg tactical-border">
          <Bot className="w-12 h-12 muster-text-faint mx-auto mb-3" />
          <h3 className="text-sm font-sans muster-text-secondary font-semibold">No Agents Registered</h3>
          <p className="text-xs font-sans text-neutral-500 max-w-sm mx-auto mt-1 mb-4">
            Connect AI agents via MCP.
          </p>
          <button
            onClick={onOpenRegisterAgent}
            className="muster-btn muster-btn-lg muster-btn-primary"
          >
            Register Agent
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto min-h-0 pr-1 space-y-6">
          {groupByOperator(agents, users).map((group) => (
            <div key={group.operator?.id || 'unassigned'}>
              <div className="flex items-center space-x-2 mb-3">
                {group.operator ? (
                  <PrincipalChip name={group.operator.display_name} kind="user" />
                ) : (
                  <span className="muster-chip max-w-full text-neutral-500 italic">Unassigned</span>
                )}
                <span className="text-[11px] font-sans muster-text-muted">
                  {group.agents.length} agent{group.agents.length === 1 ? '' : 's'}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 auto-rows-max">
                {group.agents.map((agent) => (
                  <div
                    key={agent.id}
                    className="bg-muster-surface rounded-lg p-5 tactical-border hover:border-brand-500/40 transition-all group relative overflow-hidden flex flex-col justify-between"
                  >
                    <div>
                      {/* Top Row */}
                      <div className="flex items-start justify-between">
                        <div className="flex items-center space-x-3">
                          <div className="w-10 h-10 rounded-lg bg-neutral-900 border border-neutral-700 flex items-center justify-center muster-accent group-hover:border-brand-500/50 transition-colors">
                            <Bot className="w-5 h-5" />
                          </div>
                          <div>
                            <h3 className="text-sm font-sans font-bold muster-text-primary group-hover:text-brand-300 transition-colors">
                              {agent.name}
                            </h3>
                            <div className="flex items-center space-x-2 mt-0.5 flex-wrap">
                              <span className="text-[11px] font-sans muster-text-muted capitalize">Agent</span>
                              {agent.operator_user_id && (
                                <>
                                  <span className="muster-divider w-1 h-1 rounded-full shrink-0" aria-hidden="true" />
                                  <span className="inline-flex items-center text-[10px] font-mono font-medium muster-text-warning">
                                    <ShieldCheck className="w-3 h-3 mr-0.5" /> Op by {getOperatorName(users, agent.operator_user_id) || 'Unknown'}
                                  </span>
                                </>
                              )}
                          </div>
                        </div>
                      </div>

                      {getStatusBadge(agent.status)}

                      </div>

                      {/* Capabilities */}
                      <div className="mt-4 pt-3 border-t border-muster-border/60">
                        <div className="text-[11px] font-sans muster-text-muted mb-1.5 font-medium">Capabilities:</div>
                        <div className="flex flex-wrap gap-1.5">
                          {agent.capabilities && agent.capabilities.length > 0 ? (
                            agent.capabilities.map((muster, idx) => (
                              <span key={idx} className="px-2 py-0.5 bg-neutral-900 muster-text-secondary text-xs font-sans rounded border border-neutral-800">
                                {muster}
                              </span>
                            ))
                          ) : (
                            <span className="text-xs font-sans text-neutral-500 italic">General</span>
                          )}
                        </div>
                      </div>

                      {/* Effective permissions — the operator intersection, design doc §4 */}
                      {agent.role_id && (() => {
                        const { nominal, effective, reducedBy } = effectiveFor(agent);
                        return (
                          <div className="mt-3 pt-3 border-t border-muster-border/60">
                            <div className="text-[11px] font-sans muster-text-muted mb-1 font-medium flex items-center justify-between">
                              <span>Effective permissions:</span>
                              <span
                                className={reducedBy ? 'muster-text-warning font-semibold' : 'muster-text-secondary'}
                                title={effective.join(', ') || 'none'}
                              >
                                {effective.length}/{nominal.length}
                              </span>
                            </div>
                            {reducedBy && (
                              <p className="text-[10px] muster-text-warning">
                                Reduced by operator {reducedBy}'s role — the agent's nominal role grants more than {reducedBy} holds.
                              </p>
                            )}
                          </div>
                        );
                      })()}
                    </div>

                    {/* Bottom Row */}
                    <div className="mt-4 pt-3 border-t border-muster-border/60 flex items-center justify-between text-xs font-sans muster-text-muted">
                      <div className="flex items-center muster-text-muted">
                        <Clock className="w-3.5 h-3.5 mr-1 text-neutral-500" />
                        <span>Last seen: {formatLastSeen(agent.last_seen_at)}</span>
                      </div>

                      <div className="flex items-center space-x-1.5">
                        <button
                          onClick={() => handleOpenEdit(agent)}
                          title="Edit Agent Attributes"
                          className="muster-btn muster-btn-secondary font-sans"
                        >
                          <Pencil className="w-3 h-3 mr-1" /> Edit
                        </button>

                        <button
                          onClick={() => onHeartbeat(agent.id)}
                          title="Send Heartbeat"
                          className="muster-btn muster-btn-secondary font-sans"
                        >
                          <RefreshCw className="w-3 h-3 mr-1" /> Ping
                        </button>

                        <button
                          onClick={() => {
                            if (confirm(`Are you sure you want to remove agent "${agent.name}"?`)) {
                              onUnregisterAgent(agent.id);
                            }
                          }}
                          title="Remove / Unregister Agent"
                          className="muster-btn muster-btn-icon muster-btn-ghost-danger"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Edit Agent Modal */}
      {editingAgent && (
        <AccessibleDialog onClose={() => setEditingAgent(null)} titleId="edit-agent-title" className="w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-muster-border pb-3">
              <div className="flex items-center space-x-2">
                <Edit3 className="w-5 h-5 muster-text-warning" />
                <h2 id="edit-agent-title" className="text-base font-bold muster-text-primary uppercase tracking-wide">Edit Agent Attributes</h2>
              </div>
              <button
                onClick={() => setEditingAgent(null)}
                className="muster-btn muster-btn-icon muster-btn-ghost"
                aria-label="Close edit agent dialog"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="space-y-4">
              <div>
                <label htmlFor="edit-agent-name" className="muster-label uppercase">Agent Name</label>
                <input
                  id="edit-agent-name"
                  data-dialog-initial-focus
                  type="text"
                  required
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="muster-input muster-input-lg"
                  placeholder="e.g. Claude 3.7 Sonnet"
                />
              </div>

              <div>
                <label htmlFor="edit-agent-operator" className="muster-label uppercase">Operator</label>
                <select
                  id="edit-agent-operator"
                  value={editOperatorId}
                  onChange={(e) => setEditOperatorId(e.target.value)}
                  className="muster-input font-mono cursor-pointer"
                >
                  <option value="">Unassigned</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>{u.display_name}</option>
                  ))}
                </select>
                <p className="text-[11px] text-neutral-500 mt-1">The human operator who owns this agent.</p>
              </div>

              <div>
                <label htmlFor="edit-agent-status" className="muster-label uppercase">Status</label>
                <select
                  id="edit-agent-status"
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value as any)}
                  className="muster-input font-mono cursor-pointer"
                >
                  <option value="active">Active</option>
                  <option value="idle">Idle</option>
                  <option value="offline">Offline</option>
                </select>
              </div>

              <div>
                <label htmlFor="edit-agent-capabilities" className="muster-label uppercase">Capabilities (Comma Separated)</label>
                <input
                  id="edit-agent-capabilities"
                  type="text"
                  value={editCapabilities}
                  onChange={(e) => setEditCapabilities(e.target.value)}
                  className="muster-input font-mono"
                  placeholder="code, testing, architecture, review"
                />
              </div>

              <div className="flex justify-end space-x-3 pt-3 border-t border-muster-border">
                <button
                  type="button"
                  onClick={() => setEditingAgent(null)}
                  className="muster-btn muster-btn-lg muster-btn-secondary"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="muster-btn muster-btn-lg muster-btn-primary"
                >
                  <Save className="w-3.5 h-3.5 mr-1.5" />
                  {isSaving ? 'Saving...' : 'Save Agent Attributes'}
                </button>
              </div>
            </form>
        </AccessibleDialog>
      )}

    </div>
  );
};
