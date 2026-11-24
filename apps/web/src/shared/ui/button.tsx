import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, MouseEvent } from 'react';
import { cn } from '@/shared/lib/utils';

// A hovered button lifts by 1 px; a 1 px strip under it while hovered keeps the pointer inside, so a
// pointer on its bottom edge does not unhover, drop it back and hover again in a loop (#1123).
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold transition-[color,background-color,border-color,box-shadow,transform,filter] duration-150 disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 relative hover:after:absolute hover:after:inset-x-0 hover:after:top-full hover:after:h-px",
  {
    /**
     * Every variant has a visible background and depth (#1119): the main action is the brand
     * gradient with a coloured shadow and a highlight along the top; `outline` (the everyday
     * action) is a brand tint with a coloured border and `--primary-ink` text; `destructive` is a
     * red gradient. A press settles the button back down.
     */
    variants: {
      variant: {
        default:
          'bg-brand-gradient text-primary-foreground shadow-button hover:-translate-y-px hover:shadow-button-hover hover:brightness-105 active:translate-y-0 active:shadow-button',
        destructive:
          'bg-danger-gradient text-destructive-foreground shadow-[0_1px_2px_color-mix(in_oklab,var(--destructive)_35%,transparent),0_4px_12px_-3px_color-mix(in_oklab,var(--destructive)_50%,transparent),inset_0_1px_0_color-mix(in_oklab,white_25%,transparent)] hover:-translate-y-px hover:brightness-105 active:translate-y-0',
        outline:
          'border border-primary/35 bg-primary-soft text-primary-ink shadow-tinted hover:-translate-y-px hover:border-primary/60 hover:bg-[color-mix(in_oklab,var(--primary)_20%,var(--background))] active:translate-y-0',
        secondary:
          'border border-primary/20 bg-secondary text-secondary-foreground shadow-tinted hover:-translate-y-px hover:bg-[color-mix(in_oklab,var(--primary)_20%,var(--background))] active:translate-y-0',
        brand:
          'bg-brand-gradient text-primary-foreground shadow-button hover:-translate-y-px hover:shadow-button-hover hover:brightness-105 active:translate-y-0 active:shadow-button',
        ghost: 'text-primary-ink hover:bg-primary-soft',
        link: 'text-primary-ink underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2 pointer-coarse:h-11 pointer-coarse:min-w-11',
        sm: 'h-8 rounded-md px-3 pointer-coarse:h-11 pointer-coarse:min-w-11',
        lg: 'h-10 rounded-md px-6 pointer-coarse:h-11 pointer-coarse:min-w-11',
        icon: 'size-9 pointer-coarse:size-11',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

/**
 * A control that is busy, or that does not apply right now, takes `aria-disabled` rather than
 * `disabled`: a disabled control loses focus (the browser moves it to the page), so a keyboard
 * user pressing Save would be sent back to the top. With `aria-disabled` it keeps focus, says it
 * is unavailable, and does nothing when pressed. That includes submitting its form, by a press or
 * by Enter in a field, since both go through a click this cancels. The click is stopped before
 * any handler of its own runs, so with `asChild` the child's own `onClick` does not run either.
 */
function Button({ className, variant, size, asChild = false, onClick, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  const unavailable = props['aria-disabled'] === true || props['aria-disabled'] === 'true';
  return (
    <Comp
      className={cn(buttonVariants({ variant, size, className }))}
      onClick={unavailable ? undefined : onClick}
      {...props}
      {...(unavailable && { onClickCapture: refuse })}
    />
  );
}

/** Cancels a press of an unavailable button: no action, no form submitted, nothing followed. */
function refuse(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
}

/**
 * Classes for a router `Link` that does a job a button would (#1119), so an action is never
 * plain underlined text. Pick by what the link is, not how it should look. They live in this
 * file because a file of their own became one more request on nearly every route.
 *
 *
 * - `actionLink`: the screen's main action that opens another screen ("Register a patient").
 * - `secondaryLink`: any other action or a way back ("Back to doctors", "Discount limit").
 * - `subNavLink`: one tab of a screen group's own links; the current one (`aria-current`) is
 *   filled with the brand gradient, and also bold, so it is never colour alone.
 * - `textLink`: a record's name in a table cell or a list item. Not inside a sentence: it is
 *   `inline-flex` and 44 px tall under a touch pointer; a link in running text keeps its
 *   underline and takes `text-primary-ink`.
 */
const actionLink = cn(buttonVariants(), 'w-fit');

const secondaryLink = cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'w-fit');

const subNavLink =
  'inline-flex min-h-8 items-center rounded-full border border-primary/25 bg-card px-3 text-sm font-medium text-primary-ink shadow-tinted outline-none transition-[background-color,border-color] hover:border-primary/60 hover:bg-primary-soft focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-[current=page]:border-transparent aria-[current=page]:bg-brand-gradient aria-[current=page]:font-semibold aria-[current=page]:text-primary-foreground pointer-coarse:min-h-11';

const textLink =
  'inline-flex items-center rounded-sm font-medium text-primary-ink underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

// eslint-disable-next-line react-refresh/only-export-components
export { Button, buttonVariants, actionLink, secondaryLink, subNavLink, textLink };
