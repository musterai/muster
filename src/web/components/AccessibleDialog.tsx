import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface DialogLayer {
  id: symbol;
  scrim: HTMLElement;
  inert: boolean;
  ariaHidden: string | null;
}

const dialogStack: DialogLayer[] = [];
let originalBodyOverflow: string | null = null;
let originalRootInert = false;
let originalRootAriaHidden: string | null = null;

function syncDialogIsolation(): void {
  const appRoot = document.getElementById('root');
  const top = dialogStack.at(-1);

  if (top) {
    document.body.style.overflow = 'hidden';
    if (appRoot) {
      appRoot.inert = true;
      appRoot.setAttribute('aria-hidden', 'true');
    }
    for (const layer of dialogStack) {
      const isTop = layer === top;
      layer.scrim.inert = isTop ? layer.inert : true;
      if (!isTop) layer.scrim.setAttribute('aria-hidden', 'true');
      else if (layer.ariaHidden === null) layer.scrim.removeAttribute('aria-hidden');
      else layer.scrim.setAttribute('aria-hidden', layer.ariaHidden);
    }
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

function isFocusable(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  return element.getClientRects().length > 0
    && style.visibility !== 'hidden'
    && style.display !== 'none'
    && !element.closest('[inert], [aria-hidden="true"]');
}

interface AccessibleDialogProps {
  children: React.ReactNode;
  onClose: () => void;
  titleId: string;
  descriptionId?: string;
  className?: string;
  closeOnBackdrop?: boolean;
}

/**
 * Shared modal/sheet boundary. Rendering in a portal lets the application root
 * become inert without hiding the dialog itself from assistive technology.
 */
export const AccessibleDialog: React.FC<AccessibleDialogProps> = ({
  children,
  onClose,
  titleId,
  descriptionId,
  className = '',
  closeOnBackdrop = true,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const instanceRef = useRef(Symbol('accessible-dialog'));
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const instance = instanceRef.current;
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const appRoot = document.getElementById('root');
    const scrim = scrimRef.current;
    if (!scrim) return;
    if (dialogStack.length === 0) {
      originalBodyOverflow = document.body.style.overflow;
      originalRootInert = appRoot?.inert ?? false;
      originalRootAriaHidden = appRoot?.getAttribute('aria-hidden') ?? null;
    }
    const layer: DialogLayer = {
      id: instance,
      scrim,
      inert: scrim.inert,
      ariaHidden: scrim.getAttribute('aria-hidden'),
    };
    dialogStack.push(layer);
    syncDialogIsolation();

    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isFocusable);
    const initial = dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]') || focusable[0] || dialog;
    initial.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (dialogStack.at(-1)?.id !== instance) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const candidates = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter(isFocusable);
      if (candidates.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = candidates[0];
      const last = candidates[candidates.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      const stackIndex = dialogStack.findIndex((entry) => entry.id === instance);
      const wasTop = dialogStack.at(-1)?.id === instance;
      if (stackIndex >= 0) dialogStack.splice(stackIndex, 1);
      document.removeEventListener('keydown', handleKeyDown, true);
      syncDialogIsolation();
      const returnTarget = returnFocusRef.current;
      if (wasTop && returnTarget?.isConnected) returnTarget.focus();
    };
  }, []);

  return createPortal(
    <div
      ref={scrimRef}
      className="muster-scrim"
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className={`muster-dialog ${className}`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
};
