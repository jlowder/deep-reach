"use client";

// Last line of defense: a render error (malformed upstream data slipping past
// the normalizers, a component bug) should land on a quiet console-voice
// panel, not Next's default page error. Reload is the recovery.

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error !== null) {
      return (
        <div className="flex min-h-dvh items-center justify-center bg-field">
          <div className="max-w-sm border border-err-hairline bg-surface p-8 text-center">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-err">
              Console error
            </p>
            <p className="mt-4 font-body text-sm text-dim">
              Something broke while loading. Reload to recover.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-6 border border-accent bg-accent-soft px-6 py-2 font-mono text-[11px] uppercase tracking-[0.16em] text-field transition-colors hover:bg-accent"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
