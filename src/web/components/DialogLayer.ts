import { createContext } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface DialogLayerToken {
  readonly order: number;
  readonly opener: HTMLElement | null;
  readonly cancelOnShortcutToggle: boolean;
  active: boolean;
  onCancel: () => void;
  surface: HTMLElement | null;
  surfaceInert: boolean;
  surfaceAriaHidden: string | null;
}

export interface LazyDialogLayerHandoff {
  token: DialogLayerToken;
}

export const LazyDialogLayerContext = createContext<LazyDialogLayerHandoff | null>(null);

const dialogStack: DialogLayerToken[] = [];
let nextDialogOrder = 0;
let originalBodyOverflow: string | null = null;
let originalRootInert = false;
let originalRootAriaHidden: string | null = null;
let listeningForKeys = false;

function isFocusable(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  return element.getClientRects().length > 0
    && style.visibility !== 'hidden'
    && style.display !== 'none'
    && !element.closest('[inert], [aria-hidden="true"]');
}

function focusLayer(token: DialogLayerToken): void {
  const surface = token.surface;
  if (!surface || dialogStack.at(-1) !== token) return;
  const candidates = Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isFocusable);
  const initial = surface.querySelector<HTMLElement>('[data-dialog-initial-focus]')
    || candidates[0]
    || surface.querySelector<HTMLElement>('[role="dialog"]')
    || surface;
  initial.focus();
}

function syncDialogIsolation(focusTop = false): void {
  const appRoot = document.getElementById('root');
  const top = dialogStack.at(-1);

  if (top) {
    document.body.style.overflow = 'hidden';
    if (appRoot) {
      appRoot.inert = true;
      appRoot.setAttribute('aria-hidden', 'true');
    }
    for (const layer of dialogStack) {
      const surface = layer.surface;
      if (!surface) continue;
      const isTop = layer === top;
      surface.inert = isTop ? layer.surfaceInert : true;
      if (!isTop) surface.setAttribute('aria-hidden', 'true');
      else if (layer.surfaceAriaHidden === null) surface.removeAttribute('aria-hidden');
      else surface.setAttribute('aria-hidden', layer.surfaceAriaHidden);
    }
    if (focusTop) focusLayer(top);
    return;
  }

  if (originalBodyOverflow !== null) document.body.style.overflow = originalBodyOverflow;
  if (appRoot) {
    appRoot.inert = originalRootInert;
    if (originalRootAriaHidden === null) appRoot.removeAttribute('aria-hidden');
    else appRoot.setAttribute('aria-hidden', originalRootAriaHidden);
  }
  originalBodyOverflow = null;
  originalRootInert = false;
  originalRootAriaHidden = null;
}

function handleDialogKeyDown(event: KeyboardEvent): void {
  const top = dialogStack.at(-1);
  const surface = top?.surface;
  if (!top || !surface) return;

  if (top.cancelOnShortcutToggle && (event.key === '?' || (event.shiftKey && event.key === '/'))) {
    event.preventDefault();
    event.stopPropagation();
    top.onCancel();
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    top.onCancel();
    return;
  }
  if (event.key !== 'Tab') return;

  const candidates = Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isFocusable);
  if (candidates.length === 0) {
    event.preventDefault();
    (surface.querySelector<HTMLElement>('[role="dialog"]') || surface).focus();
    return;
  }
  const first = candidates[0];
  const last = candidates[candidates.length - 1];
  if (!surface.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function syncKeyListener(): void {
  if (dialogStack.length > 0 && !listeningForKeys) {
    document.addEventListener('keydown', handleDialogKeyDown, true);
    listeningForKeys = true;
  } else if (dialogStack.length === 0 && listeningForKeys) {
    document.removeEventListener('keydown', handleDialogKeyDown, true);
    listeningForKeys = false;
  }
}

export function createDialogLayerToken(
  opener: HTMLElement | null,
  onCancel: () => void,
  cancelOnShortcutToggle = false,
): DialogLayerToken {
  return {
    order: nextDialogOrder++,
    opener,
    cancelOnShortcutToggle,
    active: false,
    onCancel,
    surface: null,
    surfaceInert: false,
    surfaceAriaHidden: null,
  };
}

export function activateDialogLayer(token: DialogLayerToken): void {
  if (token.active) return;
  if (dialogStack.length === 0) {
    const appRoot = document.getElementById('root');
    originalBodyOverflow = document.body.style.overflow;
    originalRootInert = appRoot?.inert ?? false;
    originalRootAriaHidden = appRoot?.getAttribute('aria-hidden') ?? null;
  }
  token.active = true;
  dialogStack.push(token);
  dialogStack.sort((left, right) => left.order - right.order);
  syncKeyListener();
  syncDialogIsolation(true);
}

export function updateDialogLayerCancel(token: DialogLayerToken, onCancel: () => void): void {
  token.onCancel = onCancel;
}

export function attachDialogLayerSurface(token: DialogLayerToken, surface: HTMLElement): void {
  if (token.surface === surface) return;
  token.surface = surface;
  token.surfaceInert = surface.inert;
  token.surfaceAriaHidden = surface.getAttribute('aria-hidden');
  syncDialogIsolation(dialogStack.at(-1) === token);
}

export function detachDialogLayerSurface(token: DialogLayerToken, surface: HTMLElement): void {
  if (token.surface !== surface) return;
  surface.inert = token.surfaceInert;
  if (token.surfaceAriaHidden === null) surface.removeAttribute('aria-hidden');
  else surface.setAttribute('aria-hidden', token.surfaceAriaHidden);
  token.surface = null;
}

export function deactivateDialogLayer(token: DialogLayerToken): void {
  if (!token.active) return;
  const wasTop = dialogStack.at(-1) === token;
  const index = dialogStack.indexOf(token);
  if (index >= 0) dialogStack.splice(index, 1);
  token.active = false;
  syncKeyListener();
  syncDialogIsolation(wasTop);

  if (!wasTop) return;
  const nextTop = dialogStack.at(-1);
  const opener = token.opener;
  const restoreFocus = () => {
    if (dialogStack.at(-1) !== nextTop) return;
    if (opener?.isConnected && (!nextTop || nextTop.surface?.contains(opener))) {
      opener.focus();
    } else if (nextTop) {
      focusLayer(nextTop);
    }
  };
  restoreFocus();
  // React removes a suspended portal in the same commit that cleans up its
  // boundary. Some browsers reset focus to body when that focused portal node
  // disappears after the parent layout cleanup, so repeat the guarded restore
  // once the commit's synchronous DOM work has finished.
  queueMicrotask(restoreFocus);
}

export function isTopDialogLayer(token: DialogLayerToken): boolean {
  return dialogStack.at(-1) === token;
}
