import { Type, type Static } from '@sinclair/typebox';
import { CursorPage, ref } from '../../core/http/schemas.js';
import { PLAIN_TEXT } from '../../core/http/text.js';
import { PageQuery, REASON_MAX } from './schemas.js';

/** Fluid balance (NR-04, #160) and care plans: their schemas, kept apart from the older ones. */

export const INTAKE_KINDS = ['oral', 'intravenous', 'tube', 'other_intake'] as const;
export const OUTPUT_KINDS = ['urine', 'drain', 'vomit', 'stool', 'other_output'] as const;
export const FLUID_KINDS = [...INTAKE_KINDS, ...OUTPUT_KINDS] as const;
export const AMOUNT_MAX_ML = 5000;
export const PROBLEM_MAX = 200;
export const GOAL_MAX = 500;
export const TASK_MAX = 200;
export const MAX_NEW_TASKS = 20;

const Id = Type.String({ maxLength: 64 });
const Instant = Type.String({ format: 'date-time' });
const Text = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: PLAIN_TEXT });

export const FluidParams = Type.Object({ admissionId: Id, fluidId: Id });
export const PlanParams = Type.Object({ planId: Id });
export const TaskParams = Type.Object({ taskId: Id });
export const FluidQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: PageQuery.properties.limit,
  from: Type.Optional(Instant),
  to: Type.Optional(Instant),
});
export const FluidTotalsQuery = Type.Object({ from: Instant, to: Instant });

// --- fluid balance -----------------------------------------------------------------------------

export const FluidKind = Type.Unsafe<(typeof FLUID_KINDS)[number]>({
  $id: 'FluidKind',
  type: 'string',
  enum: [...FLUID_KINDS],
  description:
    'Intake: oral, intravenous, tube, other_intake. Output: urine, drain, vomit, stool, other_output.',
});

export const WardFluid = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    admissionId: Type.String(),
    direction: Type.Unsafe<'intake' | 'output'>({ type: 'string', enum: ['intake', 'output'] }),
    kind: ref(FluidKind),
    amountMl: Type.Integer({ minimum: 1, maximum: AMOUNT_MAX_ML }),
    observedAt: Instant,
    recordedAt: Instant,
    recordedById: Type.String(),
    recordedByName: Type.String(),
    correctsId: Type.Optional(Type.String()),
    correctionReason: Type.Optional(Type.String()),
    correctedById: Type.Optional(
      Type.String({ description: 'The entry that corrects this one. Absent while it stands.' }),
    ),
  },
  {
    $id: 'WardFluid',
    additionalProperties: false,
    description:
      'One measure of fluid taken in or put out, append-only: a correction is a new entry that names the one it corrects, once, and replaces its amount in the totals.',
  },
);
export const WardFluidPage = CursorPage(ref(WardFluid), { $id: 'WardFluidPage' });

export const WardFluidCreate = Type.Object(
  {
    kind: ref(FluidKind),
    amountMl: Type.Integer({ minimum: 1, maximum: AMOUNT_MAX_ML }),
    observedAt: Type.Optional(
      Type.String({
        format: 'date-time',
        description: 'When: now when not sent, never in the future.',
      }),
    ),
  },
  { $id: 'WardFluidCreate', additionalProperties: false },
);
export type WardFluidCreate = Static<typeof WardFluidCreate>;

export const WardFluidCorrect = Type.Object(
  {
    kind: ref(FluidKind),
    amountMl: Type.Integer({ minimum: 1, maximum: AMOUNT_MAX_ML }),
    reason: Text(REASON_MAX),
  },
  {
    $id: 'WardFluidCorrect',
    additionalProperties: false,
    description:
      'The entry as it should have read, of the same direction as the one it corrects, and why. The time is the corrected entry one.',
  },
);
export type WardFluidCorrect = Static<typeof WardFluidCorrect>;

export const FluidTotals = Type.Object(
  {
    from: Instant,
    to: Instant,
    intakeMl: Type.Integer({ minimum: 0 }),
    outputMl: Type.Integer({ minimum: 0 }),
    balanceMl: Type.Integer({ description: 'Intake minus output.' }),
    entries: Type.Integer({ minimum: 0 }),
  },
  {
    $id: 'FluidTotals',
    additionalProperties: false,
    description:
      'What was taken in and put out between two instants (from included, to excluded) by the time observed. An entry that was corrected counts as its correction.',
  },
);

// --- care plans --------------------------------------------------------------------------------

export const CarePlanStatus = Type.Unsafe<'active' | 'completed' | 'cancelled'>({
  $id: 'CarePlanStatus',
  type: 'string',
  enum: ['active', 'completed', 'cancelled'],
});

export const CarePlanTask = Type.Object(
  {
    id: Type.String(),
    description: Type.String(),
    dueAt: Type.Optional(Instant),
    doneAt: Type.Optional(Instant),
    doneById: Type.Optional(Type.String()),
    doneByName: Type.Optional(Type.String()),
    doneNote: Type.Optional(Type.String()),
  },
  { $id: 'CarePlanTask', additionalProperties: false },
);

export const CarePlan = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    admissionId: Type.String(),
    problem: Type.String(),
    goal: Type.Optional(Type.String()),
    status: ref(CarePlanStatus),
    createdAt: Instant,
    createdById: Type.String(),
    createdByName: Type.String(),
    closedAt: Type.Optional(Instant),
    tasks: Type.Array(ref(CarePlanTask)),
  },
  {
    $id: 'CarePlan',
    additionalProperties: false,
    description:
      'A nursing problem, its goal and the tasks to carry out. The plan only ends (completed or cancelled); a task is done once.',
  },
);
export const CarePlanPage = CursorPage(ref(CarePlan), { $id: 'CarePlanPage' });

const NewTask = Type.Object(
  { description: Text(TASK_MAX), dueAt: Type.Optional(Instant) },
  { $id: 'CarePlanTaskCreate', additionalProperties: false },
);
export const CarePlanCreate = Type.Object(
  {
    problem: Text(PROBLEM_MAX),
    goal: Type.Optional(Text(GOAL_MAX)),
    tasks: Type.Optional(Type.Array(ref(NewTask), { maxItems: MAX_NEW_TASKS })),
  },
  { $id: 'CarePlanCreate', additionalProperties: false },
);
export type CarePlanCreate = Static<typeof CarePlanCreate>;
export const CarePlanTaskCreate = NewTask;
export type CarePlanTaskCreate = Static<typeof NewTask>;

export const CarePlanClose = Type.Object(
  {
    status: Type.Unsafe<'completed' | 'cancelled'>({
      type: 'string',
      enum: ['completed', 'cancelled'],
    }),
  },
  { $id: 'CarePlanClose', additionalProperties: false },
);
export type CarePlanClose = Static<typeof CarePlanClose>;

export const CarePlanTaskDone = Type.Object(
  { note: Type.Optional(Text(REASON_MAX)) },
  { $id: 'CarePlanTaskDone', additionalProperties: false },
);
export type CarePlanTaskDone = Static<typeof CarePlanTaskDone>;

export const CARE_SCHEMAS = [
  FluidKind,
  WardFluid,
  WardFluidPage,
  WardFluidCreate,
  WardFluidCorrect,
  FluidTotals,
  CarePlanStatus,
  CarePlanTask,
  CarePlan,
  CarePlanPage,
  CarePlanTaskCreate,
  CarePlanCreate,
  CarePlanClose,
  CarePlanTaskDone,
];
