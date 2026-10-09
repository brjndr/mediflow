import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/utils';

interface SystemPageProps {
  title: string;
  description: string;
  /** Links or buttons that let the user move on. */
  actions?: ReactNode;
  /** Fill the viewport when the page replaces the whole app instead of sitting in the shell. */
  fullScreen?: boolean;
  /** Announce the page as an alert (errors), not just as content. */
  alert?: boolean;
}

/** Shared layout of the not-found, no-access, error and suspended pages. */
export function SystemPage({ title, description, actions, fullScreen, alert }: SystemPageProps) {
  const Wrapper = fullScreen ? 'main' : 'div';
  return (
    <Wrapper
      role={alert ? 'alert' : undefined}
      className={cn(
        'mx-auto flex w-full max-w-md flex-1 flex-col items-start justify-center gap-3 px-4 py-10',
        fullScreen && 'min-h-dvh',
      )}
    >
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-muted-foreground">{description}</p>
      {actions && <div className="mt-2 flex flex-wrap items-center gap-3">{actions}</div>}
    </Wrapper>
  );
}
