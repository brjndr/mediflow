import { Type, type Static } from '@sinclair/typebox';
import { CursorPage, MAX_PAGE_SIZE, ref, StringEnum } from '../../core/http/schemas.js';

/** The most rows one batch holds, and one request sends. */
export const BATCH_ROWS_MAX = 20_000;
export const CHUNK_ROWS_MAX = 1_000;
/** The longest text one field of a row may be: longer than any field of any kind. */
export const VALUE_MAX = 2_000;

export const BATCH_STATUSES = [
  'staging',
  'checking',
  'checked',
  'queued',
  'running',
  'committed',
  'failed',
  'cancelled',
] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

const KindName = Type.String({
  pattern: '^[a-z][a-z_]{0,39}$',
  description: 'A kind of record: `services`, `drugs`, `lab_tests` or `patients`.',
});

export const ImportColumnInfo = Type.Object(
  {
    field: Type.String(),
    required: Type.Boolean(),
    type: StringEnum(['text', 'integer', 'boolean', 'enum', 'date', 'amount'], {
      description:
        'How the text becomes the value: `boolean` is yes or no (true, false, y, n, 1, 0); `enum` one of `values`, whatever its capitals; `date` YYYY-MM-DD; `amount` the hospital currency with a point before the minor units, grouped by commas or not.',
    }),
    values: Type.Optional(Type.Array(Type.String())),
  },
  { $id: 'ImportColumn' },
);

export const ImportKindInfo = Type.Object(
  {
    kind: KindName,
    columns: Type.Array(ref(ImportColumnInfo)),
  },
  { $id: 'ImportKind' },
);

export const ImportKindList = Type.Object(
  { items: Type.Array(ref(ImportKindInfo)) },
  { $id: 'ImportKindList' },
);

export const ImportBatch = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    kind: KindName,
    status: StringEnum(BATCH_STATUSES, {
      description:
        'staging: rows are being sent. checking: the dry run is running. checked: it has run, and the batch can be written when problemCount is 0. queued, running: being written. committed: every row was written. failed: nothing was written. cancelled: given up, or left unfinished for a week.',
    }),
    rowCount: Type.Integer({ minimum: 0 }),
    doneCount: Type.Integer({
      minimum: 0,
      description: 'Rows checked while checking, rows written while running.',
    }),
    problemCount: Type.Integer({ minimum: 0 }),
    failure: Type.Optional(
      Type.String({
        description:
          'Why nothing was written, as a code: rows_refused (see the problems), permission_withdrawn, write_failed, expired.',
      }),
    ),
    createdBy: Type.Object({ id: Type.String(), name: Type.String() }),
    createdAt: Type.String({ format: 'date-time' }),
    checkedAt: Type.Optional(Type.String({ format: 'date-time' })),
    finishedAt: Type.Optional(Type.String({ format: 'date-time' })),
  },
  {
    $id: 'ImportBatch',
    description:
      'Records of one kind loaded from a file. It holds counts and codes, never a value of a row.',
  },
);
export type ImportBatch = Static<typeof ImportBatch>;

export const ImportBatchPage = CursorPage(ref(ImportBatch), { $id: 'ImportBatchPage' });

export const ImportBatchCreate = Type.Object(
  { kind: KindName },
  { $id: 'ImportBatchCreate', additionalProperties: false },
);
export type ImportBatchCreate = Static<typeof ImportBatchCreate>;

export const ImportRowsUpload = Type.Object(
  {
    fields: Type.Array(Type.String({ pattern: '^[A-Za-z][A-Za-z0-9]{0,39}$' }), {
      minItems: 1,
      maxItems: 40,
      description:
        'The fields of the kind the columns of the file were mapped to, in the order of `values`. Each at most once.',
    }),
    rows: Type.Array(
      Type.Object(
        {
          line: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
          values: Type.Array(Type.String({ maxLength: VALUE_MAX }), {
            maxItems: 40,
            description: 'The text of each field of `fields`. An empty text is no value.',
          }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: CHUNK_ROWS_MAX },
    ),
  },
  {
    $id: 'ImportRowsUpload',
    additionalProperties: false,
    description:
      'Rows of the file, as many requests as it takes. A line sent twice is kept as it was first sent.',
  },
);
export type ImportRowsUpload = Static<typeof ImportRowsUpload>;

export const ImportProblem = Type.Object(
  {
    line: Type.Integer({ minimum: 1 }),
    field: Type.Optional(Type.String()),
    code: Type.String({
      description:
        'What is wrong. Of one field: required, not_a_whole_number, not_yes_or_no, not_allowed, not_a_date, not_an_amount, too_many_decimals, invalid, not_found, out_of_range, too_few_digits, not_an_email. Of a row: duplicate_in_file, or the code its create route answers with (drug_exists, service_code_taken, lab_test_code_taken, patient_possible_duplicate, validation_failed).',
    }),
  },
  { $id: 'ImportProblem', description: 'Never the value that was refused.' },
);

export const ImportProblemPage = CursorPage(ref(ImportProblem), { $id: 'ImportProblemPage' });

export const ImportListQuery = Type.Object({
  cursor: Type.Optional(Type.String({ maxLength: 200 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
});

export const IMPORT_SCHEMAS = [
  ImportColumnInfo,
  ImportKindInfo,
  ImportKindList,
  ImportBatch,
  ImportBatchPage,
  ImportBatchCreate,
  ImportRowsUpload,
  ImportProblem,
  ImportProblemPage,
] as const;
