import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, MouseEvent } from 'react';
import { cn } from '@/shared/lib/utils';

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90',
        outline: 'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
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
