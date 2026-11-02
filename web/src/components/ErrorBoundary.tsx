import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render/lifecycle errors in one page of the app.
 *
 * Without a boundary, a single thrown render error unmounts the whole React tree
 * and the window goes blank — including the nav, so the user cannot even leave
 * the broken page. The shell (header, connection badge, theme toggle) lives
 * outside this component, and `App` keys the boundary by pathname, so navigating
 * anywhere else resets it automatically.
 *
 * Error boundaries must be class components: there is no hook equivalent
 * (`getDerivedStateFromError` / `componentDidCatch` are the contract).
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // React already logs in development; one line keeps production triage
    // possible without a logging dependency.
    console.error("ReadFlow render error:", error, info.componentStack);
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <div
        aria-labelledby="error-boundary-title"
        className="mx-auto w-full max-w-2xl px-4 py-16"
        role="alert"
      >
        <h1
          className="text-lg font-semibold text-[var(--ink-primary)]"
          id="error-boundary-title"
        >
          This page hit an unexpected error
        </h1>
        <p className="mt-2 text-sm text-[var(--ink-secondary)]">
          The rest of the app still works — use the header to open another page,
          or try again.
        </p>
        <pre className="mt-4 overflow-x-auto rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3 text-xs text-[var(--rose)]">
          {error.message}
        </pre>
        <div className="mt-5 flex gap-2">
          <button
            className="rounded-lg bg-[var(--amber)] px-4 py-2 text-sm font-semibold text-[var(--canvas)] transition hover:brightness-110"
            onClick={this.reset}
            type="button"
          >
            Try again
          </button>
          <button
            className="rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-semibold text-[var(--ink-secondary)] transition hover:text-[var(--ink-primary)]"
            onClick={() => window.location.reload()}
            type="button"
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
