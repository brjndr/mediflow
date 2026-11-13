import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Can } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { Form, SelectField, SubmitButton, TextAreaField, useZodForm } from '@/shared/ui/form';
import { maskMrn } from '@/shared/utils/mask';
import { useFormatters } from '@/tenancy';
import { DIET_MAX, DIET_PRIORITIES, dietFormSchema, type DietValues } from '../diet-schemas';
import { usePlaceDiet, useStayDiet } from '../hooks/use-diet';
import { useStay } from '../hooks/use-nursing';
import type { WardDietOrder } from '../types';

/** An order still being carried out: the kitchen works from the newest of these. */
const live = (order: WardDietOrder) => order.status !== 'completed';

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function Diet() {
  const { t } = useTranslation('nursing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const { admissionId = '' } = useParams();
  const stay = useStay(admissionId);
  const diet = useStayDiet(admissionId);
  const place = usePlaceDiet(stay.data?.encounterId ?? '');
  const form = useZodForm(dietFormSchema, { instructions: '', priority: 'routine' });
  const [done, setDone] = useState('');
  const statusLine = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (done) focusIfLost(statusLine.current);
  }, [done]);

  const open = stay.data?.status === 'admitted';
  const rows = useMemo(() => diet.data?.items ?? [], [diet.data]);
  const currentId = rows.find(live)?.id;

  const refusal = (error: unknown): string => {
    if (isApiError(error) && error.serverCode === 'encounter_not_open') {
      return t('diet.refused.notOpen');
    }
    return tCommon(errorMessageKey(error));
  };

  const submit = async (values: DietValues) => {
    setDone('');
    try {
      await place.mutateAsync(values);
      form.reset({ instructions: '', priority: 'routine' });
      setDone(t('diet.done.placed'));
    } catch {
      focusIfLost(statusLine.current);
    }
  };

  const columns = useMemo<GridColumn<WardDietOrder>[]>(
    () => [
      {
        id: 'instructions',
        header: t('diet.columns.instructions'),
        value: (row) => row.instructions,
        hideable: false,
      },
      {
        id: 'current',
        header: t('diet.columns.current'),
        // A word, not only a position in the list.
        value: (row) => (row.id === currentId ? t('diet.current') : ''),
      },
      {
        id: 'priority',
        header: t('kitchen.columns.priority'),
        value: (row) => t(`diet.priority.${row.priority}`),
      },
      {
        id: 'status',
        header: t('kitchen.columns.status'),
        value: (row) => t(`diet.status.${row.status}`),
      },
      {
        id: 'ordered',
        header: t('kitchen.columns.ordered'),
        value: (row) => format.dateTime(row.placedAt),
      },
    ],
    [t, format, currentId],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
      <div className="space-y-1">
        <Link to="/nursing/kitchen" className="text-sm underline underline-offset-2">
          {t('diet.back')}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {stay.data ? t('diet.heading', { patient: stay.data.patientName }) : t('diet.loading')}
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
      {stay.data && !open && <p className="text-sm font-medium">{t('diet.closed')}</p>}

      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm font-medium outline-none empty:sr-only focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {done}
      </p>

      <Can permission="order:create">
        {open && (
          <section
            aria-labelledby="diet-add-heading"
            className="flex flex-col gap-3 rounded-md border p-4"
          >
            <h2 id="diet-add-heading" className="text-lg font-semibold">
              {t('diet.addHeading')}
            </h2>
            <p className="text-sm text-muted-foreground">{t('diet.addHint')}</p>
            <Form form={form} onSubmit={(values: DietValues) => void submit(values)}>
              <TextAreaField<DietValues>
                name="instructions"
                label={t('diet.instructions', { max: DIET_MAX })}
                maxLength={DIET_MAX}
                required
              />
              <SelectField<DietValues>
                name="priority"
                label={t('diet.priorityLabel')}
                options={DIET_PRIORITIES.map((value) => ({
                  value,
                  label: t(`diet.priority.${value}`),
                }))}
              />
              {place.isError && (
                <p role="alert" className="text-sm text-destructive">
                  {refusal(place.error)}
                </p>
              )}
              <div>
                <SubmitButton pending={place.isPending}>{t('diet.place')}</SubmitButton>
              </div>
            </Form>
          </section>
        )}
      </Can>

      <DataGrid
        label={t('diet.gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => t('diet.rowLabel', { time: format.dateTime(row.placedAt) })}
        status={diet.isPending ? 'loading' : diet.isError ? 'error' : 'ready'}
        errorMessage={diet.isError ? tCommon(errorMessageKey(diet.error)) : undefined}
        onRetry={() => void diet.refetch()}
        emptyMessage={t('diet.empty')}
      />
    </div>
  );
}
