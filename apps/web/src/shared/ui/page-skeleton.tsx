import { Skeleton } from './skeleton';

interface PageSkeletonProps {
  /** Announced to screen readers, e.g. "Loading notices…". */
  label: string;
  /** How many content rows to sketch. */
  rows?: number;
}

/** The loading state of a screen: a title bar and a few rows where the content will appear. */
export function PageSkeleton({ label, rows = 4 }: PageSkeletonProps) {
  return (
    <div role="status" className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-72 max-w-full" />
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-20 w-full" />
      ))}
    </div>
  );
}
