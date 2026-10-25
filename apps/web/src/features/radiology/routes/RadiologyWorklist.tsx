import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { maskMrn } from '@/shared/utils/mask';
import { useFormatters } from '@/tenancy';
import { ReportPanel } from '../components/ReportPanel';
import { ScheduleStudy } from '../components/ScheduleStudy';
import { usePerformStudy, useUnscheduleStudy, useWorklist } from '../hooks/use-radiology';
import { IMAGING_STAGES, MODALITIES, PRIORITIES } from '../schemas';
import type { ImagingModality, ImagingStage, ImagingWorkItem, OrderPriority } from '../types';

const field =
  'h-9 w-full rounded-md border bg-background px-3 text-base md:text-sm pointer-coarse:h-11 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

/** What a refused unschedule or perform says, in words of its own. */
const CHANGE_REFUSED: Record<string, string> = {
  conflict: 'change.refused.conflict',
  invalid_transition: 'change.refused.notScheduled',
  order_not_found: 'change.refused.gone',
};

/** The actions each stage offers: nothing that cannot apply to its rows. */
const STAGE_ACTIONS: Record<ImagingStage, readonly string[]> = {
  to_schedule: ['schedule'],
  scheduled: ['perform', 'reschedule', 'unschedule'],
  performed: ['report'],
  reported: ['viewReport'],
};

/**
 * Radiology's worklist (`radiology`, #96), for `imagingStudy:read`: the hospital's imaging
 * orders at one stage (to schedule by default, then scheduled, then performed), filtered by
 * modality and priority on the server. To schedule is stat first and the oldest first within a
 * priority; scheduled is the soonest slot first. Scheduling and moving a study open a panel in
 * place (`imagingStudy:schedule`); unscheduling and recording that it was performed
 * (`imagingStudy:perform`) are row actions said in the status line. A performed study's report
 * (#97) is written, saved and signed in a panel in place; signing moves it to the reported stage,
 * the newest signed first, where its report is read and addenda are added. Works at every width.
 */
export default function RadiologyWorklist() {
  const { t } = useTranslation('radiology');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const stageFieldId = useId();
  const modalityFieldId = useId();
  const priorityFieldId = useId();
  const [stage, setStage] = useState<ImagingStage>('to_schedule');
  const [modality, setModality] = useState<ImagingModality | ''>('');
  const [priority, setPriority] = useState<OrderPriority | ''>('');
  const worklist = useWorklist({ stage, modality, priority });
  const rows = useMemo(
    () => worklist.data?.pages.flatMap((page) => page.items) ?? [],
    [worklist.data],
  );
  const total = worklist.isPlaceholderData ? undefined : worklist.data?.pages[0]?.total;

  const box = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  // The panel works on the row as it was opened: a scheduled order leaves this stage at once.
  const [panel, setPanel] = useState<{ kind: 'schedule' | 'report'; item: ImagingWorkItem } | null>(
    null,
  );
  usePanelFocus(panel ? `${panel.kind}:${panel.item.orderId}` : null, box, status);
  const canWrite = usePermission('imagingReport:write');
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);

  const unschedule = useUnscheduleStudy();
  const perform = usePerformStudy();
  const busy = unschedule.isPending || perform.isPending;
  const refusal = (error: unknown) => {
    const key = isApiError(error) ? CHANGE_REFUSED[error.serverCode ?? ''] : undefined;
    return key ? t(key) : tCommon(errorMessageKey(error));
  };

  const columns = useMemo<GridColumn<ImagingWorkItem>[]>(() => {
    /** Where the study is, in words: its slot, when it was performed, or not scheduled. */
    const studyWords = (row: ImagingWorkItem): string => {
      const study = row.study;
      if (row.stage === 'reported') {
        return t('list.study.reported', {
          time: row.reportSignedAt ? format.dateTime(row.reportSignedAt) : '',
          name: row.reportSignedByName ?? '',
        });
      }
      if (study?.performedAt) {
        if (row.reportStatus === 'draft') {
          return t('list.study.performedDrafted', {
            time: format.dateTime(study.performedAt),
            name: study.performedByName ?? '',
          });
        }
        return t('list.study.performed', {
          time: format.dateTime(study.performedAt),
          name: study.performedByName ?? '',
        });
      }
      if (study?.scheduledAt) {
        return t('list.study.scheduled', { time: format.dateTime(study.scheduledAt) });
      }
      if (row.stage === 'performed') return t('list.study.inProgress');
      return t(study ? 'list.study.unscheduled' : 'list.study.none');
    };
    return [
      {
        id: 'patient',
        header: t('list.columns.patient'),
        value: (row) => row.patientName,
        hideable: false,
      },
      { id: 'mrn', header: t('list.columns.mrn'), value: (row) => row.patientMrn, mask: maskMrn },
      { id: 'study', header: t('list.columns.study'), value: (row) => row.itemName },
      {
        id: 'modality',
        header: t('list.columns.modality'),
        value: (row) => t(`modality.${row.modality}`),
      },
      {
        id: 'priority',
        header: t('list.columns.priority'),
        value: (row) => t(`priority.${row.priority}`),
        render: (row) =>
          row.priority === 'routine' ? (
            t('priority.routine')
          ) : (
            <span className="font-semibold text-destructive">{t(`priority.${row.priority}`)}</span>
          ),
      },
      { id: 'slot', header: t('list.columns.slot'), value: (row) => studyWords(row) },
      {
        id: 'ordered',
        header: t('list.columns.ordered'),
        value: (row) =>
          t('list.orderedBy', { time: format.dateTime(row.placedAt), name: row.orderedByName }),
      },
      {
        id: 'instructions',
        header: t('list.columns.instructions'),
        value: (row) => row.instructions ?? '',
      },
    ];
  }, [t, format]);

  const allActions: GridAction<ImagingWorkItem>[] = [
    {
      id: 'schedule',
      label: t('list.schedule'),
      requires: 'imagingStudy:schedule',
      disabled: (row) => row.stage !== 'to_schedule',
      onSelect: (row) => setPanel({ kind: 'schedule', item: row }),
    },
    {
      id: 'perform',
      label: t('list.perform'),
      requires: 'imagingStudy:perform',
      disabled: (row) => !row.study?.scheduledAt || busy,
      onSelect: (row) => {
        if (!row.study?.scheduledAt || busy) return;
        perform.mutate(row.study, {
          onSuccess: () => say(t('perform.done', { study: row.itemName, name: row.patientName })),
          onError: (error) => say(refusal(error)),
        });
      },
    },
    {
      id: 'reschedule',
      label: t('list.reschedule'),
      requires: 'imagingStudy:schedule',
      disabled: (row) => !row.study?.scheduledAt,
      onSelect: (row) => setPanel({ kind: 'schedule', item: row }),
    },
    {
      id: 'unschedule',
      label: t('list.unschedule'),
      requires: 'imagingStudy:schedule',
      disabled: (row) => !row.study?.scheduledAt || busy,
      onSelect: (row) => {
        if (!row.study?.scheduledAt || busy) return;
        unschedule.mutate(row.study, {
          onSuccess: () =>
            say(t('unschedule.done', { study: row.itemName, name: row.patientName })),
          onError: (error) => say(refusal(error)),
        });
      },
    },
    {
      id: 'report',
      label: t(canWrite ? 'list.writeReport' : 'list.viewReport'),
      disabled: (row) => row.stage !== 'performed',
      onSelect: (row) => setPanel({ kind: 'report', item: row }),
    },
    {
      id: 'viewReport',
      label: t('list.viewReport'),
      disabled: (row) => row.stage !== 'reported',
      onSelect: (row) => setPanel({ kind: 'report', item: row }),
    },
  ];
  const actions = allActions.filter((action) => STAGE_ACTIONS[stage].includes(action.id));

  return (
    <div ref={box} className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('list.heading')}</h1>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3 lg:max-w-3xl">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={stageFieldId} className="text-sm font-medium">
            {t('list.stage')}
          </label>
          <select
            id={stageFieldId}
            className={field}
            value={stage}
            onChange={(event) => setStage(event.target.value as ImagingStage)}
          >
            {IMAGING_STAGES.map((each) => (
              <option key={each} value={each}>
                {t(`stage.${each}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={modalityFieldId} className="text-sm font-medium">
            {t('list.modality')}
          </label>
          <select
            id={modalityFieldId}
            className={field}
            value={modality}
            onChange={(event) => setModality(event.target.value as ImagingModality | '')}
          >
            <option value="">{t('list.allModalities')}</option>
            {MODALITIES.map((each) => (
              <option key={each} value={each}>
                {t(`modality.${each}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={priorityFieldId} className="text-sm font-medium">
            {t('list.priority')}
          </label>
          <select
            id={priorityFieldId}
            className={field}
            value={priority}
            onChange={(event) => setPriority(event.target.value as OrderPriority | '')}
          >
            <option value="">{t('list.allPriorities')}</option>
            {PRIORITIES.map((each) => (
              <option key={each} value={each}>
                {t(`priority.${each}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="text-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {[message.text, total === undefined ? '' : t('list.count', { count: total })]
          .filter(Boolean)
          .join(' ')}
      </p>
      {panel?.kind === 'schedule' && (
        <ScheduleStudy
          key={panel.item.orderId}
          item={panel.item}
          onClose={() => setPanel(null)}
          onScheduled={(study) => {
            setPanel(null);
            say(
              t('schedule.done', {
                study: panel.item.itemName,
                name: panel.item.patientName,
                time: study.scheduledAt ? format.dateTime(study.scheduledAt) : '',
              }),
            );
          }}
        />
      )}
      {panel?.kind === 'report' && (
        <ReportPanel
          key={panel.item.orderId}
          item={panel.item}
          onClose={() => setPanel(null)}
          onSigned={() =>
            say(t('report.signed', { study: panel.item.itemName, name: panel.item.patientName }))
          }
        />
      )}
      <DataGrid
        label={t('list.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.orderId}
        rowLabel={(row) => t('list.rowLabel', { name: row.patientName, study: row.itemName })}
        actions={actions}
        status={worklist.isPending ? 'loading' : worklist.isError ? 'error' : 'ready'}
        errorMessage={worklist.isError ? tCommon(errorMessageKey(worklist.error)) : undefined}
        onRetry={() => void worklist.refetch()}
        emptyMessage={t(`list.empty.${stage}`)}
        hasNextPage={worklist.hasNextPage && !worklist.isPlaceholderData}
        total={total}
        loadingMore={worklist.isFetchingNextPage}
        onLoadMore={() => void worklist.fetchNextPage()}
      />
    </div>
  );
}
