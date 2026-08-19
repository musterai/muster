import React, { Component, Suspense, useEffect, useRef } from 'react';

interface LazyBoundaryProps {
  label: string;
  resetKey: string;
  variant?: 'view' | 'dialog';
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
      const alert = (
        <div
          role="alert"
          tabIndex={-1}
          autoFocus={this.props.variant === 'dialog'}
          className={`${this.props.variant === 'dialog' ? 'muster-dialog' : 'muster-panel m-auto'} max-w-lg p-6 text-center space-y-3`}
        >
          <h1 className="text-base font-bold muster-text-primary">{this.props.label} could not be loaded</h1>
          <p className="text-sm muster-text-secondary">
            The application may have been updated or the connection may have been interrupted.
          </p>
          <button
            type="button"
            className="muster-btn muster-btn-primary"
            onClick={() => window.location.reload()}
          >
            Reload {this.props.label}
          </button>
        </div>
      );
      return this.props.variant === 'dialog' ? <div className="muster-scrim">{alert}</div> : alert;
    }

    return this.props.children;
  }
}

export const LazyBoundary: React.FC<LazyBoundaryProps> = ({ label, resetKey, variant = 'view', children }) => (
  <LazyLoadErrorBoundary label={label} resetKey={resetKey} variant={variant}>
    <Suspense
      fallback={variant === 'dialog' ? (
        <div className="muster-scrim">
          <div
            role="status"
            tabIndex={-1}
            autoFocus
            aria-live="polite"
            aria-busy="true"
            className="muster-dialog max-w-lg p-6 text-center text-sm muster-text-secondary"
          >
            Loading {label}…
          </div>
        </div>
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
);

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
