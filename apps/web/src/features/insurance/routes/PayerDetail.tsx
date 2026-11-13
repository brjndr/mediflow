import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Can, usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { Form, SubmitButton, useZodForm } from '@/shared/ui/form';
import { PageSkeleton } from '@/shared/ui/page-skeleton';
import { SystemPage } from '@/shared/ui/system-page';
import { useFormatters, useTenant } from '@/tenancy';
import { AgreementDialog } from '../components/AgreementDialog';
import { PayerFields } from '../components/PayerFields';
import { PlanDialog } from '../components/PlanDialog';
import { refusalKey } from '../components/refusal';
import { useEndAgreement, usePayer, useUpdatePayer, useUpdatePlan } from '../hooks/use-payers';
import {
  payerFormSchema,
  toPayerFormValues,
  type PayerField,
  type PayerFormValues,
} from '../schemas';
import type { Payer, PayerPlan, RateAgreement } from '../types';

const link =
  'inline-flex items-center rounded-sm text-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';
const FIELDS: PayerField[] = ['name', 'contactName', 'phone', 'email', 'address'];

/** Today as a calendar date on the hospital's clock. */
function todayAt(timeZone: string | undefined): string {
  try {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** The details of the organisation: a form for a manager, plain text for anyone else. */
function Details({ payer, onDone }: { payer: Payer; onDone: (message: string) => void }) {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const canManage = usePermission('payer:manage');
  const update = useUpdatePayer(payer.id);
  const form = useZodForm(payerFormSchema, toPayerFormValues(payer));
  const { dirtyFields } = form.formState;
  // What someone else saved meanwhile goes into the fields this person has not touched; what
  // was typed stays.
  const { reset } = form;
  useEffect(() => {
    reset(toPayerFormValues(payer), { keepDirtyValues: true });
  }, [reset, payer]);

  const save = async (values: PayerFormValues) => {
    const changed = FIELDS.filter((field) => dirtyFields[field] === true);
    if (changed.length === 0) return;
    // Only what changed is sent, with the version the edit started from. A field emptied is
    // cleared with null.
    const body = Object.fromEntries(
      changed.map((field) => [field, field === 'name' ? values.name : values[field] || null]),
    );
    try {
      await update.mutateAsync({ ...body, version: payer.version });
      form.reset(values);
      onDone(t('done.saved'));
    } catch {
      // Said below, from the mutation state.
    }
  };

  const refused = refusalKey(update.error);

  if (!canManage) {
    const rows: [string, string | undefined][] = [
      [t('form.contactName'), payer.contactName],
      [t('form.phone'), payer.phone],
      [t('form.email'), payer.email],
      [t('form.address'), payer.address],
    ];
    return (
      <dl className="grid max-w-xl gap-3 text-sm">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="font-medium">{label}</dt>
            <dd className="whitespace-pre-line">{value || t('notGiven')}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <Form form={form} onSubmit={save} className="flex max-w-xl flex-col gap-4">
      <PayerFields />
      {update.isError && (
        <p role="alert" className="text-sm text-destructive">
          {refused ? t(refused) : tCommon(errorMessageKey(update.error))}
        </p>
      )}
      <div>
        <SubmitButton pending={update.isPending}>{t('save')}</SubmitButton>
      </div>
    </Form>
  );
}

function Plans({
  payer,
  plans,
  onDone,
}: {
  payer: Payer;
  plans: PayerPlan[];
  onDone: (message: string) => void;
}) {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const archive = useUpdatePlan();
  // `true` is the dialog for a new plan.
  const [dialog, setDialog] = useState<PayerPlan | true | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const rows = plans.filter((plan) => showArchived || !plan.archived);

  const columns = useMemo<GridColumn<PayerPlan>[]>(
    () => [
      { id: 'name', header: t('plans.name'), value: (row) => row.name, hideable: false },
      { id: 'code', header: t('plans.code'), value: (row) => row.code },
      {
        id: 'copay',
        header: t('plans.copay'),
        value: (row) => `${row.copayPercent}%`,
        align: 'end',
      },
      {
        id: 'coverage',
        header: t('plans.coverage'),
        value: (row) =>
          row.services.length === 0 && row.coverageMode === 'all_except'
            ? t('coverage.all')
            : t(`coverage.summary_${row.coverageMode}`, { count: row.services.length }),
      },
      {
        id: 'limits',
        header: t('plans.limits'),
        value: (row) =>
          [
            row.sumInsuredMinor !== undefined
              ? t('plans.sumInsuredShort', { amount: format.money(row.sumInsuredMinor) })
              : '',
            row.roomRentLimitMinor !== undefined
              ? t('plans.roomRentShort', { amount: format.money(row.roomRentLimitMinor) })
              : '',
          ]
            .filter(Boolean)
            .join(', ') || t('plans.noLimit'),
      },
      {
        id: 'eligibility',
        header: t('plans.eligibility'),
        value: (row) =>
          [
            row.preAuthRequired ? t('plans.preAuth') : '',
            row.minAge !== undefined || row.maxAge !== undefined
              ? t('plans.ages', { from: row.minAge ?? 0, to: row.maxAge ?? '' })
              : '',
            row.waitingPeriodDays ? t('plans.waiting', { count: row.waitingPeriodDays }) : '',
          ]
            .filter(Boolean)
            .join(', ') || t('plans.none'),
      },
      {
        id: 'status',
        header: t('plans.status'),
        value: (row) => (row.archived ? t('status.archived') : t('status.active')),
      },
    ],
    [t, format],
  );

  const actions: GridAction<PayerPlan>[] = [
    {
      id: 'edit',
      label: t('actions.edit'),
      requires: 'payer:manage',
      disabled: (row) => row.archived || payer.archived,
      onSelect: (row) => setDialog(row),
    },
    {
      id: 'archive',
      label: t('actions.archive'),
      requires: 'payer:manage',
      disabled: (row) => row.archived || archive.isPending,
      onSelect: (row) =>
        void archive
          .mutateAsync({ planId: row.id, body: { archived: true, version: row.version } })
          .then(() => onDone(t('done.planArchived', { name: row.name })))
          .catch(() => undefined),
    },
    {
      id: 'restore',
      label: t('actions.restore'),
      requires: 'payer:manage',
      disabled: (row) => !row.archived || archive.isPending || payer.archived,
      onSelect: (row) =>
        void archive
          .mutateAsync({ planId: row.id, body: { archived: false, version: row.version } })
          .then(() => onDone(t('done.planRestored', { name: row.name })))
          .catch(() => undefined),
    },
  ];

  return (
    <section aria-labelledby="plans-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="plans-heading" className="text-lg font-semibold">
          {t('plans.heading')}
        </h2>
        <Can permission="payer:manage">
          <Button disabled={payer.archived} onClick={() => setDialog(true)}>
            {t('plans.add')}
          </Button>
        </Can>
      </div>
      <p className="text-sm text-muted-foreground">{t('plans.description')}</p>
      <label className="flex h-9 items-center gap-2 text-sm font-medium pointer-coarse:h-11">
        <input
          type="checkbox"
          className="h-4 w-4"
          checked={showArchived}
          onChange={(event) => setShowArchived(event.target.checked)}
        />
        {t('plans.showArchived')}
      </label>
      {archive.isError && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(archive.error))}
        </p>
      )}
      <DataGrid
        label={t('plans.gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.name}
        actions={actions}
        status="ready"
        emptyMessage={t('plans.empty')}
      />
      {dialog !== null && (
        <PlanDialog
          payerId={payer.id}
          plan={dialog === true ? undefined : dialog}
          onClose={() => setDialog(null)}
          onSaved={(name) => {
            setDialog(null);
            onDone(t('done.planSaved', { name }));
          }}
        />
      )}
    </section>
  );
}

function Agreements({
  payer,
  agreements,
  onDone,
}: {
  payer: Payer;
  agreements: RateAgreement[];
  onDone: (message: string) => void;
}) {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const timeZone = useTenant()?.timezone;
  const end = useEndAgreement();
  const [adding, setAdding] = useState(false);
  const today = todayAt(timeZone);
  const refused = refusalKey(end.error);

  const phase = (row: RateAgreement) =>
    row.effectiveFrom > today
      ? 'upcoming'
      : row.effectiveTo !== undefined && row.effectiveTo < today
        ? 'ended'
        : 'current';

  const columns = useMemo<GridColumn<RateAgreement>[]>(
    () => [
      { id: 'name', header: t('agreements.name'), value: (row) => row.name, hideable: false },
      {
        id: 'from',
        header: t('agreements.from'),
        value: (row) => format.calendarDate(row.effectiveFrom),
      },
      {
        id: 'to',
        header: t('agreements.to'),
        value: (row) =>
          row.effectiveTo ? format.calendarDate(row.effectiveTo) : t('agreements.openEnded'),
      },
      {
        id: 'discount',
        header: t('agreements.discount'),
        value: (row) => `${format.number(row.discountBp / 100, { maximumFractionDigits: 2 })}%`,
        align: 'end',
      },
      {
        id: 'rates',
        header: t('agreements.rates'),
        value: (row) =>
          row.rates.length === 0
            ? t('agreements.noRates')
            : row.rates
                .map((rate) => `${rate.serviceName}: ${format.money(rate.rateMinor)}`)
                .join('; '),
      },
      {
        id: 'status',
        header: t('agreements.status'),
        value: (row) => t(`phase.${phase(row)}`),
      },
    ],
    // `phase` reads today, which only changes with the day.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, format, today],
  );

  const actions: GridAction<RateAgreement>[] = [
    {
      id: 'end',
      label: t('actions.endToday'),
      requires: 'payer:manage',
      // Only one that has begun, and has no end before today, can be ended.
      disabled: (row) =>
        end.isPending ||
        row.effectiveFrom > today ||
        (row.effectiveTo !== undefined && row.effectiveTo <= today),
      onSelect: (row) =>
        void end
          .mutateAsync({ agreementId: row.id, effectiveTo: today, version: row.version })
          .then(() => onDone(t('done.agreementEnded', { name: row.name })))
          .catch(() => undefined),
    },
  ];

  return (
    <section aria-labelledby="agreements-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="agreements-heading" className="text-lg font-semibold">
          {t('agreements.heading')}
        </h2>
        <Can permission="payer:manage">
          <Button disabled={payer.archived} onClick={() => setAdding(true)}>
            {t('agreements.add')}
          </Button>
        </Can>
      </div>
      <p className="text-sm text-muted-foreground">{t('agreements.description')}</p>
      {end.isError && (
        <p role="alert" className="text-sm text-destructive">
          {refused ? t(refused) : tCommon(errorMessageKey(end.error))}
        </p>
      )}
      <DataGrid
        label={t('agreements.gridLabel')}
        columns={columns}
        rows={agreements}
        rowId={(row) => row.id}
        rowLabel={(row) => row.name}
        actions={actions}
        status="ready"
        emptyMessage={t('agreements.empty')}
      />
      {adding && (
        <AgreementDialog
          payerId={payer.id}
          onClose={() => setAdding(false)}
          onSaved={(name) => {
            setAdding(false);
            onDone(t('done.agreementSaved', { name }));
          }}
        />
      )}
    </section>
  );
}

function PayerScreen() {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const { payerId = '' } = useParams();
  const payer = usePayer(payerId);
  const archive = useUpdatePayer(payerId);
  const [done, setDone] = useState('');
  const status = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (done) focusIfLost(status.current);
  }, [done]);

  if (payer.isPending) return <PageSkeleton label={t('details.loading')} />;
  if (payer.data === undefined) {
    const missing = isApiError(payer.error) && payer.error.code === 'not_found';
    return (
      <SystemPage
        alert={!missing}
        title={missing ? t('notFound.title') : t('notFound.errorTitle')}
        description={missing ? t('notFound.body') : tCommon(errorMessageKey(payer.error))}
        actions={
          <Link to="/insurance" className={link}>
            {t('backToList')}
          </Link>
        }
      />
    );
  }
  const { payer: record, plans, agreements } = payer.data;
  const toggle = () => {
    setDone('');
    void archive
      .mutateAsync({ archived: !record.archived, version: record.version })
      .then(() => setDone(t(record.archived ? 'done.restored' : 'done.archived')))
      .catch(() => undefined);
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
      <div className="space-y-1">
        <Link to="/insurance" className={link}>
          {t('backToList')}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{record.name}</h1>
        <p className="text-muted-foreground">
          {t(`kind.${record.kind}`)} · {record.code}
          {record.archived ? ` · ${t('status.archived')}` : ''}
        </p>
        {record.kind === 'corporate' && (
          <Can permission="receivable:read">
            <Link to={`/credit/${record.id}`} className={`${link} block`}>
              {t('credit.openAccount')}
            </Link>
          </Can>
        )}
        <Can permission="payer:manage">
          <Button variant="outline" aria-busy={archive.isPending} onClick={toggle}>
            {record.archived ? t('actions.restorePayer') : t('actions.archivePayer')}
          </Button>
        </Can>
      </div>

      <p
        ref={status}
        role="status"
        tabIndex={-1}
        className="text-sm text-muted-foreground outline-none"
      >
        {done}
      </p>
      {archive.isError && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(archive.error))}
        </p>
      )}

      <section aria-labelledby="details-heading" className="flex flex-col gap-3">
        <h2 id="details-heading" className="text-lg font-semibold">
          {t('details.heading')}
        </h2>
        <Details payer={record} onDone={setDone} />
      </section>
      <Plans payer={record} plans={plans} onDone={setDone} />
      <Agreements payer={record} agreements={agreements} onDone={setDone} />
    </div>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function PayerDetail() {
  return (
    <DesktopOnly>
      <PayerScreen />
    </DesktopOnly>
  );
}
