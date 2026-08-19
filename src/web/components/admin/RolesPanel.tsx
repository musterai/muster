import React, { useState } from 'react';
import { User, Role, Agent } from '../../types.js';
import { api, ApiError } from '../../api.js';
import { ALL_PERMISSIONS, Permission } from '../../../shared/permissions.js';
import { Plus, X, Copy, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { AccessibleDialog } from '../AccessibleDialog.js';

function groupPermissions(perms: readonly Permission[]): [string, Permission[]][] {
  const groups = new Map<string, Permission[]>();
  for (const p of perms) {
    const group = p.split('.')[0];
    const list = groups.get(group) || [];
    list.push(p);
    groups.set(group, list);
  }
  return Array.from(groups.entries());
}

const NewRoleModal: React.FC<{
  workspaceId: string;
  onClose: () => void;
  onSuccess: () => void;
  onError: (msg: string) => void;
}> = ({ workspaceId, onClose, onSuccess, onError }) => {
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [permissions, setPermissions] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  const togglePerm = (p: string) => {
    setPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!key.trim() || !name.trim()) return;
    setSubmitting(true);
    try {
      await api.createRole(workspaceId, { key: key.trim(), name: name.trim(), permissions: Array.from(permissions) });
      onSuccess();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Failed to create role');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AccessibleDialog onClose={onClose} titleId="new-role-title" className="w-full max-w-lg p-6 space-y-4">
        <div className="flex items-center justify-between border-b border-muster-border pb-3">
          <h2 id="new-role-title" className="text-base font-bold muster-text-primary uppercase tracking-wide">New Role</h2>
          <button onClick={onClose} className="muster-btn muster-btn-icon muster-btn-ghost" aria-label="Close new role dialog">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="new-role-key" className="muster-label uppercase">Key</label>
              <input id="new-role-key" data-dialog-initial-focus required value={key} onChange={(e) => setKey(e.target.value)} placeholder="e.g. sre" className="muster-input font-mono" />
            </div>
            <div>
              <label htmlFor="new-role-name" className="muster-label uppercase">Name</label>
              <input id="new-role-name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. SRE" className="muster-input" />
            </div>
          </div>
          <div>
            <label className="muster-label uppercase">Permissions</label>
            <div className="max-h-64 overflow-y-auto space-y-2 mt-1 border border-muster-border rounded-md p-3">
              {groupPermissions(ALL_PERMISSIONS).map(([group, perms]) => (
                <div key={group}>
                  <div className="text-[10px] font-semibold uppercase muster-text-muted mb-1">{group}</div>
                  <div className="grid grid-cols-2 gap-1">
                    {perms.map((p) => (
                      <label key={p} className="flex items-center gap-1.5 text-[11px] font-mono muster-text-secondary cursor-pointer">
                        <input type="checkbox" checked={permissions.has(p)} onChange={() => togglePerm(p)} />
                        {p}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-neutral-500 mt-1">You can only grant permissions your own role already holds.</p>
          </div>
          <div className="flex justify-end space-x-3 pt-3 border-t border-muster-border">
            <button type="button" onClick={onClose} className="muster-btn muster-btn-lg muster-btn-secondary">
              Cancel
            </button>
            <button type="submit" disabled={submitting} className="muster-btn muster-btn-lg muster-btn-primary">
              {submitting ? 'Creating…' : 'Create Role'}
            </button>
          </div>
        </form>
    </AccessibleDialog>
  );
};

interface RolesPanelProps {
  workspaceId: string;
  roles: Role[];
  users: User[];
  agents: Agent[];
  onChange: () => void;
  onError: (msg: string) => void;
}

export const RolesPanel: React.FC<RolesPanelProps> = ({ workspaceId, roles, users, agents, onChange, onError }) => {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(groupPermissions(ALL_PERMISSIONS).map(([g]) => g)));
  const [showNewRole, setShowNewRole] = useState(false);

  const holderCounts = (roleId: string) => ({
    members: users.filter((u) => u.role_id === roleId).length,
    agents: agents.filter((a) => a.role_id === roleId).length,
  });

  const toggleGroup = (group: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const handleTogglePermission = async (role: Role, permission: string, checked: boolean) => {
    if (role.is_system) return;
    const nextPermissions = checked
      ? [...role.permissions, permission]
      : role.permissions.filter((p) => p !== permission);
    try {
      await api.updateRole(role.id, { permissions: nextPermissions });
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Failed to update role');
    }
  };

  const handleClone = async (role: Role) => {
    const newKey = prompt(`Key for the cloned role (lowercase, no spaces):`, `${role.key}_custom`);
    if (!newKey) return;
    try {
      await api.cloneRole(role.id, newKey, `${role.name} (custom)`);
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Failed to clone role');
    }
  };

  const handleDelete = async (role: Role) => {
    const counts = holderCounts(role.id);
    if (counts.members + counts.agents > 0) {
      alert(`Cannot delete "${role.name}" — it is held by ${counts.members} member(s) and ${counts.agents} agent(s). Reassign them first.`);
      return;
    }
    if (!confirm(`Delete role "${role.name}"? This cannot be undone.`)) return;
    try {
      await api.deleteRole(role.id);
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Failed to delete role');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={() => setShowNewRole(true)} className="muster-btn muster-btn-primary">
          <Plus className="w-3.5 h-3.5 mr-1.5" /> New Role
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="text-xs font-sans border-collapse min-w-full">
          <thead>
            <tr className="border-b border-muster-border muster-text-muted uppercase text-[10px] tracking-wide">
              <th className="text-left py-2 pr-4 font-semibold sticky left-0 bg-muster-base">Permission</th>
              {roles.map((r) => {
                const counts = holderCounts(r.id);
                return (
                  <th key={r.id} className="text-center py-2 px-2 font-semibold whitespace-nowrap">
                    <div className="flex flex-col items-center gap-1">
                      <span className="muster-text-primary normal-case font-bold">{r.name}</span>
                      {r.is_system ? (
                        <span className="muster-badge muster-badge-neutral text-[9px]">system</span>
                      ) : (
                        <span className="muster-badge muster-badge-info text-[9px]">custom</span>
                      )}
                      <span className="text-[9px] font-normal normal-case">
                        {counts.members}m · {counts.agents}a
                      </span>
                      <div className="flex gap-1">
                        <button onClick={() => handleClone(r)} className="muster-btn muster-btn-icon muster-btn-ghost" title={`Clone ${r.name}`}>
                          <Copy className="w-3 h-3" />
                        </button>
                        {!r.is_system && (
                          <button onClick={() => handleDelete(r)} className="muster-btn muster-btn-icon muster-btn-ghost-danger" title={`Delete ${r.name}`}>
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {groupPermissions(ALL_PERMISSIONS).map(([group, perms]) => (
              <React.Fragment key={group}>
                <tr className="border-b border-muster-border/60 bg-muster-surface/60">
                  <td colSpan={roles.length + 1} className="py-1.5 pr-4 sticky left-0">
                    <button
                      onClick={() => toggleGroup(group)}
                      className="flex items-center gap-1 muster-text-secondary font-semibold uppercase text-[10px] tracking-wide"
                    >
                      {expanded.has(group) ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                      {group}
                    </button>
                  </td>
                </tr>
                {expanded.has(group) &&
                  perms.map((perm) => (
                    <tr key={perm} className="border-b border-muster-border/40">
                      <td className="py-1.5 pr-4 font-mono muster-text-muted sticky left-0 bg-muster-base whitespace-nowrap">{perm}</td>
                      {roles.map((r) => (
                        <td key={r.id} className="text-center py-1.5 px-2">
                          <input
                            type="checkbox"
                            checked={r.permissions.includes(perm)}
                            disabled={!!r.is_system}
                            onChange={(e) => handleTogglePermission(r, perm, e.target.checked)}
                            className="cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                            aria-label={`${perm} for ${r.name}`}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {showNewRole && (
        <NewRoleModal
          workspaceId={workspaceId}
          onClose={() => setShowNewRole(false)}
          onSuccess={() => {
            setShowNewRole(false);
            onChange();
          }}
          onError={onError}
        />
      )}
    </div>
  );
};
