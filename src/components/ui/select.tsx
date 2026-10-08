import * as React from 'react'

import { cn } from '#/lib/utils'

// Native <select> styled like the shadcn Select trigger. The registry
// (Radix) version could not be fetched while scaffolding offline; a native
// select keeps forms accessible and dependency-free.
function Select({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      data-slot="select"
      className={cn(
        'flex h-9 w-full rounded-md border border-[var(--line)] bg-[var(--chip-bg)] px-3 py-1 text-sm text-[var(--sea-ink)] shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-red-500',
        className,
      )}
      {...props}
    />
  )
}

export { Select }
