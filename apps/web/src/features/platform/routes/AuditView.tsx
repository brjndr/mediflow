import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy/use-formatters';
import { useAudit, useHospitals } from '../hooks/use-hospitals';
import { ACTOR_ID } from '../schemas';
import type { AuditEntry } from '../types';

const FIELD =
  'h-9 rounded-md border bg-background px-3 text-base outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm pointer-coarse:h-11';

// Default export: route modules are loaded with a dynamic import.
export default function AuditView() {
  const { t } = useTranslation();
  const format = useFormatters();
  const [hospitalId, setHospitalId] = useState('');
  const [actorText, setActorText] = useState('');
  const actor = actorText.trim();
  const actorValid = actor === '' || ACTOR_ID.test(actor);
  const audit = useAudit({
    hospitalId: hospitalId || undefined,
    actorId: actor && actorValid ? actor : undefined,
  });
  const hospitals = useHospitals({ limit: 100 });

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const page of hospitals.data?.pages ?? []) {
      for (const hospital of page.items) map.set(hospital.id, hospital.name);
    }
    return map;
  }, [hospitals.data]);

  const rows = useMemo(() => audit.data?.pages.flatMap((page) => page.items) ?? [], [audit.data]);
  const total = audit.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<AuditEntry>[]>(
    () => [
      {
        id: 'at',
        header: t('platform.audit.columns.at'),
        value: (row) => format.dateTime(row.at),
        hideable: false,
      },
      {
        id: 'action',
        header: t('platform.audit.columns.action'),
        value: (row) =>
          t(`platform.audit.actions.${row.action.replace(/\./g, '_')}`, {
            defaultValue: row.action,
          }),
      },
      {
        id: 'hospital',
        header: t('platform.audit.columns.hospital'),
        value: (row) =>
          row.hospitalId
            ? (names.get(row.hospitalId) ?? t('platform.audit.otherHospital'))
            : t('platform.audit.none'),
      },
      {
        id: 'actor',
        header: t('platform.audit.columns.actor'),
        value: (row) => row.actorId,
      },
      {
        id: 'detail',
        header: t('platform.audit.columns.detail'),
        value: (row) =>
          Object.entries(row.detail)
            .map(([key, value]) => `${key}: ${String(value)}`)
            .join(', '),
      },
    ],
    [t, format, names],
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('platform.audit.title')}</h1>
        <p className="text-muted-foreground">{t('platform.audit.description')}</p>
      </div>

      <div className="flex flex-col gap-3 md:flex-row md:items-start">
        <label className="flex flex-col gap-1 text-sm font-medium md:w-64">
          {t('platform.audit.hospital')}
          <select
            className={FIELD}
            value={hospitalId}
            onChange={(event) => setHospitalId(event.target.value)}
          >
            <option value="">{t('platform.audit.allHospitals')}</option>
            {[...names].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-col gap-1 md:w-80">
          <label htmlFor="audit-actor" className="text-sm font-medium">
            {t('platform.audit.actor')}
          </label>
          <input
            id="audit-actor"
            className={FIELD}
            value={actorText}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!actorValid}
            aria-describedby="audit-actor-note"
            onChange={(event) => setActorText(event.target.value)}
          />
          <p
            id="audit-actor-note"
            className={`text-sm ${actorValid ? 'text-muted-foreground' : 'text-destructive'}`}
          >
            {actorValid ? t('platform.audit.actorHint') : t('platform.audit.actorInvalid')}
          </p>
        </div>
      </div>

      <p role="status" className="text-sm text-muted-foreground">
        {total === undefined ? '' : t('platform.audit.count', { count: total })}
      </p>

      <DataGrid
        label={t('platform.audit.gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.action}
        status={audit.isPending ? 'loading' : audit.isError ? 'error' : 'ready'}
        errorMessage={audit.isError ? t(errorMessageKey(audit.error)) : undefined}
        onRetry={() => void audit.refetch()}
        emptyMessage={t('platform.audit.empty')}
        total={total}
        hasNextPage={audit.hasNextPage}
        loadingMore={audit.isFetchingNextPage}
        onLoadMore={() => void audit.fetchNextPage()}
      />
    </div>
  );
}
