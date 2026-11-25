import { coreHandlers, notTheApi } from './core-handlers';
import { accountHandlers } from './handlers/auth';
import { departmentsHandlers } from './handlers/departments';
import { hospitalProfileHandlers } from './handlers/hospital-profile';
import {
  appointmentChangeHandlers,
  appointmentsHandlers,
  bookingHandlers,
} from './handlers/appointments';
import { doctorsHandlers } from './handlers/doctors';
import { billingHandlers } from './handlers/billing';
import { dischargePlanHandlers } from './handlers/discharge-plan';
import { dischargeSummaryHandlers } from './handlers/discharge-summary';
import { stayBillHandlers } from './handlers/stay-bill';
import { clinicalHandlers } from './handlers/clinical';
import { dietHandlers } from './handlers/nursing-diet';
import { codesHandlers } from './handlers/codes';
import { drugsHandlers } from './handlers/drugs';
import { labHandlers } from './handlers/lab';
import { radiologyHandlers } from './handlers/radiology';
import { indentHandlers } from './handlers/indents';
import { inventoryHandlers } from './handlers/inventory';
import { prescriptionSetsHandlers } from './handlers/prescription-sets';
import { pharmacyHandlers } from './handlers/pharmacy';
import { pharmacySaleHandlers } from './handlers/pharmacy-sales';
import { purchasingHandlers } from './handlers/purchasing';
import { labTestsHandlers } from './handlers/lab-tests';
import { examplesHandlers } from './handlers/examples';
import { importsHandlers } from './handlers/imports';
import { mfaHandlers } from './handlers/mfa';
import { noticesHandlers } from './handlers/notices';
import { servicesHandlers } from './handlers/services';
import { consentsHandlers } from './handlers/consents';
import { recordsHandlers } from './handlers/records';
import { rosterHandlers } from './handlers/roster';
import { documentsHandlers } from './handlers/documents';
import { templatesHandlers } from './handlers/templates';
import { wardsHandlers } from './handlers/wards';
import { admissionsHandlers } from './handlers/admissions';
import { housekeepingHandlers } from './handlers/housekeeping';
import { nursingHandlers } from './handlers/nursing';
import { ambulanceHandlers } from './handlers/ambulances';
import { theatreHandlers } from './handlers/theatre';
import { emergencyHandlers } from './handlers/emergency';
import { bloodBankHandlers } from './handlers/blood-bank';
import { bloodDonorHandlers } from './handlers/blood-donors';
import { claimHandlers } from './handlers/claims';
import { creditHandlers } from './handlers/credit';
import { coverageHandlers } from './handlers/coverage';
import { coverageSplitHandlers } from './handlers/coverage-split';
import { insuranceHandlers } from './handlers/insurance';
import { rolesHandlers } from './handlers/roles';
import { staffHandlers } from './handlers/staff';
import { patientsHandlers } from './handlers/patients';
import { platformHandlers } from './handlers/platform';
import { queueHandlers } from './handlers/queue';
import { auditHandlers } from './handlers/audit';
import { reportsHandlers } from './handlers/reports';
import { triageHandlers } from './handlers/triage';

export const handlers = [
  notTheApi,
  ...coreHandlers,
  // Feature handlers: one line per feature, and one entry in handler-groups.ts, which the
  // browser loads from (a test checks the two lists agree).
  ...noticesHandlers,
  ...examplesHandlers,
  ...patientsHandlers,
  ...departmentsHandlers,
  ...rolesHandlers,
  ...hospitalProfileHandlers,
  ...doctorsHandlers,
  ...appointmentsHandlers,
  ...bookingHandlers,
  ...appointmentChangeHandlers,
  ...queueHandlers,
  ...triageHandlers,
  // Before the clinical routes: it places a ward diet order, which they would refuse.
  ...dietHandlers,
  ...clinicalHandlers,
  ...prescriptionSetsHandlers,
  ...billingHandlers,
  ...stayBillHandlers,
  ...dischargePlanHandlers,
  ...dischargeSummaryHandlers,
  ...labHandlers,
  ...radiologyHandlers,
  ...inventoryHandlers,
  ...indentHandlers,
  ...purchasingHandlers,
  ...pharmacyHandlers,
  ...pharmacySaleHandlers,
  ...staffHandlers,
  ...servicesHandlers,
  ...drugsHandlers,
  ...labTestsHandlers,
  ...wardsHandlers,
  // Before the admissions routes: their `/admissions/:id/:action` would answer these.
  ...nursingHandlers,
  ...admissionsHandlers,
  ...housekeepingHandlers,
  ...ambulanceHandlers,
  ...theatreHandlers,
  ...emergencyHandlers,
  ...bloodBankHandlers,
  ...bloodDonorHandlers,
  ...insuranceHandlers,
  ...coverageHandlers,
  ...coverageSplitHandlers,
  ...claimHandlers,
  ...creditHandlers,
  ...codesHandlers,
  ...templatesHandlers,
  ...documentsHandlers,
  ...consentsHandlers,
  ...recordsHandlers,
  ...rosterHandlers,
  ...importsHandlers,
  ...reportsHandlers,
  ...auditHandlers,
  ...accountHandlers,
  ...mfaHandlers,
  ...platformHandlers,
];
