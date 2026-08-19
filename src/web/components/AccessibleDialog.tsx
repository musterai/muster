import React, { useContext, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  LazyDialogLayerContext,
  activateDialogLayer,
  attachDialogLayerSurface,
  createDialogLayerToken,
  deactivateDialogLayer,
  detachDialogLayerSurface,
  isTopDialogLayer,
  updateDialogLayerCancel,
  type DialogLayerToken,
} from './DialogLayer.js';

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
  const scrimRef = useRef<HTMLDivElement>(null);
  const localTokenRef = useRef<DialogLayerToken | null>(null);
  const lazyHandoff = useContext(LazyDialogLayerContext);

  if (localTokenRef.current === null) {
    const opener = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    localTokenRef.current = createDialogLayerToken(opener, onClose);
  }
  const token = lazyHandoff?.token ?? localTokenRef.current;
  updateDialogLayerCancel(token, onClose);

  useLayoutEffect(() => {
    const scrim = scrimRef.current;
    if (!scrim) return;
    if (!lazyHandoff) activateDialogLayer(token);
    attachDialogLayerSurface(token, scrim);
    return () => {
      detachDialogLayerSurface(token, scrim);
      if (!lazyHandoff) deactivateDialogLayer(token);
    };
  }, [lazyHandoff, token]);

  return createPortal(
    <LazyDialogLayerContext.Provider value={null}>
      <div
        ref={scrimRef}
        className="muster-scrim"
        onMouseDown={(event) => {
          if (
            closeOnBackdrop
            && event.target === event.currentTarget
            && isTopDialogLayer(token)
          ) onClose();
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          tabIndex={-1}
          className={`muster-dialog ${className}`}
        >
          {children}
        </div>
      </div>
    </LazyDialogLayerContext.Provider>,
    document.body,
  );
};
