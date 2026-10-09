import { Component, type ReactNode } from 'react';
import { ErrorFallback } from './ErrorFallback';
import { reportError } from './observability';

interface State {
  failed: boolean;
}

/**
 * Last line of defence for render errors outside the router (route errors use the router's
 * errorElement). The error is reported through the scrubbing reporter and never shown or logged.
 */
export class GlobalErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    reportError(error);
  }

  override render() {
    return this.state.failed ? <ErrorFallback /> : this.props.children;
  }
}
