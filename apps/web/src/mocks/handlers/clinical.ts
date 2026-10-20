import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { isEmptyRichText, sanitizeRichText } from '@/shared/ui/rich-text';
import { PLAIN_LINES, PLAIN_TEXT } from '@/shared/utils/text';
import { todayIn } from '@/shared/utils/timezone';
import { currentPolicy, currentSession, mockTenantTimezone, onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';
import { mockAppointment } from './appointments';
import { mockCode } from './codes';
import { mockCredentials, mockDoctor, mockDoctorOfUser } from './doctors';
import { mockDrug } from './drugs';
import { mockOrderableLabTest } from './lab-tests';
import { mockPatient } from './patients';
import { mockQueueToken } from './queue';
import { mockOrderableService } from './services';

type Encounter = components['schemas']['Encounter'];
type EncounterPage = components['schemas']['EncounterPage'];
type ClinicalNote = components['schemas']['ClinicalNote'];
type ClinicalNotePage = components['schemas']['ClinicalNotePage'];
type Diagnosis = components['schemas']['Diagnosis'];
type DiagnosisPage = components['schemas']['DiagnosisPage'];
type Order = components['schemas']['Order'];
type Prescription = components['schemas']['Prescription'];
type PrescriptionPage = components['schemas']['PrescriptionPage'];
type MedicationRoute = components['schemas']['MedicationRoute'];
type OrderPage = components['schemas']['OrderPage'];

const ORDER_TYPES: readonly Order['type'][] = ['lab', 'imaging', 'procedure', 'medication', 'diet'];
const PRIORITIES: readonly Order['priority'][] = ['routine', 'urgent', 'stat'];

const FEATURE_FLAG = 'clinical';
const REASON_MAX = 200;
const TEXT_MAX = 300;
const LINES_MAX = 30;
const DOSE_MAX = 50;
const INSTRUCTIONS_MAX = 500;
const ADVICE_MAX = 1000;
const ROUTES: readonly MedicationRoute[] = [
  'oral',
  'sublingual',
  'topical',
  'inhaled',
  'nasal',
  'eye',
  'ear',
  'rectal',
  'vaginal',
  'intramuscular',
  'intravenous',
  'subcutaneous',
  'other',
];

/** What the mock keeps of a prescription: its lines are the medication orders naming it. */
type StoredPrescription = Omit<Prescription, 'lines' | 'replacedById'>;

/**
 * What the mock keeps of an encounter: ids, never names. The patient, doctor and department are
 * looked up when it answers, as the API joins them.
 */
interface StoredEncounter {
  id: string;
  tenantId: string;
  patientId: string;
  status: Encounter['status'];
  appointmentId?: string;
  queueTokenId?: string;
  doctorId: string;
  openedAt: string;
  openedByName: string;
  endedAt?: string;
  endedByName?: string;
  cancelReason?: string;
  version: number;
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/**
 * At the hospital, an open consultation of `pth_00001` (the patient triage has readings and a
 * penicillin allergy for) with `doc_h_01`, with a signed note and a provisional diagnosis, and a
 * closed one of `pth_00002` from yesterday; at the clinic, an open one of `ptc_00001`. The open
 * one at the hospital has a prescription of paracetamol and cetirizine.
 */
function seed() {
  const hospital = TENANT_IDS.hospital;
  const clinic = TENANT_IDS.clinic;
  const encounters: StoredEncounter[] = [
    {
      id: 'enc_h_1',
      tenantId: hospital,
      patientId: 'pth_00001',
      status: 'open',
      doctorId: 'doc_h_01',
      openedAt: minutesAgo(30),
      openedByName: 'Sample Admin',
      version: 1,
    },
    {
      id: 'enc_h_2',
      tenantId: hospital,
      patientId: 'pth_00002',
      status: 'closed',
      doctorId: 'doc_h_02',
      openedAt: minutesAgo(26 * 60),
      openedByName: 'Sample Admin',
      endedAt: minutesAgo(25 * 60),
      endedByName: 'Sample Admin',
      version: 2,
    },
    {
      id: 'enc_c_1',
      tenantId: clinic,
      patientId: 'ptc_00001',
      status: 'open',
      doctorId: 'doc_c_01',
      openedAt: minutesAgo(10),
      openedByName: 'Sample Doctor',
      version: 1,
    },
  ];
  const author = mockDoctor(hospital, 'doc_h_01');
  const notes: ClinicalNote[] = [
    {
      id: 'note_h_1',
      tenantId: hospital,
      encounterId: 'enc_h_1',
      patientId: 'pth_00001',
      status: 'signed',
      body: doc('Cough for a week, no fever. Chest clear on examination.'),
      authorId: author?.userId ?? 'user_doc_h_01',
      authorName: author?.name ?? 'Doctor',
      createdAt: minutesAgo(25),
      updatedAt: minutesAgo(20),
      signedAt: minutesAgo(20),
      version: 2,
    },
  ];
  const diagnoses: Diagnosis[] = [
    {
      id: 'dx_h_1',
      tenantId: hospital,
      encounterId: 'enc_h_1',
      patientId: 'pth_00001',
      codeId: 'icd10_j069',
      code: 'J06.9',
      codeTitle: mockCode('icd10_j069')?.title ?? 'Acute upper respiratory infection, unspecified',
      kind: 'provisional',
      recordedAt: minutesAgo(19),
      recordedByName: author?.name ?? 'Doctor',
    },
  ];
  const prescribedAt = minutesAgo(15);
  const prescriber = {
    id: author?.userId ?? 'user_doc_h_01',
    name: author?.name ?? 'Doctor',
  };
  const prescriptions: StoredPrescription[] = [
    {
      id: 'rx_h_1',
      tenantId: hospital,
      encounterId: 'enc_h_1',
      patientId: 'pth_00001',
      prescribedAt,
      prescribedById: prescriber.id,
      prescribedByName: prescriber.name,
      advice: 'Drink plenty of fluids.\nCome back if the fever rises.',
    },
  ];
  const line = (id: string, lineNumber: number, rest: Partial<Order>): Order => ({
    id,
    tenantId: hospital,
    encounterId: 'enc_h_1',
    patientId: 'pth_00001',
    type: 'medication',
    prescriptionId: 'rx_h_1',
    lineNumber,
    status: 'placed',
    priority: 'routine',
    route: 'oral',
    placedAt: prescribedAt,
    orderedById: prescriber.id,
    orderedByName: prescriber.name,
    version: 1,
    ...rest,
  });
  const orders: Order[] = [
    line('ord_h_1', 1, {
      drugId: 'drg_h_2573',
      itemName: 'Paracetamol 500 mg (ParaCare)',
      dose: '1 tablet',
      frequency: '1-0-1',
      durationDays: 3,
      quantity: 6,
      instructions: 'After food',
    }),
    line('ord_h_2', 2, {
      drugId: 'drg_h_0805',
      itemName: 'Cetirizine 10 mg (CetiCare)',
      dose: '1 tablet',
      frequency: '0-0-1',
      durationDays: 5,
      quantity: 5,
    }),
    // A lab order placed at the start of the visit (#82).
    {
      id: 'ord_h_lab_1',
      tenantId: hospital,
      encounterId: 'enc_h_1',
      patientId: 'pth_00001',
      type: 'lab',
      labTestId: 'lab_h_cbc',
      itemCode: 'CBC',
      itemName: 'Complete blood count',
      status: 'placed',
      priority: 'routine',
      instructions: 'Fasting not needed',
      placedAt: prescribedAt,
      orderedById: prescriber.id,
      orderedByName: prescriber.name,
      version: 1,
    },
    // An imaging study ordered with the blood count (#87).
    {
      id: 'ord_h_img_1',
      tenantId: hospital,
      encounterId: 'enc_h_1',
      patientId: 'pth_00001',
      type: 'imaging',
      serviceId: 'svc_h_24',
      itemCode: 'IMG-001',
      itemName: 'Chest X-ray',
      status: 'placed',
      priority: 'urgent',
      instructions: 'PA view. Cough for three weeks.',
      placedAt: prescribedAt,
      orderedById: prescriber.id,
      orderedByName: prescriber.name,
      version: 1,
    },
    // A lab order of yesterday's closed visit, not started yet: it can still be cancelled.
    {
      id: 'ord_h_lab_2',
      tenantId: hospital,
      encounterId: 'enc_h_2',
      patientId: 'pth_00002',
      type: 'lab',
      labTestId: 'lab_h_hb',
      itemCode: 'HB',
      itemName: 'Haemoglobin',
      status: 'placed',
      priority: 'routine',
      placedAt: minutesAgo(25 * 60 + 30),
      orderedById: prescriber.id,
      orderedByName: prescriber.name,
      version: 1,
    },
  ];
  /** What was printed (#89), as the audit log keeps it: the entity and its id. */
  const prints: MockPrint[] = [];
  return { encounters, notes, diagnoses, prescriptions, orders, prints };
}

/** A print the API would record in the audit log (#89). */
export interface MockPrint {
  tenantId: string;
  entity: 'encounter' | 'prescription';
  id: string;
  userId: string;
}

let state = seed();
let counter = 0;
/** Requests already answered, by tenant, user and idempotency key, as the API keeps them. */
let answered = new Map<string, { body: string; status: number; id: string }>();

onMockReset(() => {
  state = seed();
  counter = 0;
  answered = new Map();
});

const nextId = (prefix: string) => `${prefix}_mock_${++counter}`;
const now = () => new Date().toISOString();
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const reasonOf = (value: unknown) =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.trim().length <= REASON_MAX &&
  PLAIN_TEXT.test(value)
    ? value.trim()
    : null;

function caller() {
  const user = currentSession()?.user;
  return { id: user?.id ?? '', name: user?.name ?? '' };
}

/** Whether the caller reaches the encounter with the scope they hold the permission with. */
function inScope(encounter: StoredEncounter, permission: string): boolean {
  const grant = currentPolicy()?.permissions.find((each) => each.permission === permission);
  if (!grant) return false;
  if (!grant.scope || grant.scope === 'all') return true;
  const doctor = mockDoctor(encounter.tenantId, encounter.doctorId);
  if (grant.scope === 'own') return doctor?.userId === caller().id;
  // `department`: the departments of the caller's own doctor profile.
  const own = mockDoctorOfUser(encounter.tenantId, caller().id);
  return own !== undefined && doctor?.departmentId === own.departmentId;
}

function viewOf(stored: StoredEncounter): Encounter {
  const patient = mockPatient(stored.tenantId, stored.patientId);
  const doctor = mockDoctor(stored.tenantId, stored.doctorId);
  return {
    id: stored.id,
    tenantId: stored.tenantId,
    patientId: stored.patientId,
    patientName: patient?.name ?? '',
    patientMrn: patient?.mrn ?? '',
    type: 'opd',
    status: stored.status,
    ...(stored.appointmentId ? { appointmentId: stored.appointmentId } : {}),
    ...(stored.queueTokenId ? { queueTokenId: stored.queueTokenId } : {}),
    attendingDoctorId: stored.doctorId,
    ...(doctor ? { attendingDoctorName: doctor.name } : {}),
    ...(doctor
      ? {
          attendingDoctorCredentials: mockCredentials(stored.tenantId, {
            doctorId: stored.doctorId,
          }),
        }
      : {}),
    ...(doctor ? { departmentId: doctor.departmentId, departmentName: doctor.departmentName } : {}),
    openedAt: stored.openedAt,
    openedByName: stored.openedByName,
    ...(stored.endedAt ? { endedAt: stored.endedAt, endedByName: stored.endedByName } : {}),
    ...(stored.cancelReason ? { cancelReason: stored.cancelReason } : {}),
    version: stored.version,
  };
}

const notFound = () => error(404, 'encounter_not_found', 'Encounter not found');
const notPrintable = () => error(409, 'not_printable', 'Replaced or cancelled: not printed');

/** The encounter of this hospital the caller reaches with the permission, or null. */
function encounterFor(tenantId: string, id: string, permission: string) {
  const found = state.encounters.find((each) => each.id === id && each.tenantId === tenantId);
  return found && inScope(found, permission) ? found : null;
}

function page<T extends { id: string }>(items: T[], request: Request, withTotal = true) {
  const query = new URL(request.url).searchParams;
  const limit = Number(query.get('limit') ?? 25);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { refused: error(400, 'validation_failed', 'Bad limit') };
  }
  const cursor = query.get('cursor');
  const first = cursor ? items.findIndex((each) => each.id === cursor) : 0;
  if (first < 0) return { refused: error(400, 'invalid_cursor', 'Unknown cursor') };
  const next = items[first + limit];
  return {
    page: {
      items: items.slice(first, first + limit),
      nextCursor: next ? next.id : null,
      ...(cursor || !withTotal ? {} : { total: items.length }),
    },
  };
}

/**
 * The idempotency key of a POST: required, kept per hospital and user. A repeat with the same
 * body answers again with what is true now; the same key with another body is refused.
 */
async function idempotent(
  request: Request,
  tenantId: string,
): Promise<
  { refused: Response } | { body: unknown; keyOf: string; replay?: { status: number; id: string } }
> {
  const key = request.headers.get('Idempotency-Key');
  if (!key) return { refused: error(400, 'validation_failed', 'Idempotency-Key is required') };
  const body: unknown = await request.json().catch(() => null);
  const keyOf = `${tenantId}:${caller().id}:${new URL(request.url).pathname}:${key}`;
  const replay = answered.get(keyOf);
  if (replay) {
    if (replay.body !== JSON.stringify(body)) {
      return {
        refused: error(422, 'idempotency_key_reuse', 'This key was used for a different request'),
      };
    }
    return { body, keyOf, replay };
  }
  return { body, keyOf };
}

const remember = (keyOf: string, body: unknown, status: number, id: string) =>
  answered.set(keyOf, { body: JSON.stringify(body), status, id });

/** A note the caller may see: signed, or their own draft. */
const visibleNote = (note: ClinicalNote) =>
  note.status === 'signed' || note.authorId === caller().id;

function noteFor(tenantId: string, id: string, permission: string) {
  const note = state.notes.find((each) => each.id === id && each.tenantId === tenantId);
  if (!note || !visibleNote(note) || !encounterFor(tenantId, note.encounterId, permission))
    return null;
  return note;
}
/** A prescription as the API answers: its lines in place, and the one that replaced it. */
function prescriptionView(stored: StoredPrescription): Prescription {
  const replacement = state.prescriptions.find((each) => each.replacesId === stored.id);
  const credentials = mockCredentials(stored.tenantId, { userId: stored.prescribedById });
  return {
    ...stored,
    ...(credentials ? { prescribedByCredentials: credentials } : {}),
    ...(replacement ? { replacedById: replacement.id } : {}),
    lines: state.orders
      .filter((order) => order.prescriptionId === stored.id)
      .sort((a, b) => (a.lineNumber ?? 0) - (b.lineNumber ?? 0)),
  };
}

const prescriptionNotFound = () => error(404, 'prescription_not_found', 'Prescription not found');

/** Plain text within a limit, trimmed; undefined when absent and null when refused. */
function plainOf(value: unknown, max: number, pattern = PLAIN_TEXT) {
  if (value === undefined) return undefined;
  return typeof value === 'string' &&
    value.trim() !== '' &&
    value.trim().length <= max &&
    pattern.test(value)
    ? value.trim()
    : null;
}

/** A whole number within the limits; undefined when absent and null when refused. */
function countOf(value: unknown, max: number) {
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max
    ? value
    : null;
}

/** One line of a prescription as the API checks it, or null. */
function lineOf(value: unknown) {
  if (!isObject(value) || typeof value.drugId !== 'string') return null;
  const dose = plainOf(value.dose, DOSE_MAX);
  const frequency = plainOf(value.frequency, DOSE_MAX);
  const route = ROUTES.find((each) => each === value.route);
  const durationDays = countOf(value.durationDays, 365);
  const quantity = countOf(value.quantity, 10_000);
  const instructions = plainOf(value.instructions, INSTRUCTIONS_MAX, PLAIN_LINES);
  if (!dose || !frequency || !route) return null;
  if (durationDays === null || quantity === null || instructions === null) return null;
  return { drugId: value.drugId, dose, frequency, route, durationDays, quantity, instructions };
}

/** How the API names a medicine on an order: generic name, strength and brand. */
const itemNameOf = (drug: { genericName: string; strength?: string; brandName?: string }) =>
  [drug.genericName, drug.strength].filter(Boolean).join(' ') +
  (drug.brandName ? ` (${drug.brandName})` : '');

const noteNotFound = () => error(404, 'note_not_found', 'Note not found');
const notOpen = () => error(409, 'encounter_not_open', 'The encounter is not open');

/** A document the API would take: the app's rich text, not empty. */
function documentOf(value: unknown) {
  if (!isObject(value)) return null;
  const document = sanitizeRichText(value);
  return isEmptyRichText(document) ? null : document;
}

export const clinicalHandlers = [
  http.get('*/api/encounters', ({ request }) => {
    const access = authorize(request, { permission: 'encounter:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const query = new URL(request.url).searchParams;
    const patientId = query.get('patientId');
    const doctorId = query.get('attendingDoctorId');
    const status = query.get('status');
    const type = query.get('type');
    if (type && !['opd', 'ipd', 'er', 'daycare'].includes(type)) {
      return error(400, 'validation_failed', 'Unknown type');
    }
    const shown = state.encounters
      .filter((each) => each.tenantId === access.tenantId && inScope(each, 'encounter:read'))
      .filter((each) => !patientId || each.patientId === patientId)
      .filter((each) => !doctorId || each.doctorId === doctorId)
      .filter((each) => !status || each.status === status)
      // Only `opd` is opened, as by the API.
      .filter(() => !type || type === 'opd')
      .sort((a, b) => b.openedAt.localeCompare(a.openedAt) || b.id.localeCompare(a.id))
      .map(viewOf);
    // Counted only for one patient or one doctor, as the API counts.
    const result = page(shown, request, Boolean(patientId || doctorId));
    return 'refused' in result ? result.refused : HttpResponse.json<EncounterPage>(result.page);
  }),

  http.get('*/api/encounters/:encounterId', ({ request, params }) => {
    const access = authorize(request, { permission: 'encounter:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const found = encounterFor(access.tenantId, String(params.encounterId), 'encounter:read');
    return found ? HttpResponse.json<Encounter>(viewOf(found)) : notFound();
  }),

  http.post('*/api/encounters', async ({ request }) => {
    const access = authorize(request, {
      permission: 'encounter:create',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    if (sent.replay) {
      const again = encounterFor(tenantId, sent.replay.id, 'encounter:create');
      return again
        ? HttpResponse.json<Encounter>(viewOf(again), { status: sent.replay.status })
        : notFound();
    }
    const body = sent.body;
    if (!isObject(body) || typeof body.patientId !== 'string') {
      return error(400, 'validation_failed', 'patientId is required');
    }
    const policy = currentPolicy();
    const holds = (permission: string) =>
      policy?.permissions.some((grant) => grant.permission === permission) === true;
    if (!holds('patient:read') || !mockPatient(tenantId, body.patientId)) {
      return error(422, 'unknown_patient', 'No such patient');
    }
    let tokenDoctor: string | undefined;
    let tokenAppointment: string | undefined;
    if (typeof body.queueTokenId === 'string') {
      const token = policy?.features.queue === true ? mockQueueToken(body.queueTokenId) : undefined;
      if (
        !token ||
        token.tenantId !== tenantId ||
        token.patientId !== body.patientId ||
        token.day !== todayIn(mockTenantTimezone(tenantId))
      ) {
        return error(422, 'token_not_for_patient', 'Not this patient’s token today');
      }
      if (
        token.appointmentId &&
        typeof body.appointmentId === 'string' &&
        body.appointmentId !== token.appointmentId
      ) {
        return error(422, 'unknown_appointment', 'Not the appointment of the token');
      }
      tokenDoctor = token.doctorId;
      tokenAppointment = token.appointmentId;
    }
    let appointmentDoctor: string | undefined;
    if (typeof body.appointmentId === 'string') {
      const appointment =
        holds('appointment:read') && policy?.features.appointments === true
          ? mockAppointment(tenantId, body.appointmentId)
          : undefined;
      if (!appointment || appointment.patientId !== body.patientId) {
        return error(422, 'unknown_appointment', 'No such appointment');
      }
      if (appointment.status === 'cancelled' || appointment.status === 'no_show') {
        return error(409, 'invalid_transition', `The appointment is ${appointment.status}`);
      }
      appointmentDoctor = appointment.doctorId;
    }
    const queueTokenId = typeof body.queueTokenId === 'string' ? body.queueTokenId : undefined;
    const appointmentId =
      typeof body.appointmentId === 'string' ? body.appointmentId : tokenAppointment;
    if (queueTokenId || appointmentId) {
      const existing = state.encounters.filter(
        (each) =>
          each.tenantId === tenantId &&
          each.status !== 'cancelled' &&
          ((queueTokenId && each.queueTokenId === queueTokenId) ||
            (appointmentId && each.appointmentId === appointmentId)),
      );
      const reached =
        existing.length === 1 && existing[0] && inScope(existing[0], 'encounter:create')
          ? existing[0]
          : null;
      if (existing.length > 0 && !reached) {
        return error(409, 'already_open', 'An encounter exists for it');
      }
      if (reached) {
        remember(sent.keyOf, body, 200, reached.id);
        return HttpResponse.json<Encounter>(viewOf(reached), { status: 200 });
      }
    }
    const doctorId =
      (typeof body.attendingDoctorId === 'string' ? body.attendingDoctorId : undefined) ??
      tokenDoctor ??
      appointmentDoctor ??
      mockDoctorOfUser(tenantId, caller().id)?.id;
    const doctor = doctorId ? mockDoctor(tenantId, doctorId) : undefined;
    const stored: StoredEncounter | null =
      doctor && doctor.active
        ? {
            id: nextId('enc'),
            tenantId,
            patientId: body.patientId,
            status: 'open',
            ...(queueTokenId ? { queueTokenId } : {}),
            ...(appointmentId ? { appointmentId } : {}),
            doctorId: doctor.id,
            openedAt: now(),
            openedByName: caller().name,
            version: 1,
          }
        : null;
    if (!stored || !inScope(stored, 'encounter:create')) {
      return error(422, 'unknown_doctor', 'No such doctor');
    }
    state.encounters.push(stored);
    remember(sent.keyOf, body, 201, stored.id);
    return HttpResponse.json<Encounter>(viewOf(stored), { status: 201 });
  }),

  ...(['close', 'cancel'] as const).map((action) =>
    http.post(`*/api/encounters/:encounterId/${action}`, async ({ request, params }) => {
      const access = authorize(request, {
        permission: 'encounter:update',
        featureFlag: FEATURE_FLAG,
      });
      if ('denied' in access) return access.denied;
      const { tenantId } = access;
      const sent = await idempotent(request, tenantId);
      if ('refused' in sent) return sent.refused;
      const found = encounterFor(tenantId, String(params.encounterId), 'encounter:update');
      if (!found) return notFound();
      if (sent.replay) return HttpResponse.json<Encounter>(viewOf(found));
      const body = sent.body;
      const reason = action === 'cancel' && isObject(body) ? reasonOf(body.reason) : '';
      if (!isObject(body) || typeof body.version !== 'number' || reason === null) {
        return error(400, 'validation_failed', 'The request is not valid');
      }
      if (found.status !== 'open') return error(409, 'invalid_transition', 'Not open');
      if (body.version !== found.version) return error(409, 'conflict', 'Changed meanwhile');
      const ofIt = <T extends { encounterId: string }>(items: T[]) =>
        items.filter((each) => each.encounterId === found.id);
      if (ofIt(state.notes).some((note) => note.status === 'draft')) {
        return error(409, 'unsigned_notes', 'A note is a draft');
      }
      if (
        action === 'cancel' &&
        (ofIt(state.notes).length > 0 ||
          ofIt(state.diagnoses).some((each) => !each.retractedAt) ||
          ofIt(state.orders).length > 0)
      ) {
        return error(409, 'has_records', 'Something is on the record');
      }
      found.status = action === 'close' ? 'closed' : 'cancelled';
      found.endedAt = now();
      found.endedByName = caller().name;
      if (reason) found.cancelReason = reason;
      found.version += 1;
      remember(sent.keyOf, body, 200, found.id);
      return HttpResponse.json<Encounter>(viewOf(found));
    }),
  ),

  http.get('*/api/encounters/:encounterId/notes', ({ request, params }) => {
    const access = authorize(request, {
      permission: 'clinicalNote:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const found = encounterFor(access.tenantId, String(params.encounterId), 'clinicalNote:read');
    if (!found) return notFound();
    const shown = state.notes
      .filter((note) => note.encounterId === found.id && visibleNote(note))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const result = page(shown, request);
    return 'refused' in result ? result.refused : HttpResponse.json<ClinicalNotePage>(result.page);
  }),

  http.post('*/api/encounters/:encounterId/notes', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'clinicalNote:write',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    const found = encounterFor(tenantId, String(params.encounterId), 'clinicalNote:write');
    if (!found) return notFound();
    if (sent.replay) {
      const again = noteFor(tenantId, sent.replay.id, 'clinicalNote:write');
      return again ? HttpResponse.json<ClinicalNote>(again, { status: 201 }) : noteNotFound();
    }
    const document = isObject(sent.body) ? documentOf(sent.body.body) : null;
    if (!document) return error(400, 'validation_failed', 'A note cannot be empty');
    if (found.status !== 'open') return notOpen();
    const at = now();
    const note: ClinicalNote = {
      id: nextId('note'),
      tenantId,
      encounterId: found.id,
      patientId: found.patientId,
      status: 'draft',
      body: { ...document },
      authorId: caller().id,
      authorName: caller().name,
      createdAt: at,
      updatedAt: at,
      version: 1,
    };
    state.notes.push(note);
    remember(sent.keyOf, sent.body, 201, note.id);
    return HttpResponse.json<ClinicalNote>(note, { status: 201 });
  }),

  http.get('*/api/notes/:noteId', ({ request, params }) => {
    const access = authorize(request, {
      permission: 'clinicalNote:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const note = noteFor(access.tenantId, String(params.noteId), 'clinicalNote:read');
    return note ? HttpResponse.json<ClinicalNote>(note) : noteNotFound();
  }),

  http.patch('*/api/notes/:noteId', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'clinicalNote:write',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const note = noteFor(access.tenantId, String(params.noteId), 'clinicalNote:write');
    if (!note) return noteNotFound();
    const body: unknown = await request.json().catch(() => null);
    const document = isObject(body) ? documentOf(body.body) : null;
    if (!isObject(body) || !document || typeof body.version !== 'number') {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (note.status === 'signed') return error(409, 'note_signed', 'A signed note is amended');
    if (state.encounters.find((each) => each.id === note.encounterId)?.status !== 'open') {
      return notOpen();
    }
    if (body.version !== note.version) return error(409, 'conflict', 'Changed meanwhile');
    note.body = { ...document };
    note.version += 1;
    note.updatedAt = now();
    return HttpResponse.json<ClinicalNote>(note);
  }),

  http.delete('*/api/notes/:noteId', ({ request, params }) => {
    const access = authorize(request, {
      permission: 'clinicalNote:write',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const note = noteFor(access.tenantId, String(params.noteId), 'clinicalNote:write');
    if (!note) return noteNotFound();
    if (note.status === 'signed')
      return error(409, 'note_signed', 'A signed note is never removed');
    state.notes = state.notes.filter((each) => each.id !== note.id);
    return new HttpResponse(null, { status: 204 });
  }),

  http.post('*/api/notes/:noteId/sign', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'clinicalNote:write',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const sent = await idempotent(request, access.tenantId);
    if ('refused' in sent) return sent.refused;
    const note = noteFor(access.tenantId, String(params.noteId), 'clinicalNote:write');
    if (!note) return noteNotFound();
    if (sent.replay) return HttpResponse.json<ClinicalNote>(note);
    if (!isObject(sent.body) || typeof sent.body.version !== 'number') {
      return error(400, 'validation_failed', 'version is required');
    }
    if (note.status === 'signed') return error(409, 'note_signed', 'Already signed');
    if (state.encounters.find((each) => each.id === note.encounterId)?.status !== 'open') {
      return notOpen();
    }
    if (sent.body.version !== note.version) return error(409, 'conflict', 'Changed meanwhile');
    note.status = 'signed';
    note.signedAt = now();
    note.updatedAt = note.signedAt;
    note.version += 1;
    remember(sent.keyOf, sent.body, 200, note.id);
    return HttpResponse.json<ClinicalNote>(note);
  }),

  http.post('*/api/notes/:noteId/amendments', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'clinicalNote:write',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    const note = noteFor(tenantId, String(params.noteId), 'clinicalNote:write');
    if (!note) return noteNotFound();
    if (sent.replay) {
      const again = noteFor(tenantId, sent.replay.id, 'clinicalNote:write');
      return again ? HttpResponse.json<ClinicalNote>(again, { status: 201 }) : noteNotFound();
    }
    const body = sent.body;
    const document = isObject(body) ? documentOf(body.body) : null;
    const reason = isObject(body) ? reasonOf(body.reason) : null;
    if (!document || !reason) return error(400, 'validation_failed', 'The request is not valid');
    if (note.status !== 'signed') return error(409, 'note_not_signed', 'A draft is edited');
    if (state.encounters.find((each) => each.id === note.encounterId)?.status === 'cancelled') {
      return notOpen();
    }
    if (note.amendedById) return error(409, 'already_amended', 'Already amended');
    const at = now();
    const amendment: ClinicalNote = {
      id: nextId('note'),
      tenantId,
      encounterId: note.encounterId,
      patientId: note.patientId,
      status: 'signed',
      body: { ...document },
      authorId: caller().id,
      authorName: caller().name,
      createdAt: at,
      updatedAt: at,
      signedAt: at,
      amendsId: note.id,
      amendmentReason: reason,
      version: 1,
    };
    note.amendedById = amendment.id;
    state.notes.push(amendment);
    remember(sent.keyOf, body, 201, amendment.id);
    return HttpResponse.json<ClinicalNote>(amendment, { status: 201 });
  }),

  http.get('*/api/encounters/:encounterId/diagnoses', ({ request, params }) => {
    const access = authorize(request, { permission: 'diagnosis:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const found = encounterFor(access.tenantId, String(params.encounterId), 'diagnosis:read');
    if (!found) return notFound();
    const shown = state.diagnoses
      .filter((each) => each.encounterId === found.id)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));
    const result = page(shown, request);
    return 'refused' in result ? result.refused : HttpResponse.json<DiagnosisPage>(result.page);
  }),

  http.post('*/api/encounters/:encounterId/diagnoses', async ({ request, params }) => {
    const access = authorize(request, { permission: 'diagnosis:write', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    const found = encounterFor(tenantId, String(params.encounterId), 'diagnosis:write');
    if (!found) return notFound();
    if (sent.replay) {
      const again = state.diagnoses.find((each) => each.id === sent.replay?.id);
      return again
        ? HttpResponse.json<Diagnosis>(again, { status: 201 })
        : error(404, 'diagnosis_not_found', 'Diagnosis not found');
    }
    const body = sent.body;
    if (!isObject(body) || (body.kind !== 'provisional' && body.kind !== 'final')) {
      return error(400, 'validation_failed', 'kind is required');
    }
    const text =
      typeof body.text === 'string' && body.text.trim() !== '' ? body.text.trim() : undefined;
    if (text !== undefined && (text.length > TEXT_MAX || !PLAIN_TEXT.test(text))) {
      return error(400, 'validation_failed', 'Bad text');
    }
    const codeId = typeof body.codeId === 'string' ? body.codeId : undefined;
    if (!codeId && !text) return error(400, 'validation_failed', 'A code or text is required');
    if (found.status !== 'open') return notOpen();
    const code = codeId ? mockCode(codeId) : undefined;
    if (codeId && (!code || code.system !== 'icd10')) {
      return error(422, 'unknown_code', 'No such ICD-10 code');
    }
    const diagnosis: Diagnosis = {
      id: nextId('dx'),
      tenantId,
      encounterId: found.id,
      patientId: found.patientId,
      ...(code ? { codeId: code.id, code: code.code, codeTitle: code.title } : {}),
      ...(text ? { text } : {}),
      kind: body.kind,
      recordedAt: now(),
      recordedByName: caller().name,
    };
    state.diagnoses.push(diagnosis);
    remember(sent.keyOf, body, 201, diagnosis.id);
    return HttpResponse.json<Diagnosis>(diagnosis, { status: 201 });
  }),

  http.post('*/api/diagnoses/:diagnosisId/retract', async ({ request, params }) => {
    const access = authorize(request, { permission: 'diagnosis:write', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    const diagnosis = state.diagnoses.find(
      (each) => each.id === String(params.diagnosisId) && each.tenantId === tenantId,
    );
    if (!diagnosis || !encounterFor(tenantId, diagnosis.encounterId, 'diagnosis:write')) {
      return error(404, 'diagnosis_not_found', 'Diagnosis not found');
    }
    if (sent.replay) return HttpResponse.json<Diagnosis>(diagnosis);
    const reason = isObject(sent.body) ? reasonOf(sent.body.reason) : null;
    if (!reason) return error(400, 'validation_failed', 'A reason is required');
    if (diagnosis.retractedAt) return error(409, 'already_retracted', 'Already retracted');
    diagnosis.retractedAt = now();
    diagnosis.retractedByName = caller().name;
    diagnosis.retractionReason = reason;
    remember(sent.keyOf, sent.body, 200, diagnosis.id);
    return HttpResponse.json<Diagnosis>(diagnosis);
  }),

  http.get('*/api/encounters/:encounterId/prescriptions', ({ request, params }) => {
    const access = authorize(request, {
      permission: 'prescription:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const found = encounterFor(access.tenantId, String(params.encounterId), 'prescription:read');
    if (!found) return notFound();
    const shown = state.prescriptions
      .filter((each) => each.encounterId === found.id)
      .sort((a, b) => a.prescribedAt.localeCompare(b.prescribedAt) || a.id.localeCompare(b.id))
      .map(prescriptionView);
    const result = page(shown, request);
    return 'refused' in result ? result.refused : HttpResponse.json<PrescriptionPage>(result.page);
  }),

  http.get('*/api/prescriptions/:prescriptionId', ({ request, params }) => {
    const access = authorize(request, {
      permission: 'prescription:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const stored = state.prescriptions.find(
      (each) => each.id === String(params.prescriptionId) && each.tenantId === access.tenantId,
    );
    if (!stored || !encounterFor(access.tenantId, stored.encounterId, 'prescription:read')) {
      return prescriptionNotFound();
    }
    return HttpResponse.json<Prescription>(prescriptionView(stored));
  }),

  http.post('*/api/encounters/:encounterId/prescriptions', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'prescription:create',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    const found = encounterFor(tenantId, String(params.encounterId), 'prescription:create');
    if (!found) return notFound();
    if (sent.replay) {
      const again = state.prescriptions.find((each) => each.id === sent.replay?.id);
      return again
        ? HttpResponse.json<Prescription>(prescriptionView(again), { status: 201 })
        : prescriptionNotFound();
    }
    const body = sent.body;
    if (!isObject(body) || !Array.isArray(body.lines)) {
      return error(400, 'validation_failed', 'lines are required');
    }
    const lines = body.lines.map(lineOf);
    if (lines.length < 1 || lines.length > LINES_MAX || lines.includes(null)) {
      return error(400, 'validation_failed', '1 to 30 valid lines');
    }
    // Advice of spaces only is tidied to none, as the API does.
    const advice =
      typeof body.advice === 'string' && body.advice.trim() === ''
        ? undefined
        : plainOf(body.advice, ADVICE_MAX, PLAIN_LINES);
    if (advice === null) return error(400, 'validation_failed', 'Bad advice');
    const replacesId = typeof body.replacesId === 'string' ? body.replacesId : undefined;
    const reason = body.replaceReason === undefined ? undefined : reasonOf(body.replaceReason);
    if (reason === null || (replacesId !== undefined) !== (reason !== undefined)) {
      return error(400, 'validation_failed', 'A reason goes with replacesId, and only with it');
    }
    if (found.status !== 'open') return notOpen();
    const replaced = replacesId
      ? state.prescriptions.find((each) => each.id === replacesId && each.encounterId === found.id)
      : undefined;
    if (replacesId && !replaced) {
      return error(422, 'unknown_prescription', 'No such prescription in this encounter');
    }
    if (replaced && state.prescriptions.some((each) => each.replacesId === replaced.id)) {
      return error(409, 'already_replaced', 'This prescription was replaced');
    }
    const drugs = lines.map((each) => {
      const drug = each ? mockDrug(tenantId, each.drugId) : undefined;
      return drug && drug.type === 'medicine' && !drug.archived ? drug : undefined;
    });
    if (drugs.includes(undefined)) return error(422, 'unknown_drug', 'No such medicine');
    const who = caller();
    const at = now();
    const prescription: StoredPrescription = {
      id: nextId('rx'),
      tenantId,
      encounterId: found.id,
      patientId: found.patientId,
      prescribedAt: at,
      prescribedById: who.id,
      prescribedByName: who.name,
      ...(advice ? { advice } : {}),
      ...(replaced && reason ? { replacesId: replaced.id, replaceReason: reason } : {}),
    };
    state.prescriptions.push(prescription);
    lines.forEach((each, index) => {
      const drug = drugs[index];
      if (!each || !drug) return;
      state.orders.push({
        id: nextId('ord'),
        tenantId,
        encounterId: found.id,
        patientId: found.patientId,
        type: 'medication',
        drugId: drug.id,
        prescriptionId: prescription.id,
        lineNumber: index + 1,
        itemName: itemNameOf(drug),
        status: 'placed',
        priority: 'routine',
        dose: each.dose,
        route: each.route,
        frequency: each.frequency,
        ...(each.durationDays === undefined ? {} : { durationDays: each.durationDays }),
        ...(each.quantity === undefined ? {} : { quantity: each.quantity }),
        ...(each.instructions === undefined ? {} : { instructions: each.instructions }),
        placedAt: at,
        orderedById: who.id,
        orderedByName: who.name,
        version: 1,
      });
    });
    // The replaced one's lines not yet started are cancelled with the revision's reason.
    if (replaced && reason) {
      for (const order of state.orders) {
        if (
          order.prescriptionId === replaced.id &&
          (order.status === 'placed' || order.status === 'accepted')
        ) {
          order.status = 'cancelled';
          order.cancelReason = reason;
          order.statusChangedAt = at;
          order.version += 1;
        }
      }
    }
    remember(sent.keyOf, body, 201, prescription.id);
    return HttpResponse.json<Prescription>(prescriptionView(prescription), { status: 201 });
  }),

  // Orders (#82): the encounter's orders of every type or of one, placing one, cancelling one.
  http.get('*/api/encounters/:encounterId/orders', ({ request, params }) => {
    const access = authorize(request, { permission: 'order:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const found = encounterFor(access.tenantId, String(params.encounterId), 'order:read');
    if (!found) return notFound();
    const type = new URL(request.url).searchParams.get('type');
    if (type !== null && !ORDER_TYPES.includes(type as Order['type'])) {
      return error(400, 'validation_failed', 'Bad type');
    }
    const shown = state.orders
      .filter((each) => each.encounterId === found.id && (type === null || each.type === type))
      .sort((a, b) => a.placedAt.localeCompare(b.placedAt) || a.id.localeCompare(b.id));
    const result = page(shown, request);
    return 'refused' in result ? result.refused : HttpResponse.json<OrderPage>(result.page);
  }),

  http.post('*/api/encounters/:encounterId/orders', async ({ request, params }) => {
    const access = authorize(request, { permission: 'order:create', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    if (sent.replay) {
      const again = state.orders.find((each) => each.id === sent.replay?.id);
      return again
        ? HttpResponse.json<Order>(again, { status: 201 })
        : error(404, 'order_not_found', 'Order not found');
    }
    const body = sent.body;
    // Lab, imaging and procedure (#87); a diet order has no screen yet, so the mock refuses it.
    const type = isObject(body) ? body.type : undefined;
    if (!isObject(body) || (type !== 'lab' && type !== 'imaging' && type !== 'procedure')) {
      return error(400, 'validation_failed', 'A lab, imaging or procedure order is placed here');
    }
    const wants = type === 'lab' ? 'labTestId' : 'serviceId';
    const other = type === 'lab' ? 'serviceId' : 'labTestId';
    if (typeof body[wants] !== 'string' || body[other] !== undefined) {
      return error(400, 'validation_failed', `A ${type} order needs ${wants} only`);
    }
    const priority = body.priority ?? 'routine';
    if (!PRIORITIES.includes(priority as Order['priority'])) {
      return error(400, 'validation_failed', 'Bad priority');
    }
    const instructions =
      typeof body.instructions === 'string' && body.instructions.trim() === ''
        ? undefined
        : plainOf(body.instructions, INSTRUCTIONS_MAX, PLAIN_LINES);
    if (instructions === null) return error(400, 'validation_failed', 'Bad instructions');
    // The body is checked before the encounter is looked for, as the API does.
    const found = encounterFor(tenantId, String(params.encounterId), 'order:create');
    if (!found) return notFound();
    if (found.status !== 'open') return notOpen();
    const item =
      type === 'lab'
        ? mockOrderableLabTest(tenantId, String(body.labTestId))
        : mockOrderableService(tenantId, String(body.serviceId), type);
    if (!item) {
      return type === 'lab'
        ? error(422, 'unknown_lab_test', 'No such lab test')
        : error(422, 'unknown_service', `No such ${type} service`);
    }
    const who = caller();
    const order: Order = {
      id: nextId('ord'),
      tenantId,
      encounterId: found.id,
      patientId: found.patientId,
      type,
      ...(type === 'lab' ? { labTestId: item.id } : { serviceId: item.id }),
      itemCode: item.code,
      itemName: item.name,
      status: 'placed',
      priority: priority as Order['priority'],
      ...(instructions ? { instructions } : {}),
      placedAt: now(),
      orderedById: who.id,
      orderedByName: who.name,
      version: 1,
    };
    state.orders.push(order);
    remember(sent.keyOf, body, 201, order.id);
    return HttpResponse.json<Order>(order, { status: 201 });
  }),

  http.post('*/api/orders/:orderId/cancel', async ({ request, params }) => {
    const access = authorize(request, { permission: 'order:cancel', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    const order = state.orders.find(
      (each) => each.id === String(params.orderId) && each.tenantId === tenantId,
    );
    if (!order || !encounterFor(tenantId, order.encounterId, 'order:cancel')) {
      return error(404, 'order_not_found', 'Order not found');
    }
    if (sent.replay) return HttpResponse.json<Order>(order);
    const body = sent.body;
    const reason = isObject(body) ? reasonOf(body.reason) : null;
    if (!isObject(body) || !Number.isInteger(body.version) || !reason) {
      return error(400, 'validation_failed', 'A version and a reason are required');
    }
    if (body.version !== order.version) return error(409, 'conflict', 'Changed meanwhile');
    if (order.status !== 'placed' && order.status !== 'accepted') {
      return error(409, 'invalid_transition', `A ${order.status} order is not cancelled`);
    }
    order.status = 'cancelled';
    order.cancelReason = reason;
    order.statusChangedAt = now();
    order.version += 1;
    remember(sent.keyOf, body, 200, order.id);
    return HttpResponse.json<Order>(order);
  }),

  // Printing (#89): an audit entry per print, nothing else.
  http.post('*/api/encounters/:encounterId/print', async ({ request, params }) => {
    for (const permission of ['encounter:read', 'encounter:print']) {
      const access = authorize(request, { permission, featureFlag: FEATURE_FLAG });
      if ('denied' in access) return access.denied;
    }
    const access = { tenantId: currentPolicy()?.tenantId ?? '' };
    const sent = await idempotent(request, access.tenantId);
    if ('refused' in sent) return sent.refused;
    const id = String(params.encounterId);
    const found =
      encounterFor(access.tenantId, id, 'encounter:read') &&
      encounterFor(access.tenantId, id, 'encounter:print');
    if (!found) return notFound();
    if (found.status === 'cancelled') return notPrintable();
    if (!sent.replay) {
      state.prints.push({
        tenantId: access.tenantId,
        entity: 'encounter',
        id: found.id,
        userId: caller().id,
      });
      remember(sent.keyOf, sent.body, 204, found.id);
    }
    return new HttpResponse(null, { status: 204 });
  }),

  http.post('*/api/prescriptions/:prescriptionId/print', async ({ request, params }) => {
    for (const permission of ['prescription:read', 'encounter:print']) {
      const access = authorize(request, { permission, featureFlag: FEATURE_FLAG });
      if ('denied' in access) return access.denied;
    }
    const tenantId = currentPolicy()?.tenantId ?? '';
    const sent = await idempotent(request, tenantId);
    if ('refused' in sent) return sent.refused;
    const stored = state.prescriptions.find(
      (each) => each.id === String(params.prescriptionId) && each.tenantId === tenantId,
    );
    if (
      !stored ||
      !encounterFor(tenantId, stored.encounterId, 'prescription:read') ||
      !encounterFor(tenantId, stored.encounterId, 'encounter:print')
    ) {
      return prescriptionNotFound();
    }
    const replaced = state.prescriptions.some((each) => each.replacesId === stored.id);
    const lines = state.orders.filter((order) => order.prescriptionId === stored.id);
    if (replaced || lines.every((order) => order.status === 'cancelled')) return notPrintable();
    if (!sent.replay) {
      state.prints.push({ tenantId, entity: 'prescription', id: stored.id, userId: caller().id });
      remember(sent.keyOf, sent.body, 204, stored.id);
    }
    return new HttpResponse(null, { status: 204 });
  }),
];

/** An encounter as the mock holds it now, for tests. */
export const mockEncounter = (id: string) => state.encounters.find((each) => each.id === id);

/**
 * Adds `count` closed encounters of a patient, a day apart before the seed's, for tests of a
 * long history. Their ids are `enc_past_<n>`, the newest first.
 */
export function addPastMockEncounters(
  tenantId: string,
  patientId: string,
  doctorId: string,
  count: number,
): void {
  for (let n = 1; n <= count; n += 1) {
    state.encounters.push({
      id: `enc_past_${n}`,
      tenantId,
      patientId,
      status: 'closed',
      doctorId,
      openedAt: minutesAgo((n + 2) * 24 * 60),
      openedByName: 'Sample Admin',
      endedAt: minutesAgo((n + 2) * 24 * 60 - 20),
      endedByName: 'Sample Admin',
      version: 2,
    });
  }
}

/** The notes of an encounter as the mock holds them (every author's drafts included), for tests. */
export const mockNotesOf = (encounterId: string): readonly ClinicalNote[] =>
  state.notes.filter((note) => note.encounterId === encounterId);

/** Saves a draft behind the screen, as another window of its author would. */
export function editMockNote(id: string, text: string): void {
  const note = state.notes.find((each) => each.id === id);
  if (!note) return;
  note.body = doc(text);
  note.version += 1;
  note.updatedAt = now();
}

/** The prescriptions of an encounter as the API answers them, for tests. */
export const mockPrescriptionsOf = (encounterId: string): Prescription[] =>
  state.prescriptions.filter((each) => each.encounterId === encounterId).map(prescriptionView);

/** The orders of an encounter as the mock holds them, for tests. */
export const mockOrdersOf = (encounterId: string): readonly Order[] =>
  state.orders.filter((each) => each.encounterId === encounterId);

/** Moves an order on behind the screen, as the pharmacy or the laboratory would. */
export function moveMockOrder(id: string, status: Order['status']): void {
  const order = state.orders.find((each) => each.id === id);
  if (!order) return;
  order.status = status;
  order.statusChangedAt = now();
  order.version += 1;
}

/** What the mock recorded as printed, as the API's audit log would, for tests. */
export const mockPrints = (): readonly MockPrint[] => state.prints;
