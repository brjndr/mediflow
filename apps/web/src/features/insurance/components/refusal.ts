import { isApiError } from '@/shared/api';

const KNOWN = [
  'duplicate_code',
  'version_conflict',
  'agreement_overlap',
  'starts_in_past',
  'payer_archived',
  'service_not_found',
  'duplicate_policy',
  'policy_not_active',
  'not_submitted',
  'plan_archived',
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
