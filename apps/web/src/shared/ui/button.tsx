import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, MouseEvent } from 'react';
import { cn } from '@/shared/lib/utils';

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold transition-[color,background-color,border-color,box-shadow,transform,filter] duration-150 disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
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

// eslint-disable-next-line react-refresh/only-export-components
export { Button, buttonVariants };
