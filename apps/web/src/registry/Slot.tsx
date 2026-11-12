import { Component, Fragment, Suspense, type ReactNode } from 'react';
import { reportError } from '@/app/observability';
import { useSlotContributions } from './registry-context';
import type { ResolvedContribution } from './registry';
import type { SlotId, SlotProps } from './types';

/**
 * Keeps one broken contribution from taking down the screen that hosts it: it renders nothing in
 * its place. The error goes to the scrubbing reporter and is never shown or logged.
 */
class ContributionBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    reportError(error);
  }

  override render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}

interface SlotComponentProps extends SlotProps {
  id: SlotId;
  /** Shown while a contribution's chunk loads. Nothing by default. */
  fallback?: ReactNode;
  /** Shown in place of a contribution that failed. Nothing by default. */
  errorFallback?: ReactNode;
  /** Wraps each contribution (boundary included), for a host that lays them out itself. */
  frame?: (contribution: ResolvedContribution, node: ReactNode) => ReactNode;
}

/**
 * An extension point on a core screen. Renders what enabled features contribute to it, filtered
 * by feature flag and permission, each in its own chunk:
 *
 *   <Slot id="patient.detail.tabs" context={{ patientId }} />
 *
 * The slot adds no markup of its own, so the host decides the layout.
 */
export function Slot({ id, context, fallback = null, errorFallback, frame }: SlotComponentProps) {
  const contributions = useSlotContributions(id);
  return contributions.map((contribution) => {
    const { key, Component: Contribution } = contribution;
    const node = (
      <ContributionBoundary key={key} fallback={errorFallback}>
        <Suspense fallback={fallback}>
          <Contribution context={context} />
        </Suspense>
      </ContributionBoundary>
    );
    return frame ? <Fragment key={key}>{frame(contribution, node)}</Fragment> : node;
  });
}
