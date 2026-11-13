import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Can } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { Form, SelectField, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { todayIn } from '@/shared/utils';
import { maskMrn } from '@/shared/utils/mask';
import { useFormatters, useTenant } from '@/tenancy';
import { CorrectFluidDialog } from '../components/FluidDialog';
import {
  AMOUNT_MAX,
  FLUID_KINDS,
  fluidFormSchema,
  INTAKE_KINDS,
  type FluidValues,
} from '../care-schemas';
import { useFluids, useSaveFluid, useShiftTotals } from '../hooks/use-care';
import { useStay } from '../hooks/use-nursing';
import { shiftWindows } from '../shifts';
import type { WardFluid } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function Fluids() {
  const { t } = useTranslation('nursing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const timezone = useTenant()?.timezone ?? 'UTC';
  const { admissionId = '' } = useParams();
  const stay = useStay(admissionId);
  const [day, setDay] = useState(() => todayIn(timezone));
  const windows = useMemo(() => shiftWindows(day, timezone), [day, timezone]);
  const dayWindow = useMemo(
    () => ({ from: windows[0]?.from ?? '', to: windows[windows.length - 1]?.to ?? '' }),
    [windows],
  );
  const totals = useShiftTotals(admissionId, windows);
  const fluids = useFluids(admissionId, dayWindow);
  const save = useSaveFluid(admissionId);
  const form = useZodForm(fluidFormSchema, { kind: 'oral', amount: '' });
  const [correcting, setCorrecting] = useState<WardFluid>();
  const [done, setDone] = useState('');
  const statusLine = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (done) focusIfLost(statusLine.current);
  }, [done]);

  const rows = useMemo(() => fluids.data?.pages.flatMap((page) => page.items) ?? [], [fluids.data]);
  const open = stay.data?.status === 'admitted';

  const refusal = (error: unknown): string =>
    isApiError(error) && error.serverCode === 'admission_not_open'
      ? t('fluids.refused.notOpen')
      : tCommon(errorMessageKey(error));

  const submit = async (values: FluidValues) => {
    setDone('');
    try {
      await save.mutateAsync({
        kind: 'record',
        body: { kind: values.kind, amountMl: Number(values.amount) },
      });
      form.reset({ kind: values.kind, amount: '' });
      setDone(t('fluids.done.recorded'));
    } catch {
      focusIfLost(statusLine.current);
    }
  };

  const columns = useMemo<GridColumn<WardFluid>[]>(
    () => [
      {
        id: 'time',
        header: t('fluids.columns.time'),
        value: (row) => format.dateTime(row.observedAt),
        hideable: false,
      },
      {
        id: 'kind',
        header: t('fluids.columns.kind'),
        value: (row) =>
          `${t(`fluids.directions.${row.direction}`)}: ${t(`fluids.kinds.${row.kind}`)}`,
      },
      {
        id: 'amount',
        header: t('fluids.columns.amount'),
        value: (row) => t('fluids.ml', { amount: row.amountMl }),
      },
      { id: 'by', header: t('columns.by'), value: (row) => row.recordedByName },
      {
        id: 'status',
        header: t('fluids.columns.status'),
        value: (row) =>
          row.correctedById
            ? t('fluids.corrected')
            : row.correctsId
              ? t('fluids.correction', { reason: row.correctionReason ?? '' })
              : '',
      },
    ],
    [t, format],
  );

  const actions: GridAction<WardFluid>[] = [
    {
      id: 'correct',
      label: t('fluids.correct'),
      requires: 'fluidBalance:record',
      // An entry is corrected once, and only while the patient is admitted.
      disabled: (row) => !open || row.correctedById !== undefined,
      onSelect: (row) => setCorrecting(row),
    },
  ];

  const sum = (pick: 'intakeMl' | 'outputMl' | 'balanceMl') =>
    totals.reduce((total, each) => total + (each.data?.[pick] ?? 0), 0);
  const signed = (amount: number) =>
    t('fluids.ml', { amount: format.number(amount, { signDisplay: 'exceptZero' }) });
  const totalsReady = totals.every((each) => each.isSuccess);
  const totalsFailed = totals.find((each) => each.isError);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
      <div className="space-y-1">
        <Link to="/nursing" className="text-sm underline underline-offset-2">
          {t('back')}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {stay.data
            ? t('fluids.heading', { patient: stay.data.patientName })
            : t('fluids.loading')}
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
      {stay.data && !open && <p className="text-sm font-medium">{t('fluids.closed')}</p>}

      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm font-medium outline-none empty:sr-only focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {done}
      </p>

      <label className="flex max-w-xs flex-col gap-1 text-sm font-medium">
        {t('fluids.day')}
        <input
          type="date"
          value={day}
          max={todayIn(timezone)}
          onChange={(event) => event.target.value && setDay(event.target.value)}
          className={control}
        />
      </label>

      <section aria-labelledby="totals-heading" className="flex flex-col gap-3">
        <h2 id="totals-heading" className="text-lg font-semibold">
          {t('fluids.totalsHeading')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('fluids.totalsHint')}</p>
        {totalsFailed && (
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(totalsFailed.error))}
          </p>
        )}
        <div>
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">{t('fluids.totalsHeading')}</caption>
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t('fluids.shift')}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t('fluids.intake')}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t('fluids.output')}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t('fluids.balance')}
                </th>
              </tr>
            </thead>
            <tbody>
              {windows.map((window, index) => {
                const each = totals[index]?.data;
                return (
                  <tr key={window.id} className="border-b">
                    <th scope="row" className="py-2 pr-4 text-left font-medium">
                      {t(`shifts.${window.id}`)}
                      <span className="block text-xs font-normal text-muted-foreground">
                        {t('fluids.window', {
                          from: format.time(window.from),
                          to: format.time(window.to),
                        })}
                      </span>
                    </th>
                    <td className="py-2 pr-4">
                      {each ? t('fluids.ml', { amount: each.intakeMl }) : t('fluids.dash')}
                    </td>
                    <td className="py-2 pr-4">
                      {each ? t('fluids.ml', { amount: each.outputMl }) : t('fluids.dash')}
                    </td>
                    <td className="py-2">{each ? signed(each.balanceMl) : t('fluids.dash')}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <th scope="row" className="py-2 pr-4 text-left">
                  {t('fluids.dayTotal')}
                </th>
                <td className="py-2 pr-4">
                  {totalsReady ? t('fluids.ml', { amount: sum('intakeMl') }) : t('fluids.dash')}
                </td>
                <td className="py-2 pr-4">
                  {totalsReady ? t('fluids.ml', { amount: sum('outputMl') }) : t('fluids.dash')}
                </td>
                <td className="py-2">
                  {totalsReady ? signed(sum('balanceMl')) : t('fluids.dash')}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <Can permission="fluidBalance:record">
        {open && (
          <section
            aria-labelledby="fluid-add-heading"
            className="flex flex-col gap-3 rounded-md border p-4"
          >
            <h2 id="fluid-add-heading" className="text-lg font-semibold">
              {t('fluids.addHeading')}
            </h2>
            <Form form={form} onSubmit={(values: FluidValues) => void submit(values)}>
              <SelectField<FluidValues>
                name="kind"
                label={t('fluids.kind')}
                options={FLUID_KINDS.map((value) => ({
                  value,
                  label: `${t(
                    (INTAKE_KINDS as readonly string[]).includes(value)
                      ? 'fluids.directions.intake'
                      : 'fluids.directions.output',
                  )}: ${t(`fluids.kinds.${value}`)}`,
                }))}
              />
              <TextField<FluidValues>
                name="amount"
                label={t('fluids.amount', { max: AMOUNT_MAX })}
                inputMode="numeric"
                autoComplete="off"
                maxLength={4}
                required
              />
              {save.isError && (
                <p role="alert" className="text-sm text-destructive">
                  {refusal(save.error)}
                </p>
              )}
              <div>
                <SubmitButton pending={save.isPending}>{t('fluids.add')}</SubmitButton>
              </div>
            </Form>
          </section>
        )}
      </Can>

      <DataGrid
        label={t('fluids.gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => t('fluids.rowLabel', { time: format.dateTime(row.observedAt) })}
        actions={actions}
        status={fluids.isPending ? 'loading' : fluids.isError ? 'error' : 'ready'}
        errorMessage={fluids.isError ? tCommon(errorMessageKey(fluids.error)) : undefined}
        onRetry={() => void fluids.refetch()}
        emptyMessage={t('fluids.empty')}
        hasNextPage={fluids.hasNextPage}
        loadingMore={fluids.isFetchingNextPage}
        onLoadMore={() => void fluids.fetchNextPage()}
      />

      {correcting && (
        <CorrectFluidDialog
          entry={correcting}
          admissionId={admissionId}
          onClose={() => setCorrecting(undefined)}
          onSaved={(message) => {
            setCorrecting(undefined);
            setDone(message);
          }}
        />
      )}
    </div>
  );
}
