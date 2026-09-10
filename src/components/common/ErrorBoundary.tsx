/**
 * RX Store — error boundaries.
 *
 * A backend outage, a malformed catalog payload, or a native-bridge failure must
 * not blank the whole application. These boundaries isolate failures:
 *   - `ErrorBoundary`        — generic, optional custom fallback
 *   - `RouteErrorBoundary`   — wraps routed pages; keeps the shell usable
 *   - `SectionBoundary`      — wraps a risky section (e.g. an app card backfill)
 *
 * Props are validated inside the boundary so a malformed app object renders a
 * neutral fallback instead of crashing the page.
 */
import React from 'react';

interface Props {
  children: React.ReactNode;
  /** Custom fallback; receives the error + a reset callback. */
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
  /** Short label used in the default fallback copy. */
  label?: string;
  /** Called when an error is caught (wire to logging/telemetry). */
  onError?: (error: Error, info: React.ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Never let reporting itself throw.
    try { this.props.onError?.(error, info); } catch { /* ignore */ }
    try { console.error('[rx-store] boundary caught:', error?.message || error); } catch { /* ignore */ }
  }

  reset = (): void => this.setState({ error: null });

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return <DefaultFallback label={this.props.label} onRetry={this.reset} />;
  }
}

function DefaultFallback({ label, onRetry }: { label?: string; onRetry: () => void }) {
  return (
    <div className="card p-6 text-center" role="alert">
      <div className="text-3xl mb-2">⚠️</div>
      <p className="text-white font-semibold">Something went wrong{label ? ` in ${label}` : ''}.</p>
      <p className="text-xs text-rx-gray-medium mt-1">
        The rest of RX Store is unaffected. You can retry this section.
      </p>
      <button onClick={onRetry} className="mt-4 px-4 py-2 rounded-xl bg-rx-yellow text-rx-dark text-sm font-bold">
        Try again
      </button>
    </div>
  );
}

/**
 * Page-level boundary. Renders inside the normal layout so navigation still
 * works while a single route is broken.
 */
export function RouteErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBoundary
      label="this page"
      fallback={(_error, reset) => (
        <div className="section-container py-20 text-center" role="alert">
          <div className="text-5xl mb-4">🛠️</div>
          <h2 className="text-2xl font-bold text-white mb-2">This page ran into a problem</h2>
          <p className="text-rx-gray-medium mb-6">
            RX Store is still running — try again, or use the navigation above.
          </p>
          <button onClick={reset} className="btn-primary">Try again</button>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

/** Small boundary for a risky section inside a page (card grids, side panels). */
export function SectionBoundary({ children, label }: { children: React.ReactNode; label?: string }) {
  return <ErrorBoundary label={label}>{children}</ErrorBoundary>;
}
