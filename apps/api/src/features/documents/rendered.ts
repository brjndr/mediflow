import { createHash, randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { FileStore } from '../../core/files/store.js';
import { HttpError } from '../../core/http/errors.js';
import { richTextToPlainText, type RichTextDocument } from '../../core/http/rich-text.js';
import { patientMergedInto } from '../patients/index.js';
import { fileKeyOf } from './files.js';
import { renderPdf, type Block } from './pdf.js';
import { COLUMNS, view, type DocumentRow } from './routes.js';

/**
 * Consents and certificates kept as documents (#990). The server renders the PDF itself, so the
 * file is trusted and stored as `clean` with no scan; it is a document of the patient like any
 * other (retention rule of its category, retire with a reason, signed download link). The source
 * is named on the row, once, so a second request returns the document already made: a rendering
 * is a snapshot, a later witness or withdrawal is not added to it.
 */
export interface RenderContext {
  hospital: string;
  timezone: string;
  patientName: string;
  mrn: string;
}

export async function contextOf(
  request: FastifyRequest,
  patientId: string,
): Promise<RenderContext> {
  const patient = await request.txClient.query<{
    first_name: string;
    last_name: string;
    mrn: string;
  }>('select first_name, last_name, mrn from patients where id = $1', [patientId]);
  const tenant = await request.txClient.query<{ name: string; timezone: string }>(
    'select name, timezone from tenants where id = app_tenant_id()',
  );
  const p = patient.rows[0];
  const t = tenant.rows[0];
  if (!p || !t) throw new HttpError(404, 'not_found', 'No such patient');
  return {
    hospital: t.name,
    timezone: t.timezone,
    patientName: `${p.first_name} ${p.last_name}`,
    mrn: p.mrn,
  };
}

const when = (at: Date, timezone: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(at);

const humanize = (name: string) => {
  const spaced = name.replace(/([A-Z])/g, ' $1').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

export interface ConsentToRender {
  procedureName: string;
  signerName: string;
  signerRole: string;
  signatureMethod: 'drawn' | 'typed';
  signedAt: Date;
  signedByName: string;
  body: Record<string, unknown>;
  signature?: string;
  templateVersion: number;
  witnesses: {
    witnessName: string;
    relation?: string;
    signatureMethod: 'drawn' | 'typed';
    signature?: string;
    recordedAt: Date;
  }[];
  withdrawal?: { reason: string; withdrawnAt: Date; withdrawnByName: string };
}

export function consentPdf(consent: ConsentToRender, context: RenderContext): Buffer {
  const text = richTextToPlainText(consent.body as unknown as RichTextDocument);
  const blocks: Block[] = [
    { kind: 'title', text: context.hospital },
    { kind: 'heading', text: `Consent: ${consent.procedureName}` },
    { kind: 'row', label: 'Patient', value: `${context.patientName} (MRN ${context.mrn})` },
    { kind: 'row', label: 'Template version', value: String(consent.templateVersion) },
    { kind: 'space' },
    { kind: 'text', text },
    { kind: 'space' },
    { kind: 'row', label: 'Signed by', value: `${consent.signerName} (${consent.signerRole})` },
    { kind: 'row', label: 'Signed on', value: when(consent.signedAt, context.timezone) },
    { kind: 'row', label: 'Recorded by', value: consent.signedByName },
    consent.signatureMethod === 'drawn' && consent.signature
      ? { kind: 'signature', path: consent.signature }
      : { kind: 'row', label: 'Signature', value: `Typed: ${consent.signerName}` },
  ];
  for (const w of consent.witnesses) {
    blocks.push(
      { kind: 'heading', text: 'Witness' },
      { kind: 'row', label: 'Name', value: w.witnessName },
      ...(w.relation ? [{ kind: 'row', label: 'Relation', value: w.relation } as const] : []),
      { kind: 'row', label: 'Recorded', value: when(w.recordedAt, context.timezone) },
      w.signatureMethod === 'drawn' && w.signature
        ? { kind: 'signature', path: w.signature }
        : { kind: 'row', label: 'Signature', value: `Typed: ${w.witnessName}` },
    );
  }
  if (consent.withdrawal) {
    blocks.push(
      { kind: 'heading', text: 'Withdrawn' },
      { kind: 'row', label: 'On', value: when(consent.withdrawal.withdrawnAt, context.timezone) },
      { kind: 'row', label: 'By', value: consent.withdrawal.withdrawnByName },
      { kind: 'row', label: 'Reason', value: consent.withdrawal.reason },
    );
  }
  return renderPdf(`Consent ${consent.procedureName}`, blocks);
}

export interface CertificateToRender {
  kind: string;
  number: string;
  issuedOn: string;
  issuedByName: string;
  fields: Record<string, string>;
  layout: { name: string; label?: string }[];
}

export function certificatePdf(certificate: CertificateToRender, context: RenderContext): Buffer {
  const blocks: Block[] = [
    { kind: 'title', text: context.hospital },
    { kind: 'heading', text: `${humanize(certificate.kind)} certificate ${certificate.number}` },
    { kind: 'row', label: 'Patient', value: `${context.patientName} (MRN ${context.mrn})` },
    { kind: 'row', label: 'Issued on', value: certificate.issuedOn },
    { kind: 'space' },
  ];
  for (const field of certificate.layout) {
    const value = certificate.fields[field.name];
    if (value) blocks.push({ kind: 'row', label: field.label ?? humanize(field.name), value });
  }
  blocks.push(
    { kind: 'space' },
    { kind: 'row', label: 'Issued by', value: certificate.issuedByName },
  );
  return renderPdf(`${humanize(certificate.kind)} certificate ${certificate.number}`, blocks);
}

/** Stores the PDF as a clean document, or returns the one already made for the source. */
export async function keepRendered(
  request: FastifyRequest,
  files: FileStore,
  input: {
    userId: string;
    patientId: string;
    encounterId?: string | null;
    category: 'consent' | 'certificate';
    source: 'source_consent_id' | 'source_certificate_id';
    sourceId: string;
    title: string;
    fileName: string;
    render: () => Buffer;
  },
) {
  const existing = await request.txClient.query<DocumentRow>(
    `select ${COLUMNS} from patient_documents where ${input.source} = $1`,
    [input.sourceId],
  );
  if (existing.rows[0]) return view(existing.rows[0]);
  if ((await patientMergedInto(request.txClient, input.patientId)) !== null) {
    throw new HttpError(409, 'patient_merged', 'This record was merged into another');
  }
  const pdf = input.render();
  const id = randomUUID();
  const tenant = await request.txClient.query<{ id: string }>('select app_tenant_id() as id');
  const key = fileKeyOf(tenant.rows[0]!.id, id);
  await files.put(key, pdf);
  try {
    const { rows } = await request.txClient.query<DocumentRow>(
      `insert into patient_documents (id, tenant_id, patient_id, encounter_id, category, title,
         file_name, content_type, size_bytes, status, file_key, sha256, scan_result, created_by,
         uploaded_at, scanned_at, ${input.source}, retain_until)
       select $1, app_tenant_id(), $2, $3, $4, $5, $6, 'application/pdf', $7, 'clean', $8, $9,
         'generated', $10, now(), now(), $11,
         (select (now() at time zone t.timezone)::date + make_interval(years => r.years::int)
          from document_retention_rules r, tenants t
          where r.category = $4 and t.id = app_tenant_id())
       returning ${COLUMNS}`,
      [
        id,
        input.patientId,
        input.encounterId ?? null,
        input.category,
        input.title,
        input.fileName,
        pdf.length,
        key,
        createHash('sha256').update(pdf).digest('hex'),
        input.userId,
        input.sourceId,
      ],
    );
    request.audit('create', 'patient_document', id);
    return view(rows[0]!);
  } catch (error) {
    await files.delete(key).catch(() => undefined);
    throw error;
  }
}
