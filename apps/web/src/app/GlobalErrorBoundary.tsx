import { Component, type ReactNode } from 'react';
import { ErrorFallback } from './ErrorFallback';

interface State {
  failed: boolean;
}

/**
 * Last line of defence for render errors outside the router (route errors use the router's
 * errorElement). Errors are not logged here: F-12 adds reporting with PHI scrubbing.
 */
export class GlobalErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? <ErrorFallback /> : this.props.children;
  }
}
