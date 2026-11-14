import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Can, usePermission } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import type { UnitFilters, UnitMove } from '../api';
import { refusalKey } from '../components/refusal';
import { DonorsPanel } from '../components/DonorsPanel';
import { CompatiblePanel } from '../components/CompatiblePanel';
import { DiscardDialog, HistoryDialog, RegisterDialog, ReserveDialog } from '../components/Dialogs';
import { ReactionDialog, TraceDialog } from '../components/ReactionDialogs';
import { CrossmatchDialog, ScreeningDialog } from '../components/TestingDialogs';
import { useMoveUnit, useStock, useUnits } from '../hooks/use-blood';
import { allowedMoves, BLOOD_COMPONENTS, BLOOD_GROUPS, UNIT_STATUSES } from '../schemas';
import type { BloodComponent, BloodGroup, BloodUnit, BloodUnitStatus } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';

type Dialogs =
  | { kind: 'register' }
  | {
      kind: 'reserve' | 'discard' | 'history' | 'screen' | 'crossmatch' | 'react' | 'trace';
      unit: BloodUnit;
    }
  | null;

function UnitsPanel() {
  const { t } = useTranslation('blood-bank');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const [status, setStatus] = useState<BloodUnitStatus | ''>('available');
  const [group, setGroup] = useState<BloodGroup | ''>('');
  const [component, setComponent] = useState<BloodComponent | ''>('');
  const filters: UnitFilters = {
    ...(status ? { status } : {}),
    ...(group ? { bloodGroup: group } : {}),
    ...(component ? { component } : {}),
  };
  const units = useUnits(filters);
  const stock = useStock();
  const move = useMoveUnit();
  const [open, setOpen] = useState<Dialogs>(null);
  const [done, setDone] = useState<string>();
  const statusLine = useRef<HTMLParagraphElement>(null);
  // A row that moved on has left the filtered list and may have taken focus with it.
  useEffect(() => {
    if (done) focusIfLost(statusLine.current);
  }, [done]);

  const rows = useMemo(() => units.data?.pages.flatMap((page) => page.items) ?? [], [units.data]);
  const total = units.data?.pages[0]?.total;

  const finish = (next: UnitMove) => {
    setOpen(null);
    setDone(t(`done.${next.to}`, { number: next.unit.unitNumber }));
  };

  const run = async (next: UnitMove) => {
    move.reset();
    setDone(undefined);
    try {
      await move.mutateAsync(next);
      finish(next);
    } catch {
      focusIfLost(statusLine.current);
    }
  };

  const pending = move.isPending;
  const actions: GridAction<BloodUnit>[] = [
    {
      id: 'test',
      label: t('actions.test'),
      requires: 'bloodUnit:manage',
      disabled: (row) => pending || !allowedMoves(row).test,
      onSelect: (row) => void run({ unit: row, to: 'testing' }),
    },
    {
      id: 'clear',
      label: t('actions.clear'),
      requires: 'bloodUnit:manage',
      // Not before the screening came back clear: the server refuses it too.
      disabled: (row) => pending || !allowedMoves(row).clear,
      onSelect: (row) => void run({ unit: row, to: 'available' }),
    },
    {
      id: 'screen',
      label: t('actions.screen'),
      requires: 'bloodUnit:test',
      disabled: (row) => pending || !allowedMoves(row).screen,
      onSelect: (row) => {
        move.reset();
        setOpen({ kind: 'screen', unit: row });
      },
    },
    {
      id: 'crossmatch',
      label: t('actions.crossmatch'),
      requires: 'bloodUnit:test',
      disabled: (row) => pending || !allowedMoves(row).crossmatch,
      onSelect: (row) => {
        move.reset();
        setOpen({ kind: 'crossmatch', unit: row });
      },
    },
    {
      id: 'reserve',
      label: t('actions.reserve'),
      requires: 'bloodUnit:issue',
      disabled: (row) => pending || !allowedMoves(row).reserve,
      onSelect: (row) => {
        move.reset();
        setOpen({ kind: 'reserve', unit: row });
      },
    },
    {
      id: 'release',
      label: t('actions.release'),
      requires: 'bloodUnit:issue',
      disabled: (row) => pending || !allowedMoves(row).release,
      onSelect: (row) => void run({ unit: row, to: 'available' }),
    },
    {
      id: 'issue',
      label: t('actions.issue'),
      requires: 'bloodUnit:issue',
      disabled: (row) => pending || !allowedMoves(row).issue,
      onSelect: (row) => void run({ unit: row, to: 'issued' }),
    },
    {
      id: 'transfuse',
      label: t('actions.transfuse'),
      requires: 'bloodUnit:issue',
      disabled: (row) => pending || !allowedMoves(row).transfuse,
      onSelect: (row) => void run({ unit: row, to: 'transfused' }),
    },
    {
      id: 'expire',
      label: t('actions.expire'),
      requires: 'bloodUnit:manage',
      disabled: (row) => pending || !allowedMoves(row).expire,
      onSelect: (row) => void run({ unit: row, to: 'expired' }),
    },
    {
      id: 'discard',
      label: t('actions.discard'),
      requires: 'bloodUnit:manage',
      disabled: (row) => pending || !allowedMoves(row).discard,
      onSelect: (row) => {
        move.reset();
        setOpen({ kind: 'discard', unit: row });
      },
    },
    {
      id: 'react',
      label: t('actions.react'),
      requires: 'transfusionReaction:record',
      disabled: (row) => pending || !allowedMoves(row).react,
      onSelect: (row) => {
        move.reset();
        setOpen({ kind: 'react', unit: row });
      },
    },
    {
      id: 'trace',
      label: t('actions.trace'),
      requires: 'transfusionReaction:read',
      disabled: () => false,
      onSelect: (row) => setOpen({ kind: 'trace', unit: row }),
    },
    {
      id: 'history',
      label: t('actions.history'),
      disabled: () => false,
      onSelect: (row) => setOpen({ kind: 'history', unit: row }),
    },
  ];

  const columns = useMemo<GridColumn<BloodUnit>[]>(
    () => [
      { id: 'unit', header: t('columns.unit'), value: (row) => row.unitNumber, hideable: false },
      { id: 'group', header: t('columns.group'), value: (row) => row.bloodGroup },
      {
        id: 'component',
        header: t('columns.component'),
        value: (row) => t(`component.${row.component}`),
      },
      { id: 'volume', header: t('columns.volume'), value: (row) => `${row.volumeMl} ml` },
      {
        id: 'status',
        header: t('columns.status'),
        value: (row) => t(`status.${row.status}`),
        hideable: false,
      },
      {
        id: 'collected',
        header: t('columns.collected'),
        value: (row) => format.dateTime(row.collectedAt),
      },
      {
        id: 'expires',
        header: t('columns.expires'),
        value: (row) => format.dateTime(row.expiresAt),
      },
    ],
    [t, format],
  );

  const refused = refusalKey(move.error);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="text-lg font-semibold">{t('units.heading')}</h2>
        <Can permission="bloodUnit:manage">
          <Button onClick={() => setOpen({ kind: 'register' })}>{t('register.open')}</Button>
        </Can>
      </div>

      <section aria-labelledby="blood-stock" className="flex flex-col gap-2">
        <h2 id="blood-stock" className="text-lg font-semibold">
          {t('stock.heading')}
        </h2>
        {stock.isError ? (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-sm text-destructive">
              {tCommon(errorMessageKey(stock.error))}
            </p>
            <Button variant="outline" onClick={() => void stock.refetch()}>
              {t('retry')}
            </Button>
          </div>
        ) : stock.isPending ? (
          <p className="text-sm text-muted-foreground">{t('stock.loading')}</p>
        ) : stock.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('stock.empty')}</p>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {stock.data.items.map((row) => (
              <li
                key={`${row.bloodGroup}-${row.component}`}
                className="rounded-md border p-3 text-sm"
              >
                <p className="font-medium">
                  {row.bloodGroup} {t(`component.${row.component}`)}
                </p>
                <p>{t('stock.available', { count: row.available })}</p>
                <p>{t('stock.reserved', { count: row.reserved })}</p>
                {row.nextExpiry && (
                  <p className="text-muted-foreground">
                    {t('stock.nextExpiry', { date: format.dateTime(row.nextExpiry) })}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Can permission="bloodUnit:issue">
        <CompatiblePanel />
      </Can>

      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-40 flex-col gap-1 text-sm font-medium">
          {t('filters.status')}
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as BloodUnitStatus | '')}
            className={control}
          >
            <option value="">{t('filters.any')}</option>
            {UNIT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`status.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-32 flex-col gap-1 text-sm font-medium">
          {t('filters.group')}
          <select
            value={group}
            onChange={(event) => setGroup(event.target.value as BloodGroup | '')}
            className={control}
          >
            <option value="">{t('filters.any')}</option>
            {BLOOD_GROUPS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-40 flex-col gap-1 text-sm font-medium">
          {t('filters.component')}
          <select
            value={component}
            onChange={(event) => setComponent(event.target.value as BloodComponent | '')}
            className={control}
          >
            <option value="">{t('filters.any')}</option>
            {BLOOD_COMPONENTS.map((value) => (
              <option key={value} value={value}>
                {t(`component.${value}`)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {move.isError && !open && (
        <p role="alert" className="text-sm text-destructive">
          {refused ? t(refused) : tCommon(errorMessageKey(move.error))}
        </p>
      )}
      {/* Always on the page, so a screen reader reads what is put in it; focusable, so focus has
          somewhere to go when the row it was on leaves the list. */}
      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm font-medium outline-none empty:sr-only focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {done ?? ''}
      </p>

      <p className="text-sm text-muted-foreground">
        {total === undefined || units.isPlaceholderData ? '' : t('count', { count: total })}
      </p>
      <DataGrid
        label={t('gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => t('rowLabel', { number: row.unitNumber, group: row.bloodGroup })}
        actions={units.isPlaceholderData ? [] : actions}
        status={units.isPending ? 'loading' : units.isError ? 'error' : 'ready'}
        errorMessage={units.isError ? tCommon(errorMessageKey(units.error)) : undefined}
        onRetry={() => void units.refetch()}
        emptyMessage={t('empty')}
        hasNextPage={units.hasNextPage && !units.isPlaceholderData}
        total={units.isPlaceholderData ? undefined : total}
        loadingMore={units.isFetchingNextPage}
        onLoadMore={() => void units.fetchNextPage()}
      />

      {open?.kind === 'register' && (
        <RegisterDialog
          onClose={() => setOpen(null)}
          onDone={(unit) => {
            setOpen(null);
            setDone(t('done.registered', { number: unit.unitNumber }));
          }}
        />
      )}
      {open?.kind === 'reserve' && (
        <ReserveDialog unit={open.unit} onClose={() => setOpen(null)} onDone={finish} />
      )}
      {open?.kind === 'discard' && (
        <DiscardDialog unit={open.unit} onClose={() => setOpen(null)} onDone={finish} />
      )}
      {open?.kind === 'history' && <HistoryDialog unit={open.unit} onClose={() => setOpen(null)} />}
      {open?.kind === 'trace' && <TraceDialog unit={open.unit} onClose={() => setOpen(null)} />}
      {open?.kind === 'screen' && (
        <ScreeningDialog
          unit={open.unit}
          onClose={() => setOpen(null)}
          onDone={(screening) => {
            const number = open.unit.unitNumber;
            setOpen(null);
            setDone(t(`done.screened_${screening.outcome}`, { number }));
          }}
        />
      )}
      {open?.kind === 'crossmatch' && (
        <CrossmatchDialog
          unit={open.unit}
          onClose={() => setOpen(null)}
          onDone={(match) => {
            const number = open.unit.unitNumber;
            setOpen(null);
            setDone(
              t(`done.crossmatch_${match.result}`, {
                number,
                until: format.dateTime(match.validUntil),
              }),
            );
          }}
        />
      )}
      {open?.kind === 'react' && (
        <ReactionDialog
          unit={open.unit}
          onClose={() => setOpen(null)}
          onDone={(reaction) => {
            const number = open.unit.unitNumber;
            const held = reaction.heldUnitIds?.length ?? 0;
            setOpen(null);
            setDone(t(held > 0 ? 'done.reactionHeld' : 'done.reaction', { number, count: held }));
          }}
        />
      )}
    </div>
  );
}

type Tab = 'units' | 'donors';

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function BloodBank() {
  const { t } = useTranslation('blood-bank');
  const canDonors = usePermission('bloodDonor:read');
  const [tab, setTab] = useState<Tab>('units');
  const tabs: Tab[] = canDonors ? ['units', 'donors'] : ['units'];
  const active = tabs.includes(tab) ? tab : 'units';
  const buttons = useRef(new Map<Tab, HTMLButtonElement>());

  // Arrow keys move between tabs and open them, as the tabs pattern expects.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.indexOf(active);
    const next =
      event.key === 'ArrowRight'
        ? tabs[(index + 1) % tabs.length]
        : event.key === 'ArrowLeft'
          ? tabs[(index - 1 + tabs.length) % tabs.length]
          : event.key === 'Home'
            ? tabs[0]
            : event.key === 'End'
              ? tabs[tabs.length - 1]
              : undefined;
    if (!next) return;
    event.preventDefault();
    setTab(next);
    buttons.current.get(next)?.focus();
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>
      {tabs.length > 1 && (
        // eslint-disable-next-line jsx-a11y/interactive-supports-focus -- the tabs are focusable, not the list
        <div
          role="tablist"
          aria-label={t('tabs.label')}
          onKeyDown={onKeyDown}
          className="flex gap-1 overflow-x-auto border-b"
        >
          {tabs.map((id) => (
            <button
              key={id}
              ref={(element) => {
                if (element) buttons.current.set(id, element);
                else buttons.current.delete(id);
              }}
              type="button"
              role="tab"
              id={`blood-tab-${id}`}
              aria-selected={active === id}
              aria-controls={`blood-panel-${id}`}
              tabIndex={active === id ? 0 : -1}
              onClick={() => setTab(id)}
              className={`-mb-px h-10 shrink-0 border-b-2 px-4 text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:h-11 ${
                active === id
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t(`tabs.${id}`)}
            </button>
          ))}
        </div>
      )}
      <div
        role={tabs.length > 1 ? 'tabpanel' : undefined}
        id={`blood-panel-${active}`}
        aria-labelledby={tabs.length > 1 ? `blood-tab-${active}` : undefined}
      >
        {active === 'donors' ? <DonorsPanel /> : <UnitsPanel />}
      </div>
    </div>
  );
}
