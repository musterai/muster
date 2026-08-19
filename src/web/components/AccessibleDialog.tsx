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

const dialogStack: symbol[] = [];

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
    dialogStack.push(instance);

    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const appRoot = document.getElementById('root');
    const underlyingOverlays = Array.from(document.body.children)
      .filter((element): element is HTMLElement =>
        element instanceof HTMLElement
        && element.classList.contains('muster-scrim')
        && element !== scrimRef.current)
      .map((element) => ({
        element,
        inert: element.inert,
        ariaHidden: element.getAttribute('aria-hidden'),
      }));
    const previousOverflow = document.body.style.overflow;
    const rootWasInert = appRoot?.inert ?? false;
    const rootAriaHidden = appRoot?.getAttribute('aria-hidden');

    document.body.style.overflow = 'hidden';
    if (appRoot) {
      appRoot.inert = true;
      appRoot.setAttribute('aria-hidden', 'true');
    }
    for (const overlay of underlyingOverlays) {
      overlay.element.inert = true;
      overlay.element.setAttribute('aria-hidden', 'true');
    }

    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    const initial = dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]') || focusable[0] || dialog;
    initial.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (dialogStack.at(-1) !== instance) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const candidates = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
      if (candidates.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = candidates[0];
      const last = candidates[candidates.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      const stackIndex = dialogStack.lastIndexOf(instance);
      if (stackIndex >= 0) dialogStack.splice(stackIndex, 1);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (appRoot) {
        appRoot.inert = rootWasInert;
        if (rootAriaHidden == null) appRoot.removeAttribute('aria-hidden');
        else appRoot.setAttribute('aria-hidden', rootAriaHidden);
      }
      for (const overlay of underlyingOverlays) {
        if (!overlay.element.isConnected) continue;
        overlay.element.inert = overlay.inert;
        if (overlay.ariaHidden === null) overlay.element.removeAttribute('aria-hidden');
        else overlay.element.setAttribute('aria-hidden', overlay.ariaHidden);
      }
      const returnTarget = returnFocusRef.current;
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, []);

  return createPortal(
    <div
      ref={scrimRef}
      className="muster-scrim"
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose();
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
