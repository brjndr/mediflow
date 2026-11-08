import { isApiError } from '@/shared/api';

/** Refusals these dialogs have words for, as keys of the feature's strings. */
export function refusalKey(error: unknown): string | null {
  if (!isApiError(error)) return null;
  switch (error.serverCode) {
    case 'conflict':
    case 'invalid_transition':
      return 'refused.changed';
    case 'duplicate_unit':
      return 'refused.duplicate';
    case 'invalid_period':
      return 'refused.period';
    case 'unit_expired':
      return 'refused.expired';
    case 'not_expired':
      return 'refused.notExpired';
    case 'unknown_patient':
      return 'refused.patient';
    default:
      return null;
  }
}
