import { Type, type Static } from '@sinclair/typebox';
import { CursorPage, StringEnum, ref } from '../../core/http/schemas.js';

export const REPORT_KINDS = [
  'opd_census',
  'revenue',
  'doctor_activity',
  'lab_turnaround',
  'pharmacy_sales',
  'stock',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** Most days a report may cover, and the most one answered on the spot may. */
export const MAX_RANGE_DAYS = 366;
export const MAX_SYNC_RANGE_DAYS = 31;

const Kind = StringEnum(REPORT_KINDS);

export const ReportRequest = Type.Object(
  {
    from: Type.Optional(
      Type.String({
        format: 'date',
        description:
          'First day, at the hospital (YYYY-MM-DD). Required for every report but `stock`, which is a snapshot of now and ignores both days.',
      }),
    ),
    to: Type.Optional(
      Type.String({
        format: 'date',
        description:
          'Last day, included. At most 366 days from `from` (31 when answered on the spot).',
      }),
    ),
  },
  { $id: 'ReportRequest', additionalProperties: false },
);

const Cell = Type.Unsafe<string | number | null>({ type: ['string', 'number', 'null'] });

export const ReportColumn = Type.Object(
  {
    key: Type.String({ description: 'Stable name of the column; the web app translates it.' }),
    type: StringEnum(['text', 'date', 'integer', 'money', 'minutes']),
  },
  {
    $id: 'ReportColumn',
    description: 'Money is in minor units of the report currency; minutes are whole minutes.',
  },
);

export const ReportResult = Type.Object(
  {
    kind: Kind,
    from: Type.Union([Type.String({ format: 'date' }), Type.Null()]),
    to: Type.Union([Type.String({ format: 'date' }), Type.Null()]),
    currency: Type.String(),
    generatedAt: Type.String({ format: 'date-time' }),
    columns: Type.Array(ref(ReportColumn)),
    rows: Type.Array(Type.Array(Cell), {
      description: 'One array a row, in the order of `columns`.',
    }),
    totals: Type.Array(Cell, {
      description: 'In the order of `columns`: the sum of a column that adds up, otherwise null.',
    }),
  },
  {
    $id: 'ReportResult',
    description:
      'A report as a table of counts and money by day, department, test or drug. It holds no patient record.',
  },
);
export type ReportResult = Static<typeof ReportResult>;
export type ReportColumn = Static<typeof ReportColumn>;
export type Cell = string | number | null;

export const ReportRun = Type.Object(
  {
    id: Type.String(),
    kind: Kind,
    from: Type.Union([Type.String({ format: 'date' }), Type.Null()]),
    to: Type.Union([Type.String({ format: 'date' }), Type.Null()]),
    status: StringEnum(['queued', 'running', 'succeeded', 'failed']),
    requestedBy: Type.Object({ id: Type.String(), name: Type.String() }),
    requestedAt: Type.String({ format: 'date-time' }),
    finishedAt: Type.Optional(Type.String({ format: 'date-time' })),
    expiresAt: Type.String({ format: 'date-time' }),
    rowCount: Type.Optional(Type.Integer({ minimum: 0 })),
    failure: Type.Optional(
      Type.String({ description: 'A code: `timeout`, `too_large`, `stalled` or `failed`.' }),
    ),
    result: Type.Optional(ref(ReportResult)),
  },
  {
    $id: 'ReportRun',
    description:
      'A stored report. `result` is given once it has succeeded, on the run read by id only, never in the list.',
  },
);
export type ReportRun = Static<typeof ReportRun>;

export const ReportRunPage = CursorPage(ref(ReportRun), { $id: 'ReportRunPage' });

export const ReportLimits = Type.Object(
  {
    maxConcurrent: Type.Integer(),
    maxPerDay: Type.Integer(),
    retentionDays: Type.Integer(),
    active: Type.Integer({ description: 'Stored reports waiting or running now.' }),
    usedToday: Type.Integer({ description: 'Stored reports asked for in the last 24 hours.' }),
  },
  {
    $id: 'ReportLimits',
    description: 'What the hospital may ask of the reporting service, and what it has used.',
  },
);

export const ReportDownload = Type.Object(
  {
    url: Type.String({ description: 'A path on this API, signed; it works for a few minutes.' }),
    expiresAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'ReportDownload' },
);

export const REPORT_SCHEMAS = [
  ReportRequest,
  ReportColumn,
  ReportResult,
  ReportRun,
  ReportRunPage,
  ReportLimits,
  ReportDownload,
];
