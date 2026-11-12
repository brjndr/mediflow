import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { ComponentProps, MouseEvent } from 'react';
import { cn } from '@/shared/lib/utils';

type SwitchProps = Omit<ComponentProps<typeof SwitchPrimitive.Root>, 'children'>;

function refuse(event: MouseEvent<HTMLButtonElement>) {
  event.preventDefault();
  event.stopPropagation();
}

/**
 * An on/off setting with the neumorphic skin. Give it a name through a `<label htmlFor>` or
 * `aria-label`. Space toggles it. A busy or not-applicable switch takes `aria-disabled`, which
 * keeps focus and ignores presses; `disabled` is for one that can never change here. The hit area
 * is 44 px under `pointer-coarse:` while the track stays the same size.
 */
function Switch({ className, onClick, ...props }: SwitchProps) {
  const unavailable = props['aria-disabled'] === true || props['aria-disabled'] === 'true';
  return (
    <SwitchPrimitive.Root
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full bg-muted shadow-inset outline-none transition-colors',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=checked]:bg-primary',
        'aria-disabled:opacity-50 disabled:pointer-events-none disabled:opacity-50',
        'pointer-coarse:after:absolute pointer-coarse:after:left-1/2 pointer-coarse:after:top-1/2 pointer-coarse:after:size-11 pointer-coarse:after:-translate-x-1/2 pointer-coarse:after:-translate-y-1/2 pointer-coarse:after:content-[""]',
        className,
      )}
      onClick={unavailable ? undefined : onClick}
      {...props}
      {...(unavailable && { onClickCapture: refuse })}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-5 translate-x-0.5 rounded-full bg-card shadow-raised transition-transform data-[state=checked]:translate-x-[22px]" />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
