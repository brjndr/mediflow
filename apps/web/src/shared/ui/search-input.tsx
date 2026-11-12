import { Search } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/shared/lib/utils';

type SearchInputProps = Omit<ComponentProps<'input'>, 'type'>;

/**
 * The search field: an inset field with a magnifier, `type="search"` and no autocomplete, as the
 * list screens' own search boxes are. Name it with a wrapping `<label>`, `htmlFor` or `aria-label`.
 * Text is 16 px on a phone so the browser does not zoom on focus, and 44 px high for a finger.
 */
export function SearchInput({ className, ...props }: SearchInputProps) {
  return (
    <span className="relative block">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <input
        type="search"
        autoComplete="off"
        className={cn(
          'h-9 w-full rounded-md border bg-background pl-9 pr-3 text-base shadow-inset outline-none md:text-sm pointer-coarse:h-11',
          'placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
          className,
        )}
        {...props}
      />
    </span>
  );
}
