import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { Can } from '@/access';
import { useSession } from '@/app/session';
import { errorMessageKey, isApiError } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useFormatters } from '@/tenancy';
import { AdjustmentForm } from '../components/AdjustmentForm';
import { field } from '../components/field';
import { InventoryLinks } from '../components/InventoryLinks';
import type { PickedItem } from '../components/ItemPicker';
import { useAdjustments, useDecideAdjustment } from '../hooks/use-inventory';
import { useItemName } from '../hooks/use-item-name';
import { NOTE_MAX, rejectFormSchema, STATUSES, type RejectFormValues } from '../schemas';
import type { StockAdjustment, StockAdjustmentStatus } from '../types';

/** A decision refused, in words of its own. */
const REFUSED: Record<string, string> = {
  conflict: 'decide.refused.conflict',
  adjustment_decided: 'decide.refused.decided',
  own_adjustment: 'decide.refused.own',
  insufficient_stock: 'decide.refused.insufficient',
  item_archived: 'decide.refused.itemArchived',
  location_archived: 'decide.refused.locationArchived',
  batch_exists: 'decide.refused.batchExists',
  adjustment_not_found: 'decide.refused.gone',
};

/**
 * Stock adjustments (`inventory/adjustments`, #102), for `stock:read`: pending ones first (the
 * newest asked first), then approved or rejected. **New adjustment** (`stock:adjust`) opens a
 * panel in place; **Approve** and **Reject** (`stock:approve`) are offered on someone else's
 * pending adjustment only, as the API refuses one's own. Approving moves the stock through the
 * ledger; rejecting asks why. Works at every width.
 */
export default function StockAdjustments() {
  const { t } = useTranslation('inventory');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const nameOf = useItemName();
  const me = useSession()?.user.id;
  const statusFieldId = useId();
  // From the stock list's Adjust: the item, in memory only.
  const routed = (useLocation().state as { adjust?: PickedItem } | null)?.adjust ?? null;
  const navigate = useNavigate();
  // Read once: Back to this entry must not open the panel again after it was sent.
  useEffect(() => {
    if (routed) void navigate('.', { replace: true, state: null });
  }, [routed, navigate]);
  const [status, setStatus] = useState<StockAdjustmentStatus>('pending');
  const [panel, setPanel] = useState<
    | { kind: 'new'; item: PickedItem | null }
    | { kind: 'reject'; adjustment: StockAdjustment }
    | null
  >(() => (routed ? { kind: 'new', item: routed } : null));
  const adjustments = useAdjustments(status);
  const rows = useMemo(
    () => adjustments.data?.pages.flatMap((page) => page.items) ?? [],
    [adjustments.data],
  );
  const total = adjustments.isPlaceholderData ? undefined : adjustments.data?.pages[0]?.total;

  const box = useRef<HTMLDivElement>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  usePanelFocus(
    panel ? (panel.kind === 'new' ? 'new' : `reject:${panel.adjustment.id}`) : null,
    box,
    statusLine,
  );
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(statusLine.current);
  }, [message]);

  const decide = useDecideAdjustment();
  const refusal = (error: unknown) => {
    const key = isApiError(error) ? REFUSED[error.serverCode ?? ''] : undefined;
    return key ? t(key) : tCommon(errorMessageKey(error));
  };
  const words = (row: StockAdjustment) => ({
    item: nameOf(row.item),
    count: Math.abs(row.quantity),
    place: row.locationName,
  });

  const columns = useMemo<GridColumn<StockAdjustment>[]>(
    () => [
      {
        id: 'item',
        header: t('adjustments.columns.item'),
        value: (row) => nameOf(row.item),
        hideable: false,
      },
      {
        id: 'change',
        header: t('adjustments.columns.change'),
        value: (row) =>
          t(row.quantity > 0 ? 'change.in' : 'change.out', { count: Math.abs(row.quantity) }),
      },
      {
        id: 'batch',
        header: t('adjustments.columns.batch'),
        value: (row) =>
          t(
            row.newBatch && row.status === 'pending' ? 'adjustments.newBatch' : 'adjustments.batch',
            {
              number: row.batchNumber,
              expiry: format.calendarDate(row.expiryDate),
            },
          ),
      },
      { id: 'place', header: t('adjustments.columns.place'), value: (row) => row.locationName },
      {
        id: 'reason',
        header: t('adjustments.columns.reason'),
        value: (row) =>
          row.note
            ? t('adjustments.reasonNote', { reason: t(`reason.${row.reason}`), note: row.note })
            : t(`reason.${row.reason}`),
      },
      {
        id: 'onHand',
        header: t('adjustments.columns.onHand'),
        value: (row) => format.number(row.onHand),
        align: 'end',
      },
      {
        id: 'asked',
        header: t('adjustments.columns.asked'),
        value: (row) =>
          t('adjustments.by', {
            name: row.requestedByName,
            time: format.dateTime(row.requestedAt),
          }),
      },
      {
        id: 'decided',
        header: t('adjustments.columns.decided'),
        value: (row) =>
          row.decidedAt
            ? [
                t(`adjustments.decided.${row.status}`, {
                  name: row.decidedByName ?? '',
                  time: format.dateTime(row.decidedAt),
                }),
                row.rejectionNote ?? '',
              ]
                .filter(Boolean)
                .join(' ')
            : '',
      },
    ],
    [t, format, nameOf],
  );

  const actions: GridAction<StockAdjustment>[] =
    status === 'pending'
      ? [
          {
            id: 'approve',
            label: t('decide.approve'),
            requires: 'stock:approve',
            disabled: (row) => row.requestedById === me || decide.isPending,
            onSelect: (row) => {
              if (row.requestedById === me || decide.isPending) return;
              decide.mutate(
                { adjustment: row },
                {
                  onSuccess: () => say(t('decide.approved', words(row))),
                  onError: (error) => say(refusal(error)),
                },
              );
            },
          },
          {
            id: 'reject',
            label: t('decide.reject'),
            requires: 'stock:approve',
            disabled: (row) => row.requestedById === me,
            onSelect: (row) => {
              if (row.requestedById !== me) setPanel({ kind: 'reject', adjustment: row });
            },
          },
        ]
      : [];

  return (
    <div ref={box} className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('adjustments.heading')}</h1>
        <InventoryLinks />
        <p className="text-sm text-muted-foreground">{t('adjustments.description')}</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-full flex-col gap-1.5 sm:w-56">
          <label htmlFor={statusFieldId} className="text-sm font-medium">
            {t('adjustments.status')}
          </label>
          <select
            id={statusFieldId}
            className={field}
            value={status}
            onChange={(event) => setStatus(event.target.value as StockAdjustmentStatus)}
          >
            {STATUSES.map((each) => (
              <option key={each} value={each}>
                {t(`adjustments.statuses.${each}`)}
              </option>
            ))}
          </select>
        </div>
        <Can permission="stock:adjust">
          {panel?.kind !== 'new' && (
            <Button type="button" onClick={() => setPanel({ kind: 'new', item: null })}>
              {t('adjustments.new')}
            </Button>
          )}
        </Can>
      </div>
      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="text-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {[message.text, total === undefined ? '' : t('adjustments.count', { count: total })]
          .filter(Boolean)
          .join(' ')}
      </p>
      {panel?.kind === 'new' && (
        <Can permission="stock:adjust">
          <AdjustmentForm
            initialItem={panel.item}
            onClose={() => setPanel(null)}
            onAsked={(adjustment) => {
              setPanel(null);
              setStatus('pending');
              say(t('adjust.asked', words(adjustment)));
            }}
          />
        </Can>
      )}
      {panel?.kind === 'reject' && (
        <RejectPanel
          key={panel.adjustment.id}
          adjustment={panel.adjustment}
          onClose={() => setPanel(null)}
          onRejected={(adjustment) => {
            setPanel(null);
            say(t('decide.rejected', words(adjustment)));
          }}
        />
      )}
      <DataGrid
        label={t('adjustments.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => t('adjustments.rowLabel', words(row))}
        actions={actions}
        status={adjustments.isPending ? 'loading' : adjustments.isError ? 'error' : 'ready'}
        errorMessage={adjustments.isError ? tCommon(errorMessageKey(adjustments.error)) : undefined}
        onRetry={() => void adjustments.refetch()}
        emptyMessage={t(`adjustments.empty.${status}`)}
        hasNextPage={adjustments.hasNextPage && !adjustments.isPlaceholderData}
        total={total}
        loadingMore={adjustments.isFetchingNextPage}
        onLoadMore={() => void adjustments.fetchNextPage()}
      />
    </div>
  );
}

/** Rejecting a pending adjustment: why, in a note the person who asked will read. */
function RejectPanel({
  adjustment,
  onClose,
  onRejected,
}: {
  adjustment: StockAdjustment;
  onClose: () => void;
  onRejected: (adjustment: StockAdjustment) => void;
}) {
  const { t } = useTranslation('inventory');
  const { t: tCommon } = useTranslation();
  const nameOf = useItemName();
  const headingId = useId();
  const decide = useDecideAdjustment();
  const form = useZodForm(rejectFormSchema, { note: '' });
  const alert = useRef<HTMLParagraphElement>(null);
  const code = isApiError(decide.error) ? decide.error.serverCode : undefined;
  const failure = decide.error
    ? code && REFUSED[code]
      ? t(REFUSED[code])
      : tCommon(errorMessageKey(decide.error))
    : undefined;
  useLayoutEffect(() => {
    if (failure) focusIfLost(alert.current);
  }, [failure]);

  const submit = async (values: RejectFormValues) => {
    decide.reset();
    try {
      onRejected(await decide.mutateAsync({ adjustment, note: values.note }));
    } catch {
      // Said from the mutation state.
    }
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h2 id={headingId} data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('decide.rejectHeading', {
          item: nameOf(adjustment.item),
          count: Math.abs(adjustment.quantity),
          place: adjustment.locationName,
        })}
      </h2>
      <Form form={form} onSubmit={submit}>
        <TextField<RejectFormValues>
          name="note"
          label={t('decide.note')}
          hint={t('decide.noteHint')}
          required
          maxLength={NOTE_MAX}
          autoComplete="off"
        />
        {failure && (
          <p
            ref={alert}
            role="alert"
            tabIndex={-1}
            className="text-sm text-destructive outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {failure}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending={decide.isPending}>{t('decide.rejectSubmit')}</SubmitButton>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </Form>
    </section>
  );
}
