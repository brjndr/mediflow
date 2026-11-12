import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/shared/lib/utils';

const cardVariants = cva('rounded-xl p-4', {
  variants: {
    /**
     * `soft` is the base surface, `raised` is lifted (something to act on), `brand` carries the
     * hospital's colour as a gradient with white text. Neumorphism stays off cards.
     */
    variant: {
      soft: 'border bg-card text-card-foreground shadow-soft',
      raised: 'border bg-card text-card-foreground shadow-raised',
      brand: 'bg-brand-gradient text-primary-foreground shadow-soft',
    },
  },
  defaultVariants: { variant: 'soft' },
});

type CardProps = ComponentProps<'div'> & VariantProps<typeof cardVariants> & { asChild?: boolean };

/** A surface for a bento tile or a widget. `asChild` styles the child (a `section`) instead of a div. */
function Card({ className, variant, asChild = false, ...props }: CardProps) {
  const Comp = asChild ? Slot : 'div';
  return <Comp className={cn(cardVariants({ variant }), className)} {...props} />;
}

// eslint-disable-next-line react-refresh/only-export-components
export { Card, cardVariants };
