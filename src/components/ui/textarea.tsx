import * as React from 'react'

import { cn } from '#/lib/utils'

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex min-h-16 w-full rounded-md border border-[var(--line)] bg-[var(--chip-bg)] px-3 py-2 text-base text-[var(--sea-ink)] shadow-xs outline-none transition-[color,box-shadow] placeholder:text-[var(--sea-ink-soft)] focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-red-500 md:text-sm',
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
