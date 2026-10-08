import { Activity } from 'lucide-react';
import { useHealth } from '@/shared/api/health';
import { Button } from '@/shared/ui/button';

/** Placeholder landing screen until the app shell (F-01) and login (A-01) exist. */
export function HomePage() {
  const health = useHealth();
  const status = health.isPending
    ? 'checking'
    : health.isError
      ? 'unreachable'
      : health.data.status;

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 px-4">
      <div className="space-y-2">
        <p className="text-sm font-medium text-primary">Mediflow</p>
        <h1 className="text-3xl font-semibold tracking-tight">Hospital management system</h1>
        <p className="text-muted-foreground">
          Project scaffold is running. Next: the foundation milestone (app shell, session, tenancy
          and access).
        </p>
      </div>
      <div className="flex items-center gap-3 rounded-lg border p-4">
        <Activity aria-hidden className="size-5 text-primary" />
        <span className="text-sm">
          API status: <strong data-testid="api-status">{status}</strong>
        </span>
        <Button className="ml-auto" size="sm" variant="outline" onClick={() => health.refetch()}>
          Recheck
        </Button>
      </div>
    </main>
  );
}
