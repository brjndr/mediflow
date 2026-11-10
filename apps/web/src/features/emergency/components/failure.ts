import { errorMessageKey, isApiError } from '@/shared/api';

const REFUSED: Record<string, string> = {
  unknown_patient: 'errors.patient',
  already_identified: 'errors.identified',
  version_conflict: 'errors.changed',
  conflict: 'errors.changed',
  invalid_transition: 'errors.left',
  identify_first: 'errors.identifyFirst',
  already_admitted: 'errors.admitted',
  unsigned_notes: 'errors.drafts',
  destination_required: 'errors.destination',
  death_time_required: 'errors.deathTime',
  death_in_future: 'errors.deathFuture',
  permission_denied: 'errors.permission',
  feature_disabled: 'errors.module',
  unknown_doctor: 'errors.doctor',
};

/** What to tell the person about a refused request: the module's words, else the common ones. */
export function failureText(
  error: unknown,
  t: (key: string) => string,
  tCommon: (key: string) => string,
): string | undefined {
  if (!error) return undefined;
  const code = isApiError(error) ? error.serverCode : undefined;
  return code !== undefined && REFUSED[code] ? t(REFUSED[code]) : tCommon(errorMessageKey(error));
}
