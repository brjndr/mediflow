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
    case 'screening_required':
      return 'refused.screeningRequired';
    case 'crossmatch_required':
      return 'refused.crossmatchRequired';
    case 'abo_incompatible':
      return 'refused.aboIncompatible';
    case 'blood_group_unknown':
      return 'refused.groupUnknown';
    case 'already_screened':
    case 'not_in_testing':
      return 'refused.screened';
    case 'not_available':
      return 'refused.notAvailable';
    case 'unit_not_given':
      return 'refused.notGiven';
    case 'patient_mismatch':
      return 'refused.patientMismatch';
    case 'severity_not_raised':
      return 'refused.severityNotRaised';
    default:
      return null;
  }
}
