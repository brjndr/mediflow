import { CheckCircle2, Circle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Can, usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { Form, SubmitButton, TextAreaField, TextField, useZodForm } from '@/shared/ui/form';
import { StatusBadge } from '@/shared/ui/status-badge';
import { maskMrn } from '@/shared/utils/mask';
import { useFormatters } from '@/tenancy';
import {
  GOAL_MAX,
  planFormSchema,
  PROBLEM_MAX,
  TASK_MAX,
  taskFormSchema,
  type PlanValues,
  type TaskValues,
} from '../care-schemas';
import { useCarePlans, useChangeCarePlan, useCreateCarePlan } from '../hooks/use-care';
import { useStay } from '../hooks/use-nursing';
import type { CarePlan, CarePlanTask } from '../types';

const REFUSED: Record<string, string> = {
  plan_closed: 'care.refused.planClosed',
  already_done: 'care.refused.alreadyDone',
  admission_not_open: 'care.refused.notOpen',
};

/** The words a change was refused with, or the general message. */
function useRefusal() {
  const { t } = useTranslation('nursing');
  const { t: tCommon } = useTranslation();
  return (error: unknown): string => {
    if (isApiError(error) && error.serverCode) {
      const key = REFUSED[error.serverCode];
      if (key) return t(key);
    }
    return tCommon(errorMessageKey(error));
  };
}

function AddTask({
  plan,
  admissionId,
  onDone,
}: {
  plan: CarePlan;
  admissionId: string;
  onDone: (message: string) => void;
}) {
  const { t } = useTranslation('nursing');
  const change = useChangeCarePlan(admissionId);
  const refusal = useRefusal();
  const form = useZodForm(taskFormSchema, { description: '' });
  const submit = async (values: TaskValues) => {
    try {
      await change.mutateAsync({
        kind: 'addTask',
        planId: plan.id,
        body: { description: values.description },
      });
      form.reset({ description: '' });
      onDone(t('care.done.taskAdded'));
    } catch {
      // Said below, from the mutation state.
    }
  };
  return (
    <Form form={form} onSubmit={(values: TaskValues) => void submit(values)}>
      <TextField<TaskValues>
        name="description"
        label={t('care.addTask', { problem: plan.problem })}
        maxLength={TASK_MAX}
        autoComplete="off"
        required
      />
      {change.isError && (
        <p role="alert" className="text-sm text-destructive">
          {refusal(change.error)}
        </p>
      )}
      <div>
        <SubmitButton pending={change.isPending}>{t('care.addTaskButton')}</SubmitButton>
      </div>
    </Form>
  );
}

function PlanCard({
  plan,
  admissionId,
  open,
  onDone,
}: {
  plan: CarePlan;
  admissionId: string;
  open: boolean;
  onDone: (message: string) => void;
}) {
  const { t } = useTranslation('nursing');
  const format = useFormatters();
  const change = useChangeCarePlan(admissionId);
  const refusal = useRefusal();
  const canWrite = usePermission('carePlan:write');
  const active = plan.status === 'active';
  const editable = open && active && canWrite;
  const finished = plan.tasks.filter((task) => task.doneAt).length;

  const markDone = async (task: CarePlanTask) => {
    try {
      await change.mutateAsync({ kind: 'done', taskId: task.id });
      onDone(t('care.done.taskDone', { task: task.description }));
    } catch {
      // Said below.
    }
  };
  const close = async (status: 'completed' | 'cancelled') => {
    try {
      await change.mutateAsync({ kind: 'close', planId: plan.id, status });
      onDone(t(status === 'completed' ? 'care.done.completed' : 'care.done.cancelled'));
    } catch {
      // Said below.
    }
  };

  return (
    <li className="flex flex-col gap-3 rounded-md border p-4">
      <article aria-labelledby={`plan-${plan.id}`} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1">
            <h3 id={`plan-${plan.id}`} className="text-base font-semibold">
              {plan.problem}
            </h3>
            {plan.goal && <p className="text-sm">{t('care.goal', { goal: plan.goal })}</p>}
            <p className="text-sm text-muted-foreground">
              {t('care.started', { by: plan.createdByName, time: format.dateTime(plan.createdAt) })}
              {plan.closedAt ? ` ${t('care.ended', { time: format.dateTime(plan.closedAt) })}` : ''}
            </p>
          </div>
          <StatusBadge
            tone={
              plan.status === 'active'
                ? 'info'
                : plan.status === 'completed'
                  ? 'success'
                  : 'neutral'
            }
            label={t(`care.status.${plan.status}`)}
          />
        </div>

        <p className="text-sm text-muted-foreground">
          {t('care.progress', { done: finished, total: plan.tasks.length })}
        </p>
        {plan.tasks.length === 0 ? (
          <p className="text-sm">{t('care.noTasks')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {plan.tasks.map((task) => (
              <li key={task.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-start gap-2 text-sm">
                  {task.doneAt ? (
                    <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  ) : (
                    <Circle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  )}
                  <span>
                    {task.description}
                    <span className="block text-muted-foreground">
                      {task.doneAt
                        ? t('care.taskDone', {
                            by: task.doneByName ?? '',
                            time: format.dateTime(task.doneAt),
                          }) + (task.doneNote ? ` ${task.doneNote}` : '')
                        : task.dueAt
                          ? t('care.taskDue', { time: format.dateTime(task.dueAt) })
                          : t('care.taskOpen')}
                    </span>
                  </span>
                </span>
                {editable && !task.doneAt && (
                  <Button
                    variant="outline"
                    aria-disabled={change.isPending || undefined}
                    aria-label={t('care.markDoneLabel', { task: task.description })}
                    onClick={() => void markDone(task)}
                  >
                    {t('care.markDone')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {change.isError && change.variables?.kind !== 'addTask' && (
          <p role="alert" className="text-sm text-destructive">
            {refusal(change.error)}
          </p>
        )}
        {editable && (
          <>
            <AddTask plan={plan} admissionId={admissionId} onDone={onDone} />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                aria-disabled={change.isPending || undefined}
                onClick={() => void close('completed')}
              >
                {t('care.complete')}
              </Button>
              <Button
                variant="outline"
                aria-disabled={change.isPending || undefined}
                onClick={() => void close('cancelled')}
              >
                {t('care.cancel')}
              </Button>
            </div>
          </>
        )}
      </article>
    </li>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function CarePlans() {
  const { t } = useTranslation('nursing');
  const { t: tCommon } = useTranslation();
  const { admissionId = '' } = useParams();
  const stay = useStay(admissionId);
  const plans = useCarePlans(admissionId);
  const create = useCreateCarePlan(admissionId);
  const refusal = useRefusal();
  const form = useZodForm(planFormSchema, { problem: '', goal: '', firstTask: '' });
  const [done, setDone] = useState('');
  const statusLine = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (done) focusIfLost(statusLine.current);
  }, [done]);

  const rows = plans.data?.pages.flatMap((page) => page.items) ?? [];
  const open = stay.data?.status === 'admitted';

  const submit = async (values: PlanValues) => {
    setDone('');
    try {
      await create.mutateAsync({
        problem: values.problem,
        ...(values.goal ? { goal: values.goal } : {}),
        ...(values.firstTask ? { tasks: [{ description: values.firstTask }] } : {}),
      });
      form.reset({ problem: '', goal: '', firstTask: '' });
      setDone(t('care.done.started'));
    } catch {
      focusIfLost(statusLine.current);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6">
      <div className="space-y-1">
        <Link to="/nursing" className="text-sm underline underline-offset-2">
          {t('back')}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {stay.data ? t('care.heading', { patient: stay.data.patientName }) : t('care.loading')}
        </h1>
        {stay.data && (
          <p className="text-muted-foreground">
            {t('stayLine', {
              mrn: maskMrn(stay.data.patientMrn),
              bed: stay.data.bed?.bedNumber ?? t('noBed'),
              ward: stay.data.bed?.wardName ?? '',
            })}
          </p>
        )}
      </div>

      {stay.isError && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(stay.error))}
        </p>
      )}
      {stay.data && !open && <p className="text-sm font-medium">{t('care.closed')}</p>}

      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm font-medium outline-none empty:sr-only focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {done}
      </p>

      <Can permission="carePlan:write">
        {open && (
          <section
            aria-labelledby="plan-add-heading"
            className="flex flex-col gap-3 rounded-md border p-4"
          >
            <h2 id="plan-add-heading" className="text-lg font-semibold">
              {t('care.startHeading')}
            </h2>
            <Form form={form} onSubmit={(values: PlanValues) => void submit(values)}>
              <TextField<PlanValues>
                name="problem"
                label={t('care.problem')}
                maxLength={PROBLEM_MAX}
                autoComplete="off"
                required
              />
              <TextAreaField<PlanValues>
                name="goal"
                label={t('care.goalField')}
                rows={2}
                maxLength={GOAL_MAX}
              />
              <TextField<PlanValues>
                name="firstTask"
                label={t('care.firstTask')}
                maxLength={TASK_MAX}
                autoComplete="off"
              />
              {create.isError && (
                <p role="alert" className="text-sm text-destructive">
                  {refusal(create.error)}
                </p>
              )}
              <div>
                <SubmitButton pending={create.isPending}>{t('care.start')}</SubmitButton>
              </div>
            </Form>
          </section>
        )}
      </Can>

      <section aria-labelledby="plans-heading" className="flex flex-col gap-3">
        <h2 id="plans-heading" className="text-lg font-semibold">
          {t('care.plansHeading')}
        </h2>
        {plans.isPending && <p role="status">{tCommon('grid.loading')}</p>}
        {plans.isError && (
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(plans.error))}
          </p>
        )}
        {plans.isSuccess && rows.length === 0 && <p className="text-sm">{t('care.empty')}</p>}
        <ul className="flex flex-col gap-3">
          {rows.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              admissionId={admissionId}
              open={open}
              onDone={setDone}
            />
          ))}
        </ul>
        {plans.hasNextPage && (
          <div>
            <Button
              variant="outline"
              aria-disabled={plans.isFetchingNextPage || undefined}
              onClick={() => void plans.fetchNextPage()}
            >
              {t('care.loadMore')}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
