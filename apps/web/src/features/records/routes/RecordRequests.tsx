import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Can } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { maskMrn } from '@/shared/utils/mask';
import { todayIn } from '@/shared/utils/timezone';
import { useFormatters, useTenant } from '@/tenancy';
import { RecordsNav } from '../components/RecordsNav';
import { CloseRequestDialog, NewRequestDialog } from '../components/RequestDialogs';
import { useRecordRequests } from '../hooks/use-records';
import { REQUEST_STATES } from '../schemas';
import type { RecordRequest, RecordRequestState } from '../types';

const field =
  'h-9 w-full rounded-md border bg-background px-3 text-base md:text-sm pointer-coarse:h-11 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

/**
 * The record request log (`records/requests`, MR-04, #192), for `recordRequest:read`: who asked
 * for a copy of whose record, why, and what became of it. `recordRequest:manage` logs a request
 * and closes it as fulfilled or declined with a note; a closed request is never changed. An open
 * request past its due day is marked overdue in words.
 */
export default function RecordRequests() {
  const { t } = useTranslation('records');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const stateId = useId();
  const today = todayIn(useTenant()?.timezone ?? 'UTC');
  const [state, setState] = useState<RecordRequestState | ''>('open');
  const requests = useRecordRequests(state);
  const rows = useMemo(
    () => requests.data?.pages.flatMap((page) => page.items) ?? [],
    [requests.data],
  );
  const total = requests.isPlaceholderData ? undefined : requests.data?.pages[0]?.total;
  const [logging, setLogging] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);
  const closing = closingId === null ? undefined : rows.find((row) => row.id === closingId);
  const status = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);

  const columns = useMemo<GridColumn<RecordRequest>[]>(
    () => [
      {
        id: 'patient',
        header: t('requests.columns.patient'),
        value: (row) => row.patientName,
        hideable: false,
      },
      {
        id: 'mrn',
        header: t('requests.columns.mrn'),
        value: (row) => row.patientMrn,
        mask: maskMrn,
      },
      {
        id: 'requester',
        header: t('requests.columns.requester'),
        value: (row) => `${row.requesterName} (${t(`requester.${row.requesterKind}`)})`,
      },
      { id: 'purpose', header: t('requests.columns.purpose'), value: (row) => row.purpose },
      {
        id: 'requested',
        header: t('requests.columns.requested'),
        value: (row) => format.calendarDate(row.requestedOn),
      },
      {
        id: 'due',
        header: t('requests.columns.due'),
        value: (row) => (row.dueOn ? format.calendarDate(row.dueOn) : ''),
      },
      {
        id: 'state',
        header: t('requests.columns.state'),
        value: (row) =>
          row.state === 'open' && row.dueOn !== undefined && row.dueOn < today
            ? t('requests.overdue')
            : t(`state.${row.state}`),
      },
      { id: 'note', header: t('requests.columns.note'), value: (row) => row.note ?? '' },
    ],
    [t, format, today],
  );

  const actions = useMemo<GridAction<RecordRequest>[]>(
    () => [
      {
        id: 'close',
        label: t('requests.close'),
        requires: 'recordRequest:manage',
        disabled: (row) => row.state !== 'open',
        onSelect: (row) => setClosingId(row.id),
      },
    ],
    [t],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('requests.heading')}</h1>
        <Can permission="recordRequest:manage">
          <Button onClick={() => setLogging(true)}>{t('requests.new')}</Button>
        </Can>
      </div>
      <RecordsNav />
      <p className="text-sm text-muted-foreground">{t('requests.intro')}</p>
      <div className="flex flex-col gap-1.5 md:max-w-xs">
        <label htmlFor={stateId} className="text-sm font-medium">
          {t('requests.state')}
        </label>
        <select
          id={stateId}
          className={field}
          value={state}
          onChange={(event) => setState(event.target.value as RecordRequestState | '')}
        >
          {REQUEST_STATES.map((each) => (
            <option key={each} value={each}>
              {t(`state.${each}`)}
            </option>
          ))}
          <option value="">{t('requests.allStates')}</option>
        </select>
      </div>
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="text-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {[message.text, total === undefined ? '' : t('requests.count', { count: total })]
          .filter(Boolean)
          .join(' ')}
      </p>
      <DataGrid
        label={t('requests.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.patientName}
        actions={actions}
        status={requests.isPending ? 'loading' : requests.isError ? 'error' : 'ready'}
        errorMessage={requests.isError ? tCommon(errorMessageKey(requests.error)) : undefined}
        onRetry={() => void requests.refetch()}
        emptyMessage={t('requests.empty')}
        hasNextPage={requests.hasNextPage && !requests.isPlaceholderData}
        total={total}
        loadingMore={requests.isFetchingNextPage}
        onLoadMore={() => void requests.fetchNextPage()}
      />
      {logging && (
        <NewRequestDialog
          onClose={() => setLogging(false)}
          onCreated={(created) => {
            setLogging(false);
            say(t('requests.logged', { name: created.patientName }));
          }}
        />
      )}
      {closing && (
        <CloseRequestDialog
          request={closing}
          onClose={() => setClosingId(null)}
          onClosed={(closed) => {
            setClosingId(null);
            say(
              t('requests.closed', { name: closed.patientName, state: t(`state.${closed.state}`) }),
            );
          }}
        />
      )}
    </div>
  );
}
