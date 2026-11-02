import { useFeatureFlag, usePermission } from '@/access';

/**
 * Which parts of triage the caller may put on paper (#398): each only for its read permission and
 * with the `triage` switch on. The caller passes this to `readTriageForPrint`, so a part not
 * allowed is never read, and to `TriagePrintout`, so it leaves no trace.
 */
export function useTriagePrintParts(): { allergies: boolean; vitals: boolean } {
  const on = useFeatureFlag('triage');
  const allergies = usePermission('allergy:read');
  const vitals = usePermission('vitals:read');
  return { allergies: on && allergies, vitals: on && vitals };
}
