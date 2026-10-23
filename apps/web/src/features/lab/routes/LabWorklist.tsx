import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { PrintSheet } from '@/shared/ui/print-sheet';
import { maskMrn } from '@/shared/utils/mask';
import { useFormatters } from '@/tenancy';
import { CollectSample } from '../components/CollectSample';
import { RejectSample } from '../components/RejectSample';
import { SampleLabel } from '../components/SampleLabel';
import { useLabelPrinting, useReceiveSample, useWorklist } from '../hooks/use-lab';
import { LAB_STAGES, PRIORITIES } from '../schemas';
import type { LabSample, LabStage, LabWorkItem, OrderPriority } from '../types';

const field =
  'h-9 w-full rounded-md border bg-background px-3 text-base md:text-sm pointer-coarse:h-11 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

/** What a refused receive says, in words of its own. */
const RECEIVE_REFUSED: Record<string, string> = {
  conflict: 'receive.refused.conflict',
  invalid_transition: 'receive.refused.notCollected',
  sample_not_found: 'receive.refused.gone',
};

/** What a refused label print says. */
const PRINT_REFUSED: Record<string, string> = {
  not_printable: 'label.refused.notPrintable',
  sample_not_found: 'label.refused.gone',
};

/** The actions each stage offers: nothing that cannot apply to its rows. */
const STAGE_ACTIONS: Record<LabStage, readonly string[]> = {
  to_collect: ['collect'],
  collected: ['receive', 'reject', 'label'],
  received: ['reject', 'label'],
};

/** The sample a row's actions work on: its newest, unless that one was rejected. */
const live = (row: LabWorkItem) =>
  row.sample && row.sample.status !== 'rejected' ? row.sample : undefined;

type Panel =
  { kind: 'collect'; item: LabWorkItem } | { kind: 'reject'; item: LabWorkItem; sample: LabSample };

/**
 * The laboratory worklist (`lab`, #90), for `labSample:read`: the hospital's lab orders at one
 * stage (to collect by default, then collected, then received), stat first and the oldest first
 * within a priority, filtered by priority on the server. Collecting gives the sample its
 * accession id and prints its label (`labSample:collect`); the laboratory receives it
 * (`labSample:receive`) or rejects it with a reason (`labSample:reject`), which puts the order
 * back to be collected again. Works at every width: a nurse collects at the bedside.
 */
export default function LabWorklist() {
  const { t } = useTranslation('lab');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const stageFieldId = useId();
  const priorityFieldId = useId();
  const [stage, setStage] = useState<LabStage>('to_collect');
  const [priority, setPriority] = useState<OrderPriority | ''>('');
  const worklist = useWorklist({ stage, priority });
  const rows = useMemo(
    () => worklist.data?.pages.flatMap((page) => page.items) ?? [],
    [worklist.data],
  );
  const total = worklist.isPlaceholderData ? undefined : worklist.data?.pages[0]?.total;

  const box = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  // A panel works on the row as it was opened: a collected order leaves this stage at once, and
  // the panel stays to print its label.
  const [panel, setPanel] = useState<Panel | null>(null);
  usePanelFocus(panel ? `${panel.kind}:${panel.item.orderId}` : null, box, status);
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);

  const receive = useReceiveSample();
  const printing = useLabelPrinting();
  const refusal = (error: unknown, refused: Record<string, string>) => {
    const key = isApiError(error) ? refused[error.serverCode ?? ''] : undefined;
    return key ? t(key) : tCommon(errorMessageKey(error));
  };

  const closePanel = () => {
    printing.reset();
    setPanel(null);
  };

  const printLabel = (item: LabWorkItem, sample: LabSample) => {
    printing.reset();
    printing.print({ item, sample });
  };

  const columns = useMemo<GridColumn<LabWorkItem>[]>(() => {
    /** Where the sample is, in words: its accession id and state, or why the last was rejected. */
    const sampleWords = (row: LabWorkItem): string => {
      const sample = row.sample;
      if (!sample) return t('list.sampleNone', { sample: t(`sampleType.${row.sampleType}`) });
      if (sample.status === 'rejected') {
        return t('list.sampleRejected', {
          id: sample.accessionId,
          reason: sample.rejectReason ? t(`rejectReason.${sample.rejectReason}`) : '',
        });
      }
      return t(`list.sample.${sample.status}`, { id: sample.accessionId });
    };
    return [
      {
        id: 'patient',
        header: t('list.columns.patient'),
        value: (row) => row.patientName,
        hideable: false,
      },
      { id: 'mrn', header: t('list.columns.mrn'), value: (row) => row.patientMrn, mask: maskMrn },
      { id: 'test', header: t('list.columns.test'), value: (row) => row.itemName },
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
      {
        id: 'sample',
        header: t('list.columns.sample'),
        value: (row) => sampleWords(row),
      },
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

  const allActions: GridAction<LabWorkItem>[] = [
    {
      id: 'collect',
      label: t('list.collect'),
      requires: 'labSample:collect',
      disabled: (row) => row.stage !== 'to_collect',
      onSelect: (row) => setPanel({ kind: 'collect', item: row }),
    },
    {
      id: 'receive',
      label: t('list.receive'),
      requires: 'labSample:receive',
      disabled: (row) => row.stage !== 'collected' || receive.isPending,
      onSelect: (row) => {
        const sample = live(row);
        if (!sample || receive.isPending) return;
        receive.mutate(sample, {
          onSuccess: (received) => say(t('receive.done', { id: received.accessionId })),
          onError: (error) => say(refusal(error, RECEIVE_REFUSED)),
        });
      },
    },
    {
      id: 'reject',
      label: t('list.reject'),
      requires: 'labSample:reject',
      disabled: (row) => !live(row),
      onSelect: (row) => {
        const sample = live(row);
        if (sample) setPanel({ kind: 'reject', item: row, sample });
      },
    },
    {
      id: 'label',
      label: t('label.print'),
      requires: 'labSample:collect',
      disabled: (row) => !live(row) || printing.busy,
      onSelect: (row) => {
        const sample = live(row);
        if (sample && !printing.busy) printLabel(row, sample);
      },
    },
  ];
  const actions = allActions.filter((action) => STAGE_ACTIONS[stage].includes(action.id));

  return (
    <div ref={box} className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('list.heading')}</h1>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:max-w-2xl">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={stageFieldId} className="text-sm font-medium">
            {t('list.stage')}
          </label>
          <select
            id={stageFieldId}
            className={field}
            value={stage}
            onChange={(event) => {
              printing.reset();
              setStage(event.target.value as LabStage);
            }}
          >
            {LAB_STAGES.map((each) => (
              <option key={each} value={each}>
                {t(`stage.${each}`)}
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
            onChange={(event) => {
              printing.reset();
              setPriority(event.target.value as OrderPriority | '');
            }}
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
      {printing.error && (
        <p role="alert" className="text-sm text-destructive">
          {refusal(printing.error, PRINT_REFUSED)}
        </p>
      )}
      {panel?.kind === 'collect' && (
        <CollectSample
          key={panel.item.orderId}
          item={panel.item}
          printing={printing.busy}
          onPrint={(sample) => printLabel(panel.item, sample)}
          onClose={closePanel}
        />
      )}
      {panel?.kind === 'reject' && (
        <RejectSample
          key={panel.sample.id}
          item={panel.item}
          sample={panel.sample}
          onClose={closePanel}
          onRejected={(rejected) => {
            closePanel();
            say(t('reject.done', { id: rejected.accessionId }));
          }}
        />
      )}
      <DataGrid
        label={t('list.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.orderId}
        rowLabel={(row) => t('list.rowLabel', { name: row.patientName, test: row.itemName })}
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
      {printing.job && (
        <PrintSheet key={printing.job.id} onDone={printing.done} className="">
          <SampleLabel item={printing.job.value.item} sample={printing.job.value.sample} />
        </PrintSheet>
      )}
    </div>
  );
}
