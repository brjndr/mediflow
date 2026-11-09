import { AlertTriangle, CheckCircle2, TrendingUp } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Can } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { TimeSeriesChart } from '@/shared/ui/charts';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { maskMrn } from '@/shared/utils/mask';
import { useFormatters } from '@/tenancy';
import { isWorsening, scoreReading, type EwsLevel } from '../ews';
import { useEwsConfig, useSaveVitals, useStay, useWardVitals } from '../hooks/use-nursing';
import {
  blankVitals,
  fromReading,
  isDecimal,
  MEASURES,
  REASON_MAX,
  toMeasures,
  vitalsFormSchema,
  type Measure,
  type VitalsValues,
} from '../schemas';
import type { WardVital } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';

type ChartMeasure = Measure | 'score';
const CHART_MEASURES: ChartMeasure[] = ['score', 'systolic', 'pulse', 'temperature', 'spo2'];

/** A level is a word and an icon, never a colour alone. */
function LevelBadge({ level, score }: { level: EwsLevel; score: number }) {
  const { t } = useTranslation('nursing');
  const Icon = level === 'normal' ? CheckCircle2 : AlertTriangle;
  const tone =
    level === 'urgent'
      ? 'bg-destructive/10 text-destructive'
      : level === 'attention'
        ? 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200'
        : 'bg-muted text-foreground';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-sm font-medium ${tone}`}
    >
      <Icon aria-hidden="true" className="size-4" />
      {t('score.badge', { score, level: t(`score.level.${level}`) })}
    </span>
  );
}

function VitalsForm({
  initial,
  correcting,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  initial: VitalsValues;
  correcting: boolean;
  pending: boolean;
  error: string | null;
  onSubmit: (values: VitalsValues) => void;
  onCancel?: () => void;
}) {
  const { t } = useTranslation('nursing');
  const form = useZodForm(vitalsFormSchema(correcting), initial);
  const field = (name: Measure) => (
    <TextField<VitalsValues>
      key={name}
      name={name}
      label={t(`form.${name}`)}
      inputMode={isDecimal(name) ? 'decimal' : 'numeric'}
      maxLength={5}
      autoComplete="off"
    />
  );
  return (
    <Form form={form} onSubmit={onSubmit}>
      <div className="grid grid-cols-2 items-start gap-3 sm:grid-cols-5">{MEASURES.map(field)}</div>
      {correcting && (
        <TextField<VitalsValues>
          name="reason"
          label={t('form.reason')}
          required
          maxLength={REASON_MAX}
          autoComplete="off"
        />
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <SubmitButton pending={pending}>
          {correcting ? t('form.correct') : t('form.record')}
        </SubmitButton>
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('form.cancel')}
          </Button>
        )}
      </div>
    </Form>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function WardVitals() {
  const { t } = useTranslation('nursing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const { admissionId = '' } = useParams();
  const stay = useStay(admissionId);
  const vitals = useWardVitals(admissionId);
  const save = useSaveVitals(admissionId);
  const config = useEwsConfig();
  const [correcting, setCorrecting] = useState<WardVital | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [chartMeasure, setChartMeasure] = useState<ChartMeasure>('score');
  const [done, setDone] = useState('');
  const statusLine = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (done) focusIfLost(statusLine.current);
  }, [done]);

  const rows = useMemo(() => vitals.data?.pages.flatMap((page) => page.items) ?? [], [vitals.data]);
  // Readings that were corrected no longer stand: the chart and the score use the others.
  const standing = useMemo(
    () =>
      rows
        .filter((row) => row.correctedById === undefined)
        .sort((a, b) => a.observedAt.localeCompare(b.observedAt)),
    [rows],
  );
  const scored = useMemo(
    () => standing.map((row) => ({ row, ews: scoreReading(row, config) })),
    [standing, config],
  );
  const scores = scored.flatMap((each) => (each.ews ? [each.ews.score] : []));
  const latest = [...scored].reverse().find((each) => each.ews !== null)?.ews ?? null;
  const worsening = isWorsening(scores);

  const chartData = useMemo(
    () =>
      scored.flatMap(({ row, ews }) => {
        const value = chartMeasure === 'score' ? ews?.score : row[chartMeasure];
        return value === undefined || value === null
          ? []
          : [{ label: format.dateTime(row.observedAt), value }];
      }),
    [scored, chartMeasure, format],
  );

  const refusal = (error: unknown): string => {
    if (isApiError(error)) {
      if (error.serverCode === 'admission_not_open') return t('refused.notOpen');
      if (error.serverCode === 'already_corrected') return t('refused.alreadyCorrected');
    }
    return tCommon(errorMessageKey(error));
  };

  const submit = async (values: VitalsValues) => {
    save.reset();
    setDone('');
    try {
      if (correcting) {
        await save.mutateAsync({
          kind: 'correct',
          reading: correcting,
          body: { ...toMeasures(values), reason: values.reason },
        });
        setCorrecting(null);
        setDone(t('done.corrected'));
      } else {
        await save.mutateAsync({ kind: 'record', body: toMeasures(values) });
        setDone(t('done.recorded'));
      }
      setFormKey((key) => key + 1);
    } catch {
      focusIfLost(statusLine.current);
    }
  };

  const flagged = (row: WardVital, name: Measure): string => {
    const value = row[name];
    if (value === undefined) return '';
    const flag = row.flags?.[name];
    return flag ? `${value} (${t(`flag.${flag}`)})` : String(value);
  };

  const columns = useMemo<GridColumn<WardVital>[]>(
    () => [
      {
        id: 'observedAt',
        header: t('columns.observedAt'),
        value: (row) => format.dateTime(row.observedAt),
        hideable: false,
      },
      {
        id: 'pressure',
        header: t('columns.pressure'),
        value: (row) => {
          if (row.systolic === undefined || row.diastolic === undefined) return '';
          const flag = row.flags?.systolic ?? row.flags?.diastolic;
          const text = row.systolic + '/' + row.diastolic;
          return flag ? text + ' (' + t('flag.' + flag) + ')' : text;
        },
      },
      { id: 'pulse', header: t('columns.pulse'), value: (row) => flagged(row, 'pulse') },
      {
        id: 'temperature',
        header: t('columns.temperature'),
        value: (row) => flagged(row, 'temperature'),
      },
      { id: 'spo2', header: t('columns.spo2'), value: (row) => flagged(row, 'spo2') },
      {
        id: 'score',
        header: t('columns.score'),
        value: (row) => {
          const ews = scoreReading(row, config);
          return ews
            ? t('score.badge', { score: ews.score, level: t(`score.level.${ews.level}`) })
            : '';
        },
        render: (row, text) => {
          const ews = scoreReading(row, config);
          return ews ? <LevelBadge level={ews.level} score={ews.score} /> : text;
        },
      },
      { id: 'by', header: t('columns.by'), value: (row) => row.recordedByName },
      {
        id: 'note',
        header: t('columns.note'),
        value: (row) =>
          row.correctedById
            ? t('corrected')
            : row.correctsId
              ? t('correction', { reason: row.correctionReason ?? '' })
              : '',
      },
    ],
    // `flagged` only reads translations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, format, config],
  );

  const actions: GridAction<WardVital>[] = [
    {
      id: 'correct',
      label: t('actions.correct'),
      requires: 'nursingVitals:record',
      disabled: (row) => row.correctedById !== undefined || save.isPending,
      onSelect: (row) => {
        save.reset();
        setDone('');
        setCorrecting(row);
      },
    },
  ];

  if (stay.isError) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
        <p role="alert" className="text-sm text-destructive">
          {refusal(stay.error)}
        </p>
        <Button asChild variant="outline" className="self-start">
          <Link to="/nursing">{t('back')}</Link>
        </Button>
      </div>
    );
  }

  const open = stay.data?.status === 'admitted';

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <Link to="/nursing" className="text-sm underline underline-offset-4">
          {t('back')}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {stay.data ? t('vitalsHeading', { patient: stay.data.patientName }) : t('vitalsLoading')}
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

      <section aria-labelledby="ews-heading" className="flex flex-col gap-2 rounded-md border p-4">
        <h2 id="ews-heading" className="text-lg font-semibold">
          {t('score.heading')}
        </h2>
        {latest ? (
          <>
            <p className="flex flex-wrap items-center gap-2">
              <LevelBadge level={latest.level} score={latest.score} />
              <span className="text-sm text-muted-foreground">
                {t('score.measured', { count: latest.measured })}
              </span>
            </p>
            {latest.level !== 'normal' && (
              <p className="text-sm font-medium">{t(`score.advice.${latest.level}`)}</p>
            )}
            {worsening && (
              <p className="flex items-center gap-1 text-sm font-medium text-destructive">
                <TrendingUp aria-hidden="true" className="size-4" />
                {t('score.worsening')}
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t('score.none')}</p>
        )}
        <p className="text-xs text-muted-foreground">{t('score.note')}</p>
      </section>

      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm font-medium outline-none empty:sr-only focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {done}
      </p>

      <Can permission="nursingVitals:record">
        {open && (
          <section
            aria-labelledby="record-heading"
            className="flex flex-col gap-3 rounded-md border p-4"
          >
            <h2
              id="record-heading"
              data-panel-heading
              tabIndex={-1}
              className="rounded-sm text-lg font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {correcting
                ? t('form.correctHeading', { time: format.dateTime(correcting.observedAt) })
                : t('form.heading')}
            </h2>
            <VitalsForm
              key={`${formKey}-${correcting?.id ?? 'new'}`}
              initial={correcting ? fromReading(correcting) : blankVitals}
              correcting={correcting !== null}
              pending={save.isPending}
              error={save.isError ? refusal(save.error) : null}
              onSubmit={(values) => void submit(values)}
              onCancel={correcting ? () => setCorrecting(null) : undefined}
            />
          </section>
        )}
      </Can>

      <section aria-labelledby="trend-heading" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 id="trend-heading" className="text-lg font-semibold">
            {t('trend.heading')}
          </h2>
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t('trend.measure')}
            <select
              value={chartMeasure}
              onChange={(event) => setChartMeasure(event.target.value as ChartMeasure)}
              className={control}
            >
              {CHART_MEASURES.map((each) => (
                <option key={each} value={each}>
                  {t(`trend.${each}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {chartData.length > 0 ? (
          <TimeSeriesChart
            title={t('trend.title', { measure: t(`trend.${chartMeasure}`) })}
            labelHeader={t('columns.observedAt')}
            valueHeader={t(`trend.${chartMeasure}`)}
            data={chartData}
            dots
          />
        ) : (
          !vitals.isPending && <p className="text-sm text-muted-foreground">{t('trend.none')}</p>
        )}
      </section>

      <DataGrid
        label={t('vitalsGrid')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => t('vitalsRowLabel', { time: format.dateTime(row.observedAt) })}
        actions={open ? actions : []}
        status={vitals.isPending ? 'loading' : vitals.isError ? 'error' : 'ready'}
        errorMessage={vitals.isError ? tCommon(errorMessageKey(vitals.error)) : undefined}
        onRetry={() => void vitals.refetch()}
        emptyMessage={t('vitalsEmpty')}
        hasNextPage={vitals.hasNextPage}
        loadingMore={vitals.isFetchingNextPage}
        onLoadMore={() => void vitals.fetchNextPage()}
      />
    </div>
  );
}
