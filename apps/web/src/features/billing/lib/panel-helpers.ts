import { useEffect, useRef, type RefObject } from 'react';
import type { TFunction } from 'i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';

/** An amount in minor units as the digits a person types: 12550 is "125.50" in two decimals. */
export function amountText(minor: number, digits: number): string {
  const text = String(minor).padStart(digits + 1, '0');
  return digits === 0 ? text : `${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

/**
 * What to tell a person about a failed request: the words of the API's refusal when `refusals`
 * has its code (under `<prefix>.refused.<code>` in the billing texts), otherwise the generic
 * message for the kind of failure.
 */
export function refusalText(
  error: unknown,
  refusals: ReadonlySet<string>,
  prefix: string,
  t: TFunction<'billing'>,
  tCommon: TFunction,
): string {
  const code = isApiError(error) ? error.serverCode : undefined;
  return code && refusals.has(code)
    ? t(`${prefix}.refused.${code}`)
    : tCommon(errorMessageKey(error));
}

/**
 * When a panel's form goes (the last payment, or a refusal that says nothing more can be done)
 * focus moves to the status line, once it holds what happened: the line is hidden while empty.
 */
export function useFocusWhenFormGoes(
  shown: boolean,
  hasMessage: boolean,
  status: RefObject<HTMLElement | null>,
) {
  const was = useRef(shown);
  const left = useRef(false);
  useEffect(() => {
    if (was.current && !shown) left.current = true;
    was.current = shown;
  }, [shown]);
  useEffect(() => {
    if (left.current && hasMessage && !shown) {
      left.current = false;
      focusIfLost(status.current);
    }
  }, [hasMessage, shown, status]);
}
