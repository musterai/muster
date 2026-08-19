import React, { Component, Suspense, useContext, useEffect, useLayoutEffect, useRef } from 'react';
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

interface LazyBoundaryProps {
  label: string;
  resetKey: string;
  variant?: 'view' | 'dialog';
  onCancel?: () => void;
  cancelOnShortcutToggle?: boolean;
  children: React.ReactNode;
}

interface LazyBoundaryState {
  failed: boolean;
}

class LazyLoadErrorBoundary extends Component<LazyBoundaryProps, LazyBoundaryState> {
  state: LazyBoundaryState = { failed: false };

  static getDerivedStateFromError(): LazyBoundaryState {
    return { failed: true };
  }

  componentDidUpdate(previousProps: LazyBoundaryProps) {
    if (this.state.failed && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (this.state.failed) {
      if (this.props.variant === 'dialog') {
        return <LazyDialogSurface label={this.props.label} failed />;
      }
      return (
        <div role="alert" tabIndex={-1} className="muster-panel m-auto max-w-lg p-6 text-center space-y-3">
          <LazyLoadFailure label={this.props.label} />
        </div>
      );
    }

    return this.props.children;
  }
}

const LazyLoadFailure: React.FC<{ label: string }> = ({ label }) => (
  <>
    <h1 className="text-base font-bold muster-text-primary">{label} could not be loaded</h1>
    <p className="text-sm muster-text-secondary">
      The application may have been updated or the connection may have been interrupted.
    </p>
    <button
      type="button"
      className="muster-btn muster-btn-primary"
      onClick={() => window.location.reload()}
    >
      Reload {label}
    </button>
  </>
);

const LazyDialogSurface: React.FC<{ label: string; failed?: boolean }> = ({ label, failed = false }) => {
  const handoff = useContext(LazyDialogLayerContext);
  const scrimRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const scrim = scrimRef.current;
    if (!handoff || !scrim) return;
    attachDialogLayerSurface(handoff.token, scrim);
    return () => detachDialogLayerSurface(handoff.token, scrim);
  }, [handoff]);

  if (!handoff) return null;
  return createPortal(
    <div
      ref={scrimRef}
      className="muster-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && isTopDialogLayer(handoff.token)) {
          handoff.token.onCancel();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={failed ? 'Lazy dialog load error' : 'Loading lazy dialog'}
        tabIndex={-1}
        className="muster-dialog max-w-lg p-6 text-center space-y-3"
      >
        {failed ? (
          <div role="alert">
            <LazyLoadFailure label={label} />
          </div>
        ) : (
          <div role="status" aria-live="polite" aria-busy="true" className="text-sm muster-text-secondary">
            Loading {label}…
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};

export const LazyBoundary: React.FC<LazyBoundaryProps> = ({
  label,
  resetKey,
  variant = 'view',
  onCancel,
  cancelOnShortcutToggle = false,
  children,
}) => {
  const dialogTokenRef = useRef<DialogLayerToken | null>(null);
  const dialogHandoffRef = useRef<{ token: DialogLayerToken } | null>(null);
  if (variant === 'dialog' && dialogTokenRef.current === null) {
    const opener = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dialogTokenRef.current = createDialogLayerToken(
      opener,
      onCancel ?? (() => undefined),
      cancelOnShortcutToggle,
    );
    dialogHandoffRef.current = { token: dialogTokenRef.current };
  }
  const dialogToken = dialogTokenRef.current;
  if (dialogToken && onCancel) updateDialogLayerCancel(dialogToken, onCancel);

  useLayoutEffect(() => {
    if (variant !== 'dialog' || !dialogToken) return;
    activateDialogLayer(dialogToken);
    return () => deactivateDialogLayer(dialogToken);
  }, [dialogToken, variant]);

  return (
    <LazyDialogLayerContext.Provider value={variant === 'dialog' ? dialogHandoffRef.current : null}>
      <LazyLoadErrorBoundary label={label} resetKey={resetKey} variant={variant} onCancel={onCancel}>
        <Suspense
          fallback={variant === 'dialog' ? (
            <LazyDialogSurface label={label} />
          ) : (
            <div
              role="status"
              aria-live="polite"
              aria-busy="true"
              className="muster-panel m-auto max-w-lg p-6 text-center text-sm muster-text-secondary"
            >
              Loading {label}…
            </div>
          )}
        >
          {children}
        </Suspense>
      </LazyLoadErrorBoundary>
    </LazyDialogLayerContext.Provider>
  );
};

interface LazyViewRegionProps {
  label: string;
  focusVersion: number;
  children: React.ReactNode;
}

/**
 * Suspense commits this region only after its lazy child has resolved. Moving
 * focus here therefore announces the newly rendered view without racing the
 * fallback or reaching into a view component's private heading structure.
 */
export const LazyViewRegion: React.FC<LazyViewRegionProps> = ({ label, focusVersion, children }) => {
  const regionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (focusVersion > 0) {
      regionRef.current?.focus();
    }
  }, [focusVersion]);

  return (
    <section
      ref={regionRef}
      tabIndex={-1}
      aria-label={`${label} view`}
      data-lazy-view={label.toLowerCase().replace(/\s+/g, '-')}
      className="flex-1 flex flex-col min-h-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400"
    >
      {children}
    </section>
  );
};
