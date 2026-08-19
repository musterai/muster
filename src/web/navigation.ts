export type AppTab = 'board' | 'agents' | 'docs' | 'activity' | 'kb' | 'tokens' | 'admin';

export interface AppLocation {
  projectSlug: string | null;
  tab: AppTab;
  boardSlug: string | null;
  docId: string | null;
  entityId: string | null;
}

const VALID_TABS: readonly AppTab[] = ['board', 'agents', 'docs', 'activity', 'kb', 'tokens', 'admin'];

export function parseAppLocation(pathname: string): AppLocation {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'projects' && parts[1]) {
    const projectSlug = parts[1];
    const rawTab = parts[2];
    const tab = VALID_TABS.includes(rawTab as AppTab) ? rawTab as AppTab : 'board';
    return {
      projectSlug,
      tab,
      boardSlug: tab === 'board' && parts[3] ? parts[3] : null,
      docId: tab === 'docs' && parts[3] ? parts[3] : null,
      entityId: tab === 'kb' && parts[3] ? parts[3] : null,
    };
  }
  return { projectSlug: null, tab: 'board', boardSlug: null, docId: null, entityId: null };
}

export function buildAppPath(
  projectSlug: string,
  tab: AppTab,
  options: { docId?: string | null; entityId?: string | null; boardSlug?: string | null } = {},
): string {
  let targetPath = `/projects/${projectSlug}/${tab}`;
  if (tab === 'board' && options.boardSlug) targetPath += `/${options.boardSlug}`;
  else if (tab === 'docs' && options.docId) targetPath += `/${options.docId}`;
  else if (tab === 'kb' && options.entityId) targetPath += `/${options.entityId}`;
  return targetPath;
}

export function readBrowserLocation(): AppLocation {
  return parseAppLocation(window.location.pathname);
}

export function updateBrowserLocation(
  projectSlug: string | null,
  tab: AppTab,
  options: { docId?: string | null; entityId?: string | null; boardSlug?: string | null; replace?: boolean } = {},
): void {
  if (!projectSlug) return;
  const targetPath = buildAppPath(projectSlug, tab, options);
  if (window.location.pathname === targetPath) return;
  const operation = options.replace ? 'replaceState' : 'pushState';
  window.history[operation](null, '', targetPath);
}
