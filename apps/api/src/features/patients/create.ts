import { Type } from '@sinclair/typebox';
import { HttpError } from '../../core/http/errors.js';
import { RowProblem, type ImportKind, type Writer } from '../../core/imports/registry.js';
import { findDuplicates, insertPatient, todayAtHospital, type PatientRow } from './repository.js';
import { PatientCreate } from './schemas.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

export const invalid = (message: string) => new HttpError(400, 'validation_failed', message);

const isCalendarDate = (dob: string): boolean => {
  const parsed = new Date(`${dob}T00:00:00Z`);
  return (
    ISO_DATE.test(dob) &&
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === dob
  );
};

const dobInRange = (dob: string, today: string): boolean => dob <= today && dob >= '1900-01-01';

/** A real calendar date, not before 1900 and not after today where the hospital is. */
function checkDob(dob: string, today: string): void {
  if (!isCalendarDate(dob)) throw invalid('dob must be a calendar date (YYYY-MM-DD)');
  if (!dobInRange(dob, today)) throw invalid('dob is out of range');
}

interface Demographics {
  firstName?: string;
  lastName?: string;
  dob?: string;
  phone?: string;
  email?: string | null;
  address?: string | null;
}

/**
 * Trims what was typed and checks what the schema cannot. Returns the cleaned values. An email
 * or address of only spaces is left out, the same as not sending one.
 */
export function clean<T extends Demographics>(input: T, today: string): T {
  const out = { ...input };
  for (const field of ['firstName', 'lastName'] as const) {
    if (out[field] === undefined) continue;
    out[field] = out[field].trim();
    if (out[field] === '') throw invalid(`${field} is required`);
  }
  if (out.dob !== undefined) checkDob(out.dob, today);
  if (out.phone !== undefined) {
    out.phone = out.phone.trim();
    if (out.phone.replace(/\D/g, '').length < 5) throw invalid('phone needs at least 5 digits');
  }
  if (typeof out.email === 'string') {
    out.email = out.email.trim();
    if (out.email === '') out.email = null;
    else if (!EMAIL.test(out.email)) throw invalid('email is not a valid address');
  }
  if (typeof out.address === 'string') {
    out.address = out.address.trim();
    if (out.address === '') out.address = null;
  }
  return out;
}

/** Registers the patient (the MRN is assigned here), audited and announced. */
export async function writePatient(
  writer: Writer,
  input: PatientCreate,
  userId: string,
): Promise<PatientRow> {
  const row = await insertPatient(writer.txClient, input, userId);
  writer.audit('create', 'patient', row.id);
  await writer.emit('patient.registered', row.id, { patientId: row.id });
  return row;
}

/**
 * A row of a file of patients: the registration form without the contact consent. Consent is a
 * decision a patient makes, recorded with when and by whom; a column of an old system's file says
 * neither, so it is asked at the next visit instead (#68).
 */
const PatientImportRow = Type.Omit(PatientCreate, ['contactConsent'], {
  additionalProperties: false,
});

type PatientImportRow = Omit<PatientCreate, 'contactConsent'>;

/** The same person by the strongest of the duplicate check's rules: name and date of birth. */
const samePerson = (row: PatientRow, input: PatientCreate): boolean =>
  row.first_name.toLowerCase() === input.firstName.toLowerCase() &&
  row.last_name.toLowerCase() === input.lastName.toLowerCase() &&
  row.dob === input.dob;

/**
 * Patients loaded from a file by the import centre, as `POST /patients` registers them. Behind a
 * permission of its own, `patient:import`. A row with the name and date of birth of someone
 * registered is refused rather than registered a second time: the file is corrected first. The
 * duplicate check's other matches (a shared phone number) are not refused, since a family often
 * shares one phone and could otherwise never be loaded.
 */
export const patientImport: ImportKind<PatientCreate> = {
  kind: 'patients',
  feature: 'patients',
  permissions: ['patient:create', 'patient:import'],
  body: PatientImportRow,
  columns: [
    { field: 'firstName', required: true, type: 'text' },
    { field: 'lastName', required: true, type: 'text' },
    { field: 'dob', required: true, type: 'date' },
    { field: 'gender', required: true, type: 'enum', values: ['male', 'female', 'other'] },
    { field: 'phone', required: true, type: 'text' },
    { field: 'email', required: false, type: 'text' },
    { field: 'address', required: false, type: 'text' },
  ],
  async prepare(writer, body) {
    const row = body as PatientImportRow;
    const today = await todayAtHospital(writer.txClient);
    // The checks of `clean`, each named by its field, so the report can say which one.
    if (!isCalendarDate(row.dob)) throw new RowProblem('dob', 'not_a_date');
    if (!dobInRange(row.dob, today)) throw new RowProblem('dob', 'out_of_range');
    if (row.phone.replace(/\D/g, '').length < 5) throw new RowProblem('phone', 'too_few_digits');
    if (row.email !== undefined && !EMAIL.test(row.email.trim())) {
      throw new RowProblem('email', 'not_an_email');
    }
    const input = clean<PatientCreate>(row, today);
    const matches = await findDuplicates(writer.txClient, input);
    if (matches.some((match) => samePerson(match, input))) {
      throw new HttpError(409, 'patient_possible_duplicate', 'Someone like this is registered');
    }
    // The same rule within the file.
    const key = [input.firstName, input.lastName, input.dob]
      .map((part) => part.toLowerCase())
      .join('\u0000');
    return { value: input, key };
  },
  write: async (writer, input, actorId) => {
    await writePatient(writer, input, actorId);
  },
};
