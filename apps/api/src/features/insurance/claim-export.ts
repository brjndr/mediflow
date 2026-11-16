import { Type, type Static } from '@sinclair/typebox';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref, StringEnum } from '../../core/http/schemas.js';
import { ClaimParams } from './claim-schemas.js';
import { isUuid } from './util.js';

const FEATURE = 'insurance';

/** What an adapter is given: the claim and the visit's charges, ids and numbers, no names. */
export interface ClaimExportInput {
  number: string;
  status: string;
  payerCode: string;
  payerKind: string;
  policyNumber: string;
  claimedMinor: number;
  approvedMinor: number | null;
  currency: string;
  submittedAt: string | null;
  documents: string[];
  lines: { serviceCode: string; description: string; quantity: number; unitPriceMinor: number }[];
}

export interface ClaimExportFile {
  filename: string;
  contentType: string;
  content: string;
}

/** A payer format. A new payer's layout is one more entry here, with no change to a route. */
export interface ClaimExportAdapter {
  label: string;
  render(input: ClaimExportInput): ClaimExportFile;
}

/** A cell that a spreadsheet would run as a formula is made text. */
const cell = (value: string | number): string => {
  const text = String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export const CLAIM_EXPORT_FORMATS = ['generic_json', 'generic_csv'] as const;

export const CLAIM_EXPORT_ADAPTERS: Record<
  (typeof CLAIM_EXPORT_FORMATS)[number],
  ClaimExportAdapter
> = {
  generic_json: {
    label: 'Generic JSON',
    render: (input) => ({
      filename: `${input.number}.json`,
      contentType: 'application/json',
      content: JSON.stringify(input, null, 2),
    }),
  },
  generic_csv: {
    label: 'Generic CSV, one row for each charge',
    render: (input) => {
      const head = [
        'claim',
        'payer_code',
        'policy_number',
        'service_code',
        'description',
        'quantity',
        'unit_price_minor',
      ];
      const rows = input.lines.map((line) =>
        [
          input.number,
          input.payerCode,
          input.policyNumber,
          line.serviceCode,
          line.description,
          line.quantity,
          line.unitPriceMinor,
        ]
          .map(cell)
          .join(','),
      );
      return {
        filename: `${input.number}.csv`,
        contentType: 'text/csv',
        content: [head.join(','), ...rows].join('\r\n') + '\r\n',
      };
    },
  },
};

export const ClaimExportQuery = Type.Object({ format: StringEnum(CLAIM_EXPORT_FORMATS) });
export const ClaimExport = Type.Object(
  {
    format: Type.String(),
    filename: Type.String(),
    contentType: Type.String(),
    content: Type.String({ description: 'The file, as text.' }),
  },
  { $id: 'ClaimExport' },
);
export type ClaimExport = Static<typeof ClaimExport>;
export const CLAIM_EXPORT_SCHEMAS = [ClaimExport];

export const claimExportRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/claims/:claimId/export',
    {
      config: { permissions: ['claim:read'], feature: FEATURE },
      schema: {
        operationId: 'exportClaim',
        tags: ['insurance'],
        description:
          "A claim in a payer's format (`generic_json`, `generic_csv`), made from the claim and the visit's charges as they are now. Holds policy numbers and amounts, no names. Needs claim:read. Audited as an export.",
        params: ClaimParams,
        querystring: ClaimExportQuery,
        response: { 200: ref(ClaimExport), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      const format = request.query.format as (typeof CLAIM_EXPORT_FORMATS)[number];
      const adapter = CLAIM_EXPORT_ADAPTERS[format];
      if (!adapter) throw new HttpError(400, 'validation_failed', 'Unknown format');
      const id = request.params.claimId;
      const found = isUuid(id)
        ? await request.txClient.query<{
            id: string;
            seq: number;
            status: string;
            encounter_id: string;
            policy_number: string;
            claimed_minor: string;
            approved_minor: string | null;
            documents: string[];
            submitted_at: Date | null;
            payer_code: string;
            payer_kind: string;
            currency: string;
          }>(
            `select c.id, c.seq, c.status, c.encounter_id, c.policy_number, c.claimed_minor,
                    c.approved_minor, c.documents, c.submitted_at, py.code as payer_code,
                    py.kind as payer_kind, t.currency
               from claims c
               join payers py on py.tenant_id = c.tenant_id and py.id = c.payer_id
               join tenants t on t.id = c.tenant_id
              where c.id = $1`,
            [id],
          )
        : null;
      const claim = found?.rows[0];
      if (!claim) throw new HttpError(404, 'claim_not_found', 'No such claim');
      const charges = await request.txClient.query<{
        code: string | null;
        description: string;
        quantity: string;
        unit_price_minor: string;
      }>(
        `select s.code, ch.description, ch.quantity, ch.unit_price_minor
           from charges ch left join services s on s.tenant_id = ch.tenant_id and s.id = ch.service_id
          where ch.encounter_id = $1 and ch.status <> 'void'
          order by ch.posted_at, ch.id`,
        [claim.encounter_id],
      );
      const file = adapter.render({
        number: `CLM-${String(claim.seq).padStart(6, '0')}`,
        status: claim.status,
        payerCode: claim.payer_code,
        payerKind: claim.payer_kind,
        policyNumber: claim.policy_number,
        claimedMinor: Number(claim.claimed_minor),
        approvedMinor: claim.approved_minor === null ? null : Number(claim.approved_minor),
        currency: claim.currency,
        submittedAt: claim.submitted_at?.toISOString() ?? null,
        documents: claim.documents,
        lines: charges.rows.map((row) => ({
          serviceCode: row.code ?? '',
          description: row.description,
          quantity: Number(row.quantity),
          unitPriceMinor: Number(row.unit_price_minor),
        })),
      });
      request.audit('export', 'claim', claim.id, `format:${request.query.format}`);
      return { format: request.query.format, ...file };
    },
  );
};
