import { AlertTriangle, Clock } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { usePermission } from '@/access';
import { allergyCovers } from '@/features/clinical';
import { useAllergies } from '@/features/triage';
import { errorMessageKey } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { todayIn } from '@/shared/utils';
import { maskMrn } from '@/shared/utils/mask';
import { useFormatters, useTenant } from '@/tenancy';
import { MarDialog, type MarTarget } from '../components/MarDialog';
import { useMarEntries, useMarOrders } from '../hooks/use-mar';
import { useStay } from '../hooks/use-nursing';
import { slotsOn, slotState, slotTimes, standingEntry, type SlotState } from '../mar-schedule';
import type { MarEntry, MarOrder } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';
/** The API refuses a dose due more than a day ahead. */
const AHEAD_MS = 24 * 60 * 60_000;

/** A dose of the day: due at a time, or (an order with no times) charted as it is given. */
interface DoseRow {
  id: string;
  order: MarOrder;
  scheduledAt: string | null;
  entry?: MarEntry;
}

/** A state is a word and an icon, never a colour alone. */
function StateBadge({ state }: { state: SlotState }) {
  const { t } = useTranslation('nursing');
  const Icon = state === 'overdue' ? AlertTriangle : Clock;
  const tone =
    state === 'overdue'
      ? 'bg-destructive/10 text-destructive'
      : state === 'due'
        ? 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200'
        : 'bg-muted text-foreground';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-sm font-medium ${tone}`}
    >
      <Icon aria-hidden="true" className="size-4" />
      {t(`mar.state.${state}`)}
    </span>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function Mar() {
  const { t } = useTranslation('nursing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const timezone = useTenant()?.timezone ?? 'UTC';
  const { admissionId = '' } = useParams();
  const stay = useStay(admissionId);
  const orders = useMarOrders(admissionId);
  const entries = useMarEntries(admissionId);
  const canRecord = usePermission('mar:record');
  const canSeeAllergies = usePermission('allergy:read');
  const allergies = useAllergies(stay.data?.patientId ?? '', { enabled: canSeeAllergies });

  const [day, setDay] = useState(() => todayIn(timezone));
  const [target, setTarget] = useState<MarTarget>();
  const [done, setDone] = useState('');
  const statusLine = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (done) focusIfLost(statusLine.current);
  }, [done]);

  const orderRows = useMemo(() => orders.data?.items ?? [], [orders.data]);
  const entryRows = useMemo(
    () => entries.data?.pages.flatMap((page) => page.items) ?? [],
    [entries.data],
  );
  const open = stay.data?.status === 'admitted';
  const orderName = (id: string) => orderRows.find((each) => each.id === id)?.itemName ?? '';

  /** The patient's recorded allergies that cover a medicine. */
  const allergiesFor = (order: MarOrder): string[] =>
    (allergies.data?.items ?? [])
      .filter((each) => allergyCovers(each, [order.itemName]))
      .map((each) => each.substance);

  const doseRows = useMemo<DoseRow[]>(() => {
    const live = orderRows.filter((each) => each.status !== 'cancelled');
    const scheduled = slotsOn(
      live.filter((each) => slotTimes(each.frequency) !== null),
      day,
      timezone,
    ).map<DoseRow>((slot) => {
      const entry = standingEntry(entryRows, slot.order.id, slot.scheduledAt);
      return {
        id: `${slot.order.id}@${slot.scheduledAt}`,
        order: slot.order,
        scheduledAt: slot.scheduledAt,
        ...(entry ? { entry } : {}),
      };
    });
    const unscheduled = live
      .filter((each) => slotTimes(each.frequency) === null)
      .map<DoseRow>((order) => ({ id: `${order.id}@asneeded`, order, scheduledAt: null }));
    return [...scheduled, ...unscheduled].sort((a, b) =>
      (a.scheduledAt ?? '9').localeCompare(b.scheduledAt ?? '9'),
    );
  }, [orderRows, entryRows, day, timezone]);

  const outcomeText = (entry: MarEntry): string => {
    const base = t(`mar.outcomes.${entry.outcome}`);
    return entry.reason ? `${base}: ${entry.reason}` : base;
  };

  const scheduleColumns = useMemo<GridColumn<DoseRow>[]>(
    () => [
      {
        id: 'medicine',
        header: t('mar.columns.medicine'),
        value: (row) => row.order.itemName,
        hideable: false,
      },
      {
        id: 'ordered',
        header: t('mar.columns.ordered'),
        value: (row) =>
          t('mar.ordered', {
            dose: row.order.dose,
            route: row.order.route,
            frequency: row.order.frequency,
          }),
      },
      {
        id: 'due',
        header: t('mar.columns.due'),
        value: (row) => (row.scheduledAt ? format.dateTime(row.scheduledAt) : t('mar.asNeeded')),
      },
      {
        id: 'state',
        header: t('mar.columns.state'),
        value: (row) =>
          row.entry
            ? outcomeText(row.entry)
            : row.scheduledAt
              ? t(`mar.state.${slotState(row.scheduledAt, false, new Date())}`)
              : '',
        render: (row, text) =>
          !row.entry && row.scheduledAt ? (
            <StateBadge state={slotState(row.scheduledAt, false, new Date())} />
          ) : (
            text
          ),
      },
      {
        id: 'by',
        header: t('mar.columns.by'),
        value: (row) => row.entry?.recordedByName ?? '',
      },
    ],
    // `outcomeText` only reads translations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, format],
  );

  const tooFar = (row: DoseRow) =>
    row.scheduledAt !== null && new Date(row.scheduledAt).getTime() > Date.now() + AHEAD_MS;

  const scheduleActions: GridAction<DoseRow>[] = [
    {
      id: 'record',
      label: t('mar.actions.record'),
      requires: 'mar:record',
      // Not before the allergies are known: the check must be made against them.
      disabled: (row) =>
        !open || row.entry !== undefined || tooFar(row) || (canSeeAllergies && allergies.isPending),
      onSelect: (row) => {
        setDone('');
        // As needed: the dose is charted for the minute it is given.
        const at =
          row.scheduledAt ?? new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
        setTarget({ order: row.order, scheduledAt: at });
      },
    },
    {
      id: 'amend',
      label: t('mar.actions.amend'),
      requires: 'mar:record',
      disabled: (row) => !open || row.entry === undefined,
      onSelect: (row) => {
        if (!row.entry) return;
        setDone('');
        setTarget({ order: row.order, scheduledAt: row.entry.scheduledAt, entry: row.entry });
      },
    },
  ];

  const historyColumns = useMemo<GridColumn<MarEntry>[]>(
    () => [
      {
        id: 'medicine',
        header: t('mar.columns.medicine'),
        value: (row) => orderName(row.orderId),
        hideable: false,
      },
      {
        id: 'due',
        header: t('mar.columns.due'),
        value: (row) => format.dateTime(row.scheduledAt),
      },
      { id: 'outcome', header: t('mar.columns.outcome'), value: (row) => outcomeText(row) },
      {
        id: 'dose',
        header: t('mar.columns.dose'),
        value: (row) => (row.doseGiven ? [row.doseGiven, row.route].filter(Boolean).join(' ') : ''),
      },
      {
        id: 'given',
        header: t('mar.columns.administeredAt'),
        value: (row) => (row.administeredAt ? format.dateTime(row.administeredAt) : ''),
      },
      { id: 'by', header: t('mar.columns.by'), value: (row) => row.recordedByName },
      {
        id: 'note',
        header: t('columns.note'),
        value: (row) =>
          row.correctedById ? t('mar.amended') : row.correctsId ? t('mar.amendment') : '',
      },
    ],
    // `orderName` and `outcomeText` read the orders and translations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, format, orderRows],
  );

  if (stay.isError) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(stay.error))}
        </p>
        <Button asChild variant="outline" className="self-start">
          <Link to="/nursing">{t('back')}</Link>
        </Button>
      </div>
    );
  }

  const listed = allergies.data?.items ?? [];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <Link to="/nursing" className="text-sm underline underline-offset-4">
          {t('back')}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {stay.data ? t('mar.heading', { patient: stay.data.patientName }) : t('mar.loading')}
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

      <section
        aria-labelledby="mar-allergies"
        className="flex flex-col gap-1 rounded-md border p-4"
      >
        <h2 id="mar-allergies" className="text-lg font-semibold">
          {t('mar.allergies.heading')}
        </h2>
        {!canSeeAllergies ? (
          <p className="text-sm text-muted-foreground">{t('mar.allergies.hidden')}</p>
        ) : allergies.isPending ? (
          <p className="text-sm text-muted-foreground">{t('mar.allergies.loading')}</p>
        ) : allergies.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {t('mar.allergies.error')}
          </p>
        ) : listed.length > 0 ? (
          <ul className="list-disc pl-5 text-sm">
            {listed.map((each) => (
              <li key={each.substance}>
                {each.substance}
                {each.reaction ? ` (${each.reaction})` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {allergies.data?.status === 'unknown'
              ? t('mar.allergies.unknown')
              : t('mar.allergies.none')}
          </p>
        )}
      </section>

      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm font-medium outline-none empty:sr-only focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {done}
      </p>
      {stay.data && !open && (
        <p className="text-sm text-muted-foreground">{t('refused.notOpen')}</p>
      )}

      <section aria-labelledby="mar-schedule" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 id="mar-schedule" className="text-lg font-semibold">
            {t('mar.schedule')}
          </h2>
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t('mar.day')}
            <input
              type="date"
              value={day}
              onChange={(event) => event.target.value && setDay(event.target.value)}
              className={control}
            />
          </label>
        </div>
        <DataGrid
          label={t('mar.scheduleGrid')}
          columns={scheduleColumns}
          rows={doseRows}
          rowId={(row) => row.id}
          rowLabel={(row) =>
            t('mar.rowLabel', {
              medicine: row.order.itemName,
              time: row.scheduledAt ? format.dateTime(row.scheduledAt) : t('mar.asNeeded'),
            })
          }
          actions={canRecord ? scheduleActions : []}
          status={orders.isPending ? 'loading' : orders.isError ? 'error' : 'ready'}
          errorMessage={orders.isError ? tCommon(errorMessageKey(orders.error)) : undefined}
          onRetry={() => void orders.refetch()}
          emptyMessage={t('mar.scheduleEmpty')}
        />
      </section>

      <section aria-labelledby="mar-history" className="flex flex-col gap-2">
        <h2 id="mar-history" className="text-lg font-semibold">
          {t('mar.history')}
        </h2>
        <DataGrid
          label={t('mar.historyGrid')}
          columns={historyColumns}
          rows={entryRows}
          rowId={(row) => row.id}
          rowLabel={(row) =>
            t('mar.rowLabel', {
              medicine: orderName(row.orderId),
              time: format.dateTime(row.scheduledAt),
            })
          }
          status={entries.isPending ? 'loading' : entries.isError ? 'error' : 'ready'}
          errorMessage={entries.isError ? tCommon(errorMessageKey(entries.error)) : undefined}
          onRetry={() => void entries.refetch()}
          emptyMessage={t('mar.historyEmpty')}
          hasNextPage={entries.hasNextPage}
          loadingMore={entries.isFetchingNextPage}
          onLoadMore={() => void entries.fetchNextPage()}
        />
      </section>

      {target && (
        <MarDialog
          key={`${target.order.id}@${target.scheduledAt}@${target.entry?.id ?? 'new'}`}
          target={target}
          admissionId={admissionId}
          allergies={allergiesFor(target.order)}
          onClose={() => {
            setTarget(undefined);
            setTimeout(() => focusIfLost(statusLine.current), 0);
          }}
          onSaved={(message) => {
            setTarget(undefined);
            setDone(message);
          }}
        />
      )}
    </div>
  );
}
