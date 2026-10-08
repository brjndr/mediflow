import * as React from 'react'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'

import { cn } from '#/lib/utils'

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral:
          'border-[var(--line)] bg-[var(--chip-bg)] text-[var(--sea-ink-soft)]',
        success:
          'border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
        info: 'border-sky-500/30 bg-sky-500/15 text-sky-700 dark:text-sky-300',
        warning:
          'border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300',
        danger:
          'border-red-500/30 bg-red-500/15 text-red-700 dark:text-red-300',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)

function Badge({
  className,
  tone,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ tone }), className)}
      {...props}
    />
  )
}

export { Badge }
