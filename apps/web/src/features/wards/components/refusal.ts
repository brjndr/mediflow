import { isApiError } from '@/shared/api';

const KNOWN = [
  'ward_code_taken',
  'ward_has_occupied_beds',
  'ward_archived',
  'room_name_taken',
  'room_has_occupied_beds',
  'room_archived',
  'bed_number_taken',
  'bed_not_available',
  'bed_not_blocked',
  'bed_occupied',
  'bed_category_archived',
  'bed_category_name_taken',
  'bed_category_in_use',
  'conflict',
] as const;

/**
 * What the server said about a change, as a key of this feature's strings, when it is one of
 * its own refusals. Anything else is shown through the API client's messages.
 */
export function refusalKey(error: unknown): `errors.${(typeof KNOWN)[number]}` | null {
  if (!isApiError(error)) return null;
  const code = KNOWN.find((known) => known === error.serverCode);
  return code ? `errors.${code}` : null;
}
