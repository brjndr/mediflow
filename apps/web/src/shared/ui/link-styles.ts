import { cn } from '@/shared/lib/utils';
import { buttonVariants } from './button';

/**
 * Classes for a router `Link` that does a job a button would (#1119), so an action is never
 * plain underlined text. Pick by what the link is, not how it should look:
 *
 * - `actionLink`: the screen's main action that opens another screen ("Register a patient").
 * - `secondaryLink`: any other action or a way back ("Back to doctors", "Discount limit").
 * - `subNavLink`: one tab of a screen group's own links; the current one (`aria-current`) is
 *   filled with the brand gradient, and also bold, so it is never colour alone.
 * - `textLink`: a record's name in a table cell or a list item. Not inside a sentence: it is
 *   `inline-flex` and 44 px tall under a touch pointer; a link in running text keeps its
 *   underline and takes `text-primary-ink`.
 */
export const actionLink = cn(buttonVariants(), 'w-fit');

export const secondaryLink = cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'w-fit');

export const subNavLink =
  'inline-flex min-h-8 items-center rounded-full border border-primary/25 bg-card px-3 text-sm font-medium text-primary-ink shadow-tinted outline-none transition-[background-color,border-color] hover:border-primary/60 hover:bg-primary-soft focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-[current=page]:border-transparent aria-[current=page]:bg-brand-gradient aria-[current=page]:font-semibold aria-[current=page]:text-primary-foreground pointer-coarse:min-h-11';

export const textLink =
  'inline-flex items-center rounded-sm font-medium text-primary-ink underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';
