import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { useReactions, useUnitHistory } from '../hooks/use-blood';
import { REACTION_SEVERITIES } from '../schemas';
import type { ReactionSeverity, TransfusionReaction } from '../types';
import { PatientLabel } from './Dialogs';
import { SeverityBadge, TraceDialog } from './ReactionDialogs';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';

/** The trace needs the unit's number for its title, so the unit is read when the dialog opens. */
function ReactionTrace({ unitId, onClose }: { unitId: string; onClose: () => void }) {
  const unit = useUnitHistory(unitId);
  if (!unit.data) return null;
  return <TraceDialog unit={unit.data.unit} onClose={onClose} />;
}

/**
 * The Reactions tab (#982): every transfusion reaction from `GET /transfusion-reactions`, newest
 * first, with the severity first reported as a filter. A row opens the trace of its unit, where
 * an update is added.
 */
export function ReactionsPanel() {
  const { t } = useTranslation('blood-bank');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const [severity, setSeverity] = useState<ReactionSeverity | ''>('');
  const reactions = useReactions(severity ? { severity } : {});
  const [open, setOpen] = useState<string | null>(null);

  const rows = useMemo(
    () => reactions.data?.pages.flatMap((page) => page.items) ?? [],
    [reactions.data],
  );
  const total = reactions.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<TransfusionReaction>[]>(
    () => [
      {
        id: 'reaction',
        header: t('reactionList.columns.reaction'),
        value: (row) => t(`reaction.kinds.${row.kind}`),
        hideable: false,
      },
      {
        id: 'severity',
        header: t('reactionList.columns.severity'),
        hideable: false,
        value: (row) => t(`severity.${row.currentSeverity}`),
        render: (row) => <SeverityBadge severity={row.currentSeverity} />,
      },
      {
        id: 'patient',
        header: t('reactionList.columns.patient'),
        value: (row) => row.patientId,
        render: (row) => <PatientLabel id={row.patientId} />,
      },
      {
        id: 'onset',
        header: t('reactionList.columns.onset'),
        value: (row) => format.dateTime(row.onsetAt),
      },
      {
        id: 'updates',
        header: t('reactionList.columns.updates'),
        value: (row) => t('reactionList.updates', { count: row.updates.length }),
      },
    ],
    [t, format],
  );

  const actions: GridAction<TransfusionReaction>[] = [
    {
      id: 'trace',
      label: t('reactionList.trace'),
      disabled: () => false,
      onSelect: (row) => setOpen(row.unitId),
    },
  ];

  return (
    <section aria-labelledby="blood-reactions" className="flex flex-col gap-4">
      <div className="space-y-1">
        <h2 id="blood-reactions" className="text-lg font-semibold">
          {t('reactionList.heading')}
        </h2>
        <p className="text-muted-foreground">{t('reactionList.description')}</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-40 flex-col gap-1 text-sm font-medium">
          {t('reactionList.filterSeverity')}
          <select
            value={severity}
            onChange={(event) => setSeverity(event.target.value as ReactionSeverity | '')}
            className={control}
          >
            <option value="">{t('filters.any')}</option>
            {REACTION_SEVERITIES.map((value) => (
              <option key={value} value={value}>
                {t(`severity.${value}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-sm text-muted-foreground">
        {total === undefined || reactions.isPlaceholderData
          ? ''
          : t('reactionList.count', { count: total })}
      </p>
      <DataGrid
        label={t('reactionList.gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) =>
          t('reactionList.rowLabel', {
            kind: t(`reaction.kinds.${row.kind}`),
            severity: t(`severity.${row.currentSeverity}`),
          })
        }
        actions={reactions.isPlaceholderData ? [] : actions}
        status={reactions.isPending ? 'loading' : reactions.isError ? 'error' : 'ready'}
        errorMessage={reactions.isError ? tCommon(errorMessageKey(reactions.error)) : undefined}
        onRetry={() => void reactions.refetch()}
        emptyMessage={t('reactionList.empty')}
        hasNextPage={reactions.hasNextPage && !reactions.isPlaceholderData}
        total={reactions.isPlaceholderData ? undefined : total}
        loadingMore={reactions.isFetchingNextPage}
        onLoadMore={() => void reactions.fetchNextPage()}
      />
      {open && <ReactionTrace unitId={open} onClose={() => setOpen(null)} />}
    </section>
  );
}
