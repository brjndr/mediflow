import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { Permission } from '../../core/access/registry.js';
import { HttpError } from '../../core/http/errors.js';
import { isEmptyRichText, sanitizeRichText } from '../../core/http/rich-text.js';
import {
  CursorPage,
  DEFAULT_PAGE_SIZE,
  errors,
  MAX_PAGE_SIZE,
  ref,
  StringEnum,
} from '../../core/http/schemas.js';
import { PLAIN_LINES, PLAIN_TEXT, tidy, tidyLines, tidyWithin } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { patientFamily } from '../../core/patient-merge/family.js';
import { patientInScope } from '../patients/index.js';
import { isTemplateVersion, placeholdersIn } from '../templates/index.js';
import { CERTIFICATE_KINDS, STANDARD_FIELDS, type FieldDef } from './certificate-fields.js';
import { certificatePdf, consentPdf, contextOf, keepRendered } from './rendered.js';
import { PatientDocument } from './schemas.js';

/**
 * Signed consents and issued certificates (MR-02, #566), the API behind the patient's Consents
 * tab. Both are append-only: no update, no delete, a mistake is a new record. A consent keeps the
 * text it was signed with and the template version; a certificate keeps the layout it was issued
 * under, and is numbered by the server in order for each kind and year.
 */
const FEATURE = 'consents';
const CONSENT_READ = 'consent:read';
const CONSENT_SIGN = 'consent:sign';
const CONSENT_WITHDRAW = 'consent:withdraw';
const CERT_READ = 'certificate:read';
const CERT_ISSUE = 'certificate:issue';
const CERT_CONFIGURE = 'certificate:configure';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const FIELD_NAME = '^[a-z][A-Za-z0-9]{0,39}$';
const FIELD_VALUE_MAX = 500;
const PREFIX = { medical: 'MED', fitness: 'FIT', birth: 'BIR', death: 'DTH' } as const;

const Id = Type.String({ format: 'uuid' });
const named = <const Values extends readonly [string, ...string[]]>($id: string, values: Values) =>
  Type.Unsafe<Values[number]>({ $id, type: 'string', enum: [...values] });
export const ConsentSigner = named('ConsentSigner', ['patient', 'guardian', 'representative']);
export const ConsentSignature = named('ConsentSignature', ['drawn', 'typed']);
export const CertificateKind = named('CertificateKind', CERTIFICATE_KINDS);
const Signer = ref(ConsentSigner);
const SignatureMethod = ref(ConsentSignature);
const Kind = ref(CertificateKind);

const RichText = (description: string) =>
  Type.Unsafe<Record<string, unknown>>({
    type: 'object',
    additionalProperties: true,
    description: `${description} The rich text document of the app, never HTML, reduced to its allowlist on the way in.`,
  });

export const Consent = Type.Object(
  {
    id: Type.String(),
    patientId: Type.String(),
    procedureName: Type.String(),
    templateId: Type.String(),
    templateVersion: Type.Integer(),
    signerName: Type.String(),
    signerRole: Signer,
    signatureMethod: SignatureMethod,
    signedAt: Type.String({ format: 'date-time' }),
    signedByName: Type.String({ description: 'The member of staff who recorded the signature.' }),
    withdrawnAt: Type.Optional(
      Type.String({
        format: 'date-time',
        description: 'When the consent was withdrawn; absent while it stands.',
      }),
    ),
    witnessCount: Type.Integer({ description: 'How many witness signatures it has.' }),
    encounterId: Type.Optional(
      Type.String({ description: 'The encounter it was signed for, when one was named.' }),
    ),
  },
  { $id: 'Consent', description: 'A signed consent, without its text and signature.' },
);
export const ConsentWitness = Type.Object(
  {
    id: Type.String(),
    witnessName: Type.String(),
    relation: Type.Optional(Type.String()),
    signatureMethod: SignatureMethod,
    signature: Type.Optional(Type.String({ description: 'SVG path data of a drawn signature.' })),
    recordedAt: Type.String({ format: 'date-time' }),
    recordedByName: Type.String(),
  },
  { $id: 'ConsentWitness', description: 'A witness signature added to a signed consent.' },
);
export const ConsentWithdrawal = Type.Object(
  {
    reason: Type.String(),
    withdrawnAt: Type.String({ format: 'date-time' }),
    withdrawnByName: Type.String(),
  },
  { $id: 'ConsentWithdrawal', description: 'Why, when and by whom a consent was withdrawn.' },
);
export const ConsentWitnessCreate = Type.Object(
  {
    witnessName: Type.String({ minLength: 1, maxLength: 200, pattern: PLAIN_TEXT }),
    relation: Type.Optional(Type.String({ minLength: 1, maxLength: 100, pattern: PLAIN_TEXT })),
    signatureMethod: SignatureMethod,
    signature: Type.Optional(
      Type.String({ minLength: 1, maxLength: 20000, pattern: '^[ML0-9 .,-]+$' }),
    ),
  },
  { $id: 'ConsentWitnessCreate', additionalProperties: false },
);
type ConsentWitnessCreate = Static<typeof ConsentWitnessCreate>;
export const ConsentWithdraw = Type.Object(
  { reason: Type.String({ minLength: 1, maxLength: 500, pattern: PLAIN_LINES }) },
  { $id: 'ConsentWithdraw', additionalProperties: false },
);
type ConsentWithdraw = Static<typeof ConsentWithdraw>;
export const ConsentDetail = Type.Object(
  {
    consent: ref(Consent),
    witnesses: Type.Array(ref(ConsentWitness)),
    withdrawal: Type.Optional(ref(ConsentWithdrawal)),
    body: RichText('The text as it was signed, placeholders filled in.'),
    signature: Type.Optional(
      Type.String({
        description: 'SVG path data of a drawn signature in a 300 by 150 box; absent when typed.',
      }),
    ),
  },
  { $id: 'ConsentDetail' },
);
export const ConsentPage = CursorPage(ref(Consent), { $id: 'ConsentPage' });
export const ConsentCreate = Type.Object(
  {
    templateId: Id,
    templateVersion: Type.Integer({ minimum: 1 }),
    procedureName: Type.String({ minLength: 1, maxLength: 200, pattern: PLAIN_TEXT }),
    encounterId: Type.Optional(Id),
    body: RichText('The text signed, placeholders filled in.'),
    signerName: Type.String({ minLength: 1, maxLength: 200, pattern: PLAIN_TEXT }),
    signerRole: Signer,
    signatureMethod: SignatureMethod,
    signature: Type.Optional(
      Type.String({ minLength: 1, maxLength: 20000, pattern: '^[ML0-9 .,-]+$' }),
    ),
  },
  { $id: 'ConsentCreate', additionalProperties: false },
);
type ConsentCreate = Static<typeof ConsentCreate>;

export const CertificateFieldDef = Type.Object(
  {
    name: Type.String({ pattern: FIELD_NAME }),
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 100, pattern: PLAIN_TEXT })),
    type: StringEnum(['text', 'date', 'time', 'lines', 'select']),
    required: Type.Boolean(),
    options: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 100, pattern: PLAIN_TEXT }), {
        maxItems: 20,
      }),
    ),
  },
  {
    $id: 'CertificateFieldDef',
    additionalProperties: false,
    description:
      'One field of a certificate format. The name is the key the value is stored under; a label of a standard field is left out and the screen uses its own.',
  },
);
export const Certificate = Type.Object(
  {
    id: Type.String(),
    patientId: Type.String(),
    kind: Kind,
    number: Type.String({
      description: 'Assigned by the server, in order for each kind and year.',
    }),
    issuedOn: Type.String({ format: 'date' }),
    fields: Type.Record(Type.String(), Type.String()),
    issuedByName: Type.String(),
    issuedAt: Type.String({ format: 'date-time' }),
    layout: Type.Array(ref(CertificateFieldDef), {
      description: 'The fields of the format it was issued under, kept with it.',
    }),
  },
  { $id: 'Certificate' },
);
export const CertificatePage = CursorPage(ref(Certificate), { $id: 'CertificatePage' });
export const CertificateCreate = Type.Object(
  {
    kind: Kind,
    issuedOn: Type.String({ format: 'date' }),
    fields: Type.Unsafe<Record<string, unknown>>({
      type: 'object',
      additionalProperties: true,
      description: 'What was entered, by the field names of the kind.',
    }),
  },
  { $id: 'CertificateCreate', additionalProperties: false },
);
type CertificateCreate = Static<typeof CertificateCreate>;
export const CertificateFormat = Type.Object(
  {
    kind: Kind,
    fields: Type.Array(ref(CertificateFieldDef)),
    custom: Type.Boolean({
      description: 'True once the hospital has changed the standard fields of the kind.',
    }),
  },
  { $id: 'CertificateFormat' },
);
export const CertificateFormatList = Type.Object(
  { items: Type.Array(ref(CertificateFormat)) },
  { $id: 'CertificateFormatList' },
);
export const CertificateFormatUpdate = Type.Object(
  { fields: Type.Array(ref(CertificateFieldDef), { minItems: 1, maxItems: 30 }) },
  { $id: 'CertificateFormatUpdate', additionalProperties: false },
);
type CertificateFormatUpdate = Static<typeof CertificateFormatUpdate>;

export const CONSENT_SCHEMAS = [
  ConsentSigner,
  ConsentSignature,
  CertificateKind,
  Consent,
  ConsentDetail,
  ConsentPage,
  ConsentCreate,
  ConsentWitness,
  ConsentWithdrawal,
  ConsentWitnessCreate,
  ConsentWithdraw,
  CertificateFieldDef,
  Certificate,
  CertificatePage,
  CertificateCreate,
  CertificateFormat,
  CertificateFormatList,
  CertificateFormatUpdate,
] as const;

const ListQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
});
type ListQuery = Static<typeof ListQuery>;
const PatientParams = Type.Object({ patientId: Id });
const ConsentParams = Type.Object({ consentId: Id });
const KindParams = Type.Object({ kind: Kind });
const CertificateParams = Type.Object({ certificateId: Id });

interface ConsentRow {
  id: string;
  patient_id: string;
  procedure_name: string;
  template_id: string;
  template_version: number;
  signer_name: string;
  signer_role: 'patient' | 'guardian' | 'representative';
  signature_method: 'drawn' | 'typed';
  body: Record<string, unknown>;
  signature: string | null;
  signed_at: Date;
  signed_by_name: string | null;
  withdrawn_at: Date | null;
  witness_count: number;
  encounter_id: string | null;
}
interface WitnessRow {
  id: string;
  witness_name: string;
  witness_relation: string | null;
  signature_method: 'drawn' | 'typed';
  signature: string | null;
  recorded_at: Date;
  recorded_by_name: string | null;
}
interface WithdrawalRow {
  reason: string;
  withdrawn_at: Date;
  withdrawn_by_name: string | null;
}
const CONSENT_SELECT = `select c.id, c.patient_id, c.procedure_name, c.template_id, c.template_version, c.encounter_id,
  c.signer_name, c.signer_role, c.signature_method, c.body, c.signature, c.signed_at,
  u.name as signed_by_name,
  (select w.withdrawn_at from consent_withdrawals w where w.consent_id = c.id) as withdrawn_at,
  (select count(*)::int from consent_witnesses n where n.consent_id = c.id) as witness_count
  from patient_consents c left join users u on u.id = c.signed_by`;

const consentView = (row: ConsentRow) => ({
  id: row.id,
  patientId: row.patient_id,
  procedureName: row.procedure_name,
  templateId: row.template_id,
  templateVersion: row.template_version,
  signerName: row.signer_name,
  signerRole: row.signer_role,
  signatureMethod: row.signature_method,
  signedAt: row.signed_at.toISOString(),
  signedByName: row.signed_by_name ?? '',
  ...(row.withdrawn_at ? { withdrawnAt: row.withdrawn_at.toISOString() } : {}),
  witnessCount: row.witness_count,
  ...(row.encounter_id ? { encounterId: row.encounter_id } : {}),
});
const consentDetail = (
  row: ConsentRow,
  witnesses: WitnessRow[] = [],
  withdrawal?: WithdrawalRow,
) => ({
  consent: consentView(row),
  body: row.body,
  ...(row.signature ? { signature: row.signature } : {}),
  witnesses: witnesses.map((w) => ({
    id: w.id,
    witnessName: w.witness_name,
    ...(w.witness_relation ? { relation: w.witness_relation } : {}),
    signatureMethod: w.signature_method,
    ...(w.signature ? { signature: w.signature } : {}),
    recordedAt: w.recorded_at.toISOString(),
    recordedByName: w.recorded_by_name ?? '',
  })),
  ...(withdrawal
    ? {
        withdrawal: {
          reason: withdrawal.reason,
          withdrawnAt: withdrawal.withdrawn_at.toISOString(),
          withdrawnByName: withdrawal.withdrawn_by_name ?? '',
        },
      }
    : {}),
});

interface CertificateRow {
  id: string;
  patient_id: string;
  kind: (typeof CERTIFICATE_KINDS)[number];
  number: string;
  issued_on: string;
  fields: Record<string, string>;
  layout: FieldDef[];
  issued_at: Date;
  issued_by_name: string | null;
}
const CERTIFICATE_SELECT = `select c.id, c.patient_id, c.kind, c.number, c.issued_on::text as issued_on,
  c.fields, c.layout, c.issued_at, u.name as issued_by_name
  from patient_certificates c left join users u on u.id = c.issued_by`;
const certificateView = (row: CertificateRow) => ({
  id: row.id,
  patientId: row.patient_id,
  kind: row.kind,
  number: row.number,
  issuedOn: row.issued_on,
  fields: row.fields,
  issuedByName: row.issued_by_name ?? '',
  issuedAt: row.issued_at.toISOString(),
  layout: row.layout,
});

const encodeCursor = (at: Date, id: string) =>
  Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
function decodeCursor(cursor: string): { at: string; id: string } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!at || Number.isNaN(Date.parse(at)) || !id || !UUID.test(id)) {
    throw new HttpError(400, 'invalid_cursor', 'The cursor does not belong to this list');
  }
  return { at, id };
}

/** Checks what was entered against the fields of the format; returns it tidied. */
export function checkFields(
  layout: readonly FieldDef[],
  entered: Record<string, unknown>,
): Record<string, string> {
  const bad = (message: string) => new HttpError(422, 'certificate_fields_invalid', message);
  const known = new Map(layout.map((field) => [field.name, field]));
  for (const [name, entry] of Object.entries(entered)) {
    if (typeof entry !== 'string' || entry.length > 4000) throw bad('A field is not text');
    if (!known.has(name)) throw bad('A field is not part of this certificate');
  }
  const kept: Record<string, string> = {};
  for (const field of layout) {
    const raw = (entered[field.name] as string | undefined) ?? '';
    const value = field.type === 'lines' ? tidyLines(raw) : tidy(raw);
    if (value === '') {
      if (field.required) throw bad('A required field is empty');
      continue;
    }
    if ([...value].length > FIELD_VALUE_MAX) throw bad('A field is too long');
    if (!new RegExp(field.type === 'lines' ? PLAIN_LINES : PLAIN_TEXT, 'u').test(value)) {
      throw bad('A field has characters that cannot be printed');
    }
    if (field.type === 'date' && !(DATE.test(value) && !Number.isNaN(Date.parse(value)))) {
      throw bad('A date is not valid');
    }
    if (field.type === 'time' && !TIME.test(value)) throw bad('A time is not valid');
    if (field.type === 'select' && !(field.options ?? []).includes(value)) {
      throw bad('A choice is not one of the options');
    }
    kept[field.name] = value;
  }
  // The medical certificate's rest runs forwards, when the hospital keeps both dates.
  const { restFrom, restTo } = kept;
  if (restFrom && restTo && restTo < restFrom) throw bad('The rest cannot end before it starts');
  return kept;
}

/** The fields of a format as they are kept: names once, a choice field has its options. */
function checkFormat(fields: CertificateFormatUpdate['fields']): FieldDef[] {
  const bad = (message: string) => new HttpError(422, 'certificate_format_invalid', message);
  const names = new Set<string>();
  return fields.map((field) => {
    if (names.has(field.name)) throw bad('A field name is used twice');
    names.add(field.name);
    const options = field.options?.map((option) => tidyWithin(option, 100)) ?? [];
    if (field.type === 'select') {
      if (options.length === 0 || options.some((option) => option === '')) {
        throw bad('A choice field needs options');
      }
      if (new Set(options).size !== options.length) throw bad('An option is given twice');
    } else if (options.length > 0) {
      throw bad('Only a choice field has options');
    }
    const label = field.label === undefined ? undefined : tidyWithin(field.label, 100);
    if (field.label !== undefined && !label) throw bad('A label is empty');
    return {
      name: field.name,
      ...(label ? { label } : {}),
      type: field.type,
      required: field.required,
      ...(field.type === 'select' ? { options } : {}),
    };
  });
}

export const consentRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of CONSENT_SCHEMAS) app.addSchema(schema);
  app.addSchema(PatientDocument);

  const userIdOf = (request: FastifyRequest): string => {
    const userId = request.session?.userId;
    if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
    return userId;
  };

  async function reachable(request: FastifyRequest, patientId: string, permission: Permission) {
    const inScope = await patientInScope(request.txClient, patientId, {
      scope: request.access.scope(permission),
      userId: userIdOf(request),
    });
    if (!inScope) throw new HttpError(404, 'not_found', 'No such patient');
  }

  /** One consent with its witnesses and withdrawal, or undefined. */
  async function loadConsent(request: FastifyRequest, id: string) {
    const { rows } = await request.txClient.query<ConsentRow>(`${CONSENT_SELECT} where c.id = $1`, [
      id,
    ]);
    const row = rows[0];
    if (!row) return undefined;
    const witnesses = await request.txClient.query<WitnessRow>(
      `select w.id, w.witness_name, w.witness_relation, w.signature_method, w.signature,
         w.recorded_at, u.name as recorded_by_name
         from consent_witnesses w left join users u on u.id = w.recorded_by
         where w.consent_id = $1 order by w.recorded_at, w.id`,
      [id],
    );
    const withdrawal = await request.txClient.query<WithdrawalRow>(
      `select w.reason, w.withdrawn_at, u.name as withdrawn_by_name
         from consent_withdrawals w left join users u on u.id = w.withdrawn_by
         where w.consent_id = $1`,
      [id],
    );
    return { row, detail: consentDetail(row, witnesses.rows, withdrawal.rows[0]) };
  }

  /** A hospital's fields for a kind: its own, or the standard ones. */
  async function formatOf(request: FastifyRequest, kind: (typeof CERTIFICATE_KINDS)[number]) {
    const { rows } = await request.txClient.query<{ fields: FieldDef[] }>(
      'select fields from certificate_formats where kind = $1',
      [kind],
    );
    const own = rows[0]?.fields;
    return { fields: own ?? STANDARD_FIELDS[kind].map((field) => ({ ...field })), custom: !!own };
  }

  // Consents ---------------------------------------------------------------------------------

  app.get(
    '/patients/:patientId/consents',
    {
      config: { permissions: [CONSENT_READ], feature: FEATURE },
      schema: {
        operationId: 'listConsents',
        tags: ['consents'],
        description:
          'Signed consents of one patient, newest first, one cursor page at a time, including those of records merged into it (MR-02, #566). The text and signature are in the single read. Each consent listed is audited as read. Requires consent:read.',
        params: PatientParams,
        querystring: ListQuery,
        response: { 200: ref(ConsentPage), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      const { patientId } = request.params;
      const query = request.query as ListQuery;
      const limit = query.limit ?? DEFAULT_PAGE_SIZE;
      await reachable(request, patientId, CONSENT_READ);
      const params: unknown[] = [await patientFamily(request.txClient, patientId)];
      let where = 'c.patient_id = any($1::uuid[])';
      if (query.cursor) {
        const at = decodeCursor(query.cursor);
        params.push(at.at, at.id);
        where += ' and (c.signed_at, c.id) < ($2::timestamptz, $3::uuid)';
      }
      params.push(limit + 1);
      const { rows } = await request.txClient.query<ConsentRow>(
        `${CONSENT_SELECT} where ${where} order by c.signed_at desc, c.id desc limit $${params.length}`,
        params,
      );
      const page = rows.slice(0, limit);
      for (const row of page) request.audit('read', 'patient_consent', row.id);
      const last = page[page.length - 1];
      return {
        items: page.map(consentView),
        nextCursor: rows.length > limit && last ? encodeCursor(last.signed_at, last.id) : null,
      };
    },
  );

  app.get(
    '/consents/:consentId',
    {
      config: { permissions: [CONSENT_READ], feature: FEATURE },
      schema: {
        operationId: 'getConsent',
        tags: ['consents'],
        description:
          'One signed consent with its text and signature, audited as a read of the patient record (MR-02, #566). Another hospital’s, an out-of-scope or an unknown id is the same 404. Requires consent:read.',
        params: ConsentParams,
        response: { 200: ref(ConsentDetail), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      const loaded = await loadConsent(request, request.params.consentId);
      const row = loaded?.row;
      if (!row) throw new HttpError(404, 'not_found', 'No such consent');
      try {
        await reachable(request, row.patient_id, CONSENT_READ);
      } catch {
        throw new HttpError(404, 'not_found', 'No such consent');
      }
      request.audit('read', 'patient_consent', row.id);
      return loaded.detail;
    },
  );

  app.post(
    '/patients/:patientId/consents',
    {
      config: {
        permissions: [CONSENT_SIGN],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'signConsent',
        tags: ['consents'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Records a signed consent (MR-02, #566): the text as filled in from a saved version of a consent template (422 `template_not_found` otherwise; 422 `placeholders_unfilled` while it still holds a `{{placeholder}}`), who signed and how. A drawn signature needs path data and a typed one has none (422 `signature_invalid`). An optional `encounterId` must be an encounter of the patient (422 `encounter_mismatch`); the records desk reads it. A signed consent is never changed or removed: there is no update or delete. 409 `patient_merged` for a merged record. Requires consent:sign.',
        params: PatientParams,
        body: ref(ConsentCreate),
        response: { 201: ref(ConsentDetail), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as ConsentCreate;
      const userId = userIdOf(request);
      const { patientId } = request.params;
      await reachable(request, patientId, CONSENT_SIGN);
      if (request.replayOf !== null) {
        const again = request.idempotentId
          ? await request.txClient.query<ConsentRow>(`${CONSENT_SELECT} where c.id = $1`, [
              request.idempotentId,
            ])
          : null;
        const row = again?.rows[0];
        if (!row) throw new HttpError(404, 'not_found', 'No such consent');
        return reply.status(201).send(consentDetail(row));
      }
      const procedureName = tidyWithin(body.procedureName, 200);
      const signerName = tidyWithin(body.signerName, 200);
      if (!procedureName || !signerName) {
        throw new HttpError(400, 'validation_failed', 'Name the procedure and the signer');
      }
      const text = sanitizeRichText(body.body);
      if (isEmptyRichText(text)) {
        throw new HttpError(400, 'validation_failed', 'The consent text is empty');
      }
      if (placeholdersIn(text).length > 0) {
        throw new HttpError(422, 'placeholders_unfilled', 'The text still has placeholders');
      }
      if ((body.signatureMethod === 'drawn') !== (body.signature !== undefined)) {
        throw new HttpError(422, 'signature_invalid', 'The signature does not match its method');
      }
      const known = await isTemplateVersion(
        request.txClient,
        { templateId: body.templateId, version: body.templateVersion, kind: 'consent' },
        { archivedToo: true },
      );
      if (!known) {
        throw new HttpError(422, 'template_not_found', 'That is not a consent template version');
      }
      if (body.encounterId) {
        const { rowCount } = await request.txClient.query(
          'select 1 from encounters where id = $1 and patient_id = $2',
          [body.encounterId, patientId],
        );
        if (rowCount !== 1) {
          throw new HttpError(422, 'encounter_mismatch', 'The encounter is not this patient’s');
        }
      }
      const { rows } = await request.txClient.query<{ id: string }>(
        `insert into patient_consents (tenant_id, patient_id, procedure_name, template_id,
           template_version, body, signer_name, signer_role, signature_method, signature, signed_by,
           encounter_id)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
        [
          patientId,
          procedureName,
          body.templateId,
          body.templateVersion,
          JSON.stringify(text),
          signerName,
          body.signerRole,
          body.signatureMethod,
          body.signature ?? null,
          userId,
          body.encounterId ?? null,
        ],
      );
      const id = rows[0]!.id;
      request.idempotentId = id;
      request.audit('create', 'patient_consent', id);
      await request.emit('consent.signed', id, { patientId });
      const created = await request.txClient.query<ConsentRow>(
        `${CONSENT_SELECT} where c.id = $1`,
        [id],
      );
      return reply.status(201).send(consentDetail(created.rows[0]!));
    },
  );

  /** A consent the caller may act on, or the one 404 an unknown or out-of-scope one gets. */
  async function actableConsent(
    request: FastifyRequest,
    consentId: string,
    permission: Permission,
  ) {
    const loaded = await loadConsent(request, consentId);
    if (!loaded) throw new HttpError(404, 'not_found', 'No such consent');
    try {
      await reachable(request, loaded.row.patient_id, permission);
    } catch {
      throw new HttpError(404, 'not_found', 'No such consent');
    }
    return loaded.row;
  }

  app.post(
    '/consents/:consentId/witnesses',
    {
      config: {
        permissions: [CONSENT_SIGN],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'witnessConsent',
        tags: ['consents'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Adds a witness signature to a signed consent (MR-09, #989) as a new entry with its author and time; the signed consent is not changed. A drawn signature needs path data and a typed one has none (422 `signature_invalid`). 409 `consent_withdrawn` once the consent was withdrawn, 409 `patient_merged` for a merged record. Emits consent.witnessed. Requires consent:sign.',
        params: ConsentParams,
        body: ref(ConsentWitnessCreate),
        response: { 201: ref(ConsentDetail), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as ConsentWitnessCreate;
      const userId = userIdOf(request);
      const { consentId } = request.params;
      const consentRow = await actableConsent(request, consentId, CONSENT_SIGN);
      if (request.replayOf !== null) {
        return reply.status(201).send((await loadConsent(request, consentId))!.detail);
      }
      if (consentRow.withdrawn_at) {
        throw new HttpError(409, 'consent_withdrawn', 'This consent was withdrawn');
      }
      const witnessName = tidyWithin(body.witnessName, 200);
      const relation = body.relation ? tidyWithin(body.relation, 100) : null;
      if (!witnessName) throw new HttpError(400, 'validation_failed', 'Name the witness');
      if ((body.signatureMethod === 'drawn') !== (body.signature !== undefined)) {
        throw new HttpError(422, 'signature_invalid', 'The signature does not match its method');
      }
      const { rows } = await request.txClient.query<{ id: string }>(
        `insert into consent_witnesses (tenant_id, consent_id, patient_id, witness_name,
           witness_relation, signature_method, signature, recorded_by)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7) returning id`,
        [
          consentId,
          consentRow.patient_id,
          witnessName,
          relation,
          body.signatureMethod,
          body.signature ?? null,
          userId,
        ],
      );
      const id = rows[0]!.id;
      request.idempotentId = id;
      request.audit('create', 'consent_witness', id);
      await request.emit('consent.witnessed', consentId, { patientId: consentRow.patient_id });
      return reply.status(201).send((await loadConsent(request, consentId))!.detail);
    },
  );

  app.post(
    '/consents/:consentId/withdraw',
    {
      config: {
        permissions: [CONSENT_WITHDRAW],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'withdrawConsent',
        tags: ['consents'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Withdraws a signed consent with a reason (MR-09, #989), once: a new entry with its author and time, the signed text stays as it was. 409 `already_withdrawn` the second time, 409 `patient_merged` for a merged record. Emits consent.withdrawn. Requires consent:withdraw, a separate grant from consent:sign.',
        params: ConsentParams,
        body: ref(ConsentWithdraw),
        response: { 200: ref(ConsentDetail), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as ConsentWithdraw;
      const userId = userIdOf(request);
      const { consentId } = request.params;
      const consentRow = await actableConsent(request, consentId, CONSENT_WITHDRAW);
      if (request.replayOf !== null) return (await loadConsent(request, consentId))!.detail;
      if (consentRow.withdrawn_at) {
        throw new HttpError(409, 'already_withdrawn', 'This consent was already withdrawn');
      }
      const reason = tidyLines(body.reason);
      if (!reason) throw new HttpError(400, 'validation_failed', 'Give a reason');
      const { rows } = await request.txClient.query<{ id: string }>(
        `insert into consent_withdrawals (tenant_id, consent_id, patient_id, reason, withdrawn_by)
         values (app_tenant_id(), $1, $2, $3, $4) returning id`,
        [consentId, consentRow.patient_id, reason, userId],
      );
      const id = rows[0]!.id;
      request.idempotentId = id;
      request.audit('create', 'consent_withdrawal', id);
      await request.emit('consent.withdrawn', consentId, { patientId: consentRow.patient_id });
      return (await loadConsent(request, consentId))!.detail;
    },
  );

  // Certificates -----------------------------------------------------------------------------

  app.get(
    '/patients/:patientId/certificates',
    {
      config: { permissions: [CERT_READ], feature: FEATURE },
      schema: {
        operationId: 'listCertificates',
        tags: ['consents'],
        description:
          'Certificates issued for one patient, newest first, one cursor page at a time, including those of records merged into it (MR-02, #566). Each is audited as read. Requires certificate:read.',
        params: PatientParams,
        querystring: ListQuery,
        response: { 200: ref(CertificatePage), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      const { patientId } = request.params;
      const query = request.query as ListQuery;
      const limit = query.limit ?? DEFAULT_PAGE_SIZE;
      await reachable(request, patientId, CERT_READ);
      const params: unknown[] = [await patientFamily(request.txClient, patientId)];
      let where = 'c.patient_id = any($1::uuid[])';
      if (query.cursor) {
        const at = decodeCursor(query.cursor);
        params.push(at.at, at.id);
        where += ' and (c.issued_at, c.id) < ($2::timestamptz, $3::uuid)';
      }
      params.push(limit + 1);
      const { rows } = await request.txClient.query<CertificateRow>(
        `${CERTIFICATE_SELECT} where ${where} order by c.issued_at desc, c.id desc limit $${params.length}`,
        params,
      );
      const page = rows.slice(0, limit);
      for (const row of page) request.audit('read', 'patient_certificate', row.id);
      const last = page[page.length - 1];
      return {
        items: page.map(certificateView),
        nextCursor: rows.length > limit && last ? encodeCursor(last.issued_at, last.id) : null,
      };
    },
  );

  app.post(
    '/patients/:patientId/certificates',
    {
      config: {
        permissions: [CERT_ISSUE],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'issueCertificate',
        tags: ['consents'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Records a medical, fitness, birth or death certificate from the data entered, which must fit the hospital’s fields for the kind: no other field, none required left empty, each of its type (422 `certificate_fields_invalid`). The server numbers it in order for each kind and year, and keeps the layout it was issued under. Never changed or removed. 409 `patient_merged` for a merged record. Requires certificate:issue.',
        params: PatientParams,
        body: ref(CertificateCreate),
        response: { 201: ref(Certificate), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as CertificateCreate;
      const userId = userIdOf(request);
      const { patientId } = request.params;
      await reachable(request, patientId, CERT_ISSUE);
      if (request.replayOf !== null) {
        const again = request.idempotentId
          ? await request.txClient.query<CertificateRow>(`${CERTIFICATE_SELECT} where c.id = $1`, [
              request.idempotentId,
            ])
          : null;
        const row = again?.rows[0];
        if (!row) throw new HttpError(404, 'not_found', 'No such certificate');
        return reply.status(201).send(certificateView(row));
      }
      if (!DATE.test(body.issuedOn) || Number.isNaN(Date.parse(body.issuedOn))) {
        throw new HttpError(400, 'validation_failed', 'The date is not valid');
      }
      const { fields: layout } = await formatOf(request, body.kind);
      const kept = checkFields(layout, body.fields);
      const year = Number(body.issuedOn.slice(0, 4));
      // The counter row stays locked until the transaction ends, so two certificates of one kind
      // and year never take the same number.
      const counted = await request.txClient.query<{ last_number: number }>(
        `insert into certificate_counters (tenant_id, kind, year, last_number)
         values (app_tenant_id(), $1, $2, 1)
         on conflict (tenant_id, kind, year) do update
           set last_number = certificate_counters.last_number + 1
         returning last_number`,
        [body.kind, year],
      );
      const serial = String(counted.rows[0]!.last_number).padStart(4, '0');
      const { rows } = await request.txClient.query<{ id: string }>(
        `insert into patient_certificates (tenant_id, patient_id, kind, number, issued_on, fields,
           layout, issued_by)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7) returning id`,
        [
          patientId,
          body.kind,
          `${PREFIX[body.kind]}-${year}-${serial}`,
          body.issuedOn,
          JSON.stringify(kept),
          JSON.stringify(layout),
          userId,
        ],
      );
      const id = rows[0]!.id;
      request.idempotentId = id;
      request.audit('create', 'patient_certificate', id);
      await request.emit('certificate.issued', id, { patientId, kind: body.kind });
      const created = await request.txClient.query<CertificateRow>(
        `${CERTIFICATE_SELECT} where c.id = $1`,
        [id],
      );
      return reply.status(201).send(certificateView(created.rows[0]!));
    },
  );

  // Certificate formats ----------------------------------------------------------------------

  app.get(
    '/certificate-formats',
    {
      config: { permissions: [CERT_READ], feature: FEATURE },
      schema: {
        operationId: 'listCertificateFormats',
        tags: ['consents'],
        description:
          'The fields of each kind of certificate in this hospital: the standard ones until the hospital changes them (#567). Requires certificate:read.',
        response: { 200: ref(CertificateFormatList), ...errors(401, 403, 429) },
      },
    },
    async (request) => ({
      items: await Promise.all(
        CERTIFICATE_KINDS.map(async (kind) => ({ kind, ...(await formatOf(request, kind)) })),
      ),
    }),
  );

  app.put(
    '/certificate-formats/:kind',
    {
      config: { permissions: [CERT_CONFIGURE], feature: FEATURE },
      schema: {
        operationId: 'setCertificateFormat',
        tags: ['consents'],
        description:
          'Replaces the fields of one kind of certificate (#567). Applies to certificates issued from now on; one already issued keeps its layout. Names once, a choice field has options (422 `certificate_format_invalid`). Requires certificate:configure.',
        params: KindParams,
        body: ref(CertificateFormatUpdate),
        response: { 200: ref(CertificateFormat), ...errors(400, 401, 403, 422, 429) },
      },
    },
    async (request) => {
      const { kind } = request.params;
      const fields = checkFormat((request.body as CertificateFormatUpdate).fields);
      await request.txClient.query(
        `insert into certificate_formats (tenant_id, kind, fields, updated_by)
         values (app_tenant_id(), $1, $2, $3)
         on conflict (tenant_id, kind) do update
           set fields = excluded.fields, updated_by = excluded.updated_by, updated_at = now()`,
        [kind, JSON.stringify(fields), userIdOf(request)],
      );
      return { kind, fields, custom: true };
    },
  );

  app.delete(
    '/certificate-formats/:kind',
    {
      config: { permissions: [CERT_CONFIGURE], feature: FEATURE },
      schema: {
        operationId: 'resetCertificateFormat',
        tags: ['consents'],
        description:
          'Goes back to the standard fields of the kind (#567). Requires certificate:configure.',
        params: KindParams,
        response: { 200: ref(CertificateFormat), ...errors(401, 403, 429) },
      },
    },
    async (request) => {
      const { kind } = request.params as { kind: (typeof CERTIFICATE_KINDS)[number] };
      await request.txClient.query('delete from certificate_formats where kind = $1', [kind]);
      return { kind, fields: STANDARD_FIELDS[kind].map((field) => ({ ...field })), custom: false };
    },
  );
  // Rendered as documents (#990) --------------------------------------------------------------

  app.post(
    '/consents/:consentId/document',
    {
      config: {
        permissions: [CONSENT_READ, 'document:upload'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'storeConsentDocument',
        tags: ['consents'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Renders the signed consent as a PDF on the server (text, signer, witnesses and withdrawal as they stand now) and keeps it as a clean document of the patient in the category consent, on the consent’s encounter when it names one (#990). Once for each consent: asking again returns the document already made, which is a snapshot and does not follow a later witness or withdrawal. 409 patient_merged for a merged record. Requires consent:read and document:upload.',
        params: ConsentParams,
        response: { 200: ref(PatientDocument), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const loaded = await loadConsent(request, request.params.consentId);
      if (!loaded) throw new HttpError(404, 'not_found', 'No such consent');
      const { row, detail } = loaded;
      try {
        await reachable(request, row.patient_id, CONSENT_READ);
      } catch {
        throw new HttpError(404, 'not_found', 'No such consent');
      }
      request.audit('read', 'patient_consent', row.id);
      const context = await contextOf(request, row.patient_id);
      return keepRendered(request, app.files, {
        userId: userIdOf(request),
        patientId: row.patient_id,
        encounterId: row.encounter_id,
        category: 'consent',
        source: 'source_consent_id',
        sourceId: row.id,
        title: `Consent: ${row.procedure_name}`.slice(0, 200),
        fileName: `consent-${row.id}.pdf`,
        render: () =>
          consentPdf(
            {
              procedureName: row.procedure_name,
              signerName: row.signer_name,
              signerRole: row.signer_role,
              signatureMethod: row.signature_method,
              signedAt: row.signed_at,
              signedByName: row.signed_by_name ?? '',
              body: row.body,
              ...(row.signature ? { signature: row.signature } : {}),
              templateVersion: row.template_version,
              witnesses: detail.witnesses.map((w) => ({
                witnessName: w.witnessName,
                ...(w.relation ? { relation: w.relation } : {}),
                signatureMethod: w.signatureMethod,
                ...(w.signature ? { signature: w.signature } : {}),
                recordedAt: new Date(w.recordedAt),
              })),
              ...(detail.withdrawal
                ? {
                    withdrawal: {
                      reason: detail.withdrawal.reason,
                      withdrawnAt: new Date(detail.withdrawal.withdrawnAt),
                      withdrawnByName: detail.withdrawal.withdrawnByName,
                    },
                  }
                : {}),
            },
            context,
          ),
      });
    },
  );

  app.post(
    '/certificates/:certificateId/document',
    {
      config: {
        permissions: [CERT_READ, 'document:upload'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'storeCertificateDocument',
        tags: ['consents'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Renders the issued certificate as a PDF on the server, with the layout it was issued under, and keeps it as a clean document of the patient in the category certificate (#990). Once for each certificate: asking again returns the document already made. 409 patient_merged for a merged record. Requires certificate:read and document:upload.',
        params: CertificateParams,
        response: { 200: ref(PatientDocument), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const { rows } = await request.txClient.query<CertificateRow>(
        `${CERTIFICATE_SELECT} where c.id = $1`,
        [request.params.certificateId],
      );
      const row = rows[0];
      if (!row) throw new HttpError(404, 'not_found', 'No such certificate');
      try {
        await reachable(request, row.patient_id, CERT_READ);
      } catch {
        throw new HttpError(404, 'not_found', 'No such certificate');
      }
      request.audit('read', 'patient_certificate', row.id);
      const context = await contextOf(request, row.patient_id);
      return keepRendered(request, app.files, {
        userId: userIdOf(request),
        patientId: row.patient_id,
        category: 'certificate',
        source: 'source_certificate_id',
        sourceId: row.id,
        title: `Certificate ${row.number}`,
        fileName: `certificate-${row.number}.pdf`,
        render: () =>
          certificatePdf(
            {
              kind: row.kind,
              number: row.number,
              issuedOn: row.issued_on,
              issuedByName: row.issued_by_name ?? '',
              fields: row.fields,
              layout: row.layout,
            },
            context,
          ),
      });
    },
  );
};
