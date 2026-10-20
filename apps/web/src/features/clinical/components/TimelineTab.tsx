import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { usePermission } from '@/access';
import { DetailTab } from '@/features/patients';
import type { SlotProps } from '@/registry';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { useEncounters } from '../hooks/use-clinical';
import { ENCOUNTER_STATUSES, ENCOUNTER_TYPES } from '../schemas';
import type { Encounter, EncounterStatus, EncounterType } from '../types';

const select =
  'h-9 w-full rounded-md border bg-background px-3 text-base md:text-sm pointer-coarse:h-11 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

/**
 * The "Clinical timeline" tab of the patient's screen (`patient.detail.tabs`, #83), for
 * `encounter:read`. Given the patient's id only, and reads nothing itself: the timeline is read
 * when the tab is opened.
 */
export default function TimelineTab({ context }: SlotProps) {
  const { t } = useTranslation('clinical');
  const canRead = usePermission('encounter:read');
  const patientId = typeof context?.patientId === 'string' ? context.patientId : '';
  if (!patientId || !canRead) return null;
  return (
    <DetailTab id="timeline" title={t('timeline.tab')}>
      {/* Keyed by the patient: another patient's visits or filters are never carried over. */}
      <Timeline key={patientId} patientId={patientId} />
    </DetailTab>
  );
}

/**
 * The patient's encounters the caller may see, newest first, a page at a time, each opening its
 * consultation. The server leaves out what is outside the caller's scope.
 */
function Timeline({ patientId }: { patientId: string }) {
  const { t } = useTranslation('clinical');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const headingId = useId();
  const typeFieldId = useId();
  const statusFieldId = useId();
  const [type, setType] = useState<EncounterType | ''>('');
  const [status, setStatus] = useState<EncounterStatus | ''>('');
  const encounters = useEncounters({ patientId, type, status });
  const rows = useMemo(
    () => encounters.data?.pages.flatMap((page) => page.items) ?? [],
    [encounters.data],
  );
  const total = encounters.isPlaceholderData ? undefined : encounters.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<Encounter>[]>(
    () => [
      {
        id: 'opened',
        header: t('timeline.columns.opened'),
        value: (row) => format.dateTime(row.openedAt),
        hideable: false,
        render: (row, text) => (
          <Link
            to={`/encounters/${row.id}`}
            className="text-primary underline underline-offset-4 pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
          >
            {text}
          </Link>
        ),
      },
      {
        id: 'type',
        header: t('timeline.columns.type'),
        value: (row) => t(`encounterType.${row.type}`),
      },
      {
        id: 'doctor',
        header: t('timeline.columns.doctor'),
        value: (row) => row.attendingDoctorName ?? '',
      },
      {
        id: 'department',
        header: t('timeline.columns.department'),
        value: (row) => row.departmentName ?? '',
      },
      {
        id: 'status',
        header: t('timeline.columns.status'),
        value: (row) => t(`status.${row.status}`),
      },
    ],
    [t, format],
  );

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-lg font-semibold">
        {t('timeline.heading')}
      </h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:max-w-2xl">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={typeFieldId} className="text-sm font-medium">
            {t('timeline.type')}
          </label>
          <select
            id={typeFieldId}
            className={select}
            value={type}
            onChange={(event) => setType(event.target.value as EncounterType | '')}
          >
            <option value="">{t('timeline.allTypes')}</option>
            {ENCOUNTER_TYPES.map((each) => (
              <option key={each} value={each}>
                {t(`encounterType.${each}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={statusFieldId} className="text-sm font-medium">
            {t('timeline.status')}
          </label>
          <select
            id={statusFieldId}
            className={select}
            value={status}
            onChange={(event) => setStatus(event.target.value as EncounterStatus | '')}
          >
            <option value="">{t('list.allStatuses')}</option>
            {ENCOUNTER_STATUSES.map((each) => (
              <option key={each} value={each}>
                {t(`status.${each}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {/* None is said by the grid itself. */}
        {total === undefined || total === 0 ? '' : t('timeline.count', { count: total })}
      </p>
      <DataGrid
        label={t('timeline.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) =>
          t('timeline.rowLabel', {
            type: t(`encounterType.${row.type}`),
            time: format.dateTime(row.openedAt),
          })
        }
        status={encounters.isPending ? 'loading' : encounters.isError ? 'error' : 'ready'}
        errorMessage={encounters.isError ? tCommon(errorMessageKey(encounters.error)) : undefined}
        onRetry={() => void encounters.refetch()}
        emptyMessage={t('timeline.empty')}
        hasNextPage={encounters.hasNextPage && !encounters.isPlaceholderData}
        total={total}
        loadingMore={encounters.isFetchingNextPage}
        onLoadMore={() => void encounters.fetchNextPage()}
      />
    </section>
  );
}
