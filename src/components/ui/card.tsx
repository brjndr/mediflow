import * as React from 'react'

import { cn } from '#/lib/utils'

function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card"
      className={cn(
        'island-shell flex flex-col gap-4 rounded-2xl p-5 text-[var(--sea-ink)]',
        className,
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<'h3'>) {
  return (
    <h3
      data-slot="card-title"
      className={cn('m-0 text-base leading-none font-semibold', className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="card-description"
      className={cn('m-0 text-sm text-[var(--sea-ink-soft)]', className)}
      {...props}
    />
  )
}

export { Card, CardTitle, CardDescription }
