import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { LabTestSearch, type LabTest } from '@/features/lab-tests';
import { errorMessageKey, isApiError } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import {
  Form,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
  useFieldError,
  useFieldFocusRef,
  useZodForm,
} from '@/shared/ui/form';
import { useFormatters } from '@/tenancy';
import { useCancelOrder, useOrders, usePlaceOrder } from '../hooks/use-clinical';
import {
  blankLabOrder,
  INSTRUCTIONS_MAX,
  isActiveOrder,
  labOrderFormSchema,
  ORDER_PRIORITIES,
  REASON_MAX,
  reasonSchema,
  toLabOrderCreate,
  type LabOrderValues,
  type ReasonValues,
} from '../schemas';
import type { Encounter, Order } from '../types';

const REFUSED: Record<string, string> = {
  encounter_not_open: 'labOrders.refused.notOpen',
  unknown_lab_test: 'labOrders.refused.unknownTest',
  invalid_transition: 'labOrders.refused.started',
  conflict: 'labOrders.refused.conflict',
  order_not_found: 'labOrders.refused.gone',
};

function useRefusal(error: unknown) {
  const { t } = useTranslation('clinical');
  const { t: tCommon } = useTranslation();
  if (!error) return undefined;
  const code = isApiError(error) ? error.serverCode : undefined;
  const key = code === undefined ? undefined : REFUSED[code];
  return key ? t(key) : tCommon(errorMessageKey(error));
}

const cancellable = (order: Order) => order.status === 'placed' || order.status === 'accepted';

/**
 * The encounter's lab orders (#82), for `order:read`, oldest first with the cancelled ones kept
 * and marked, each with its status in words. `order:create` orders a test or panel from the
 * catalog while the encounter is open; `order:cancel` cancels one not yet started, with a reason,
 * also after it closed. Moving an order on is the laboratory's, and so are its results (M8).
 */
export function LabOrdersPanel({ encounter }: { encounter: Encounter }) {
  const { t } = useTranslation('clinical');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const headingId = useId();
  const canCreate = usePermission('order:create');
  const orders = useOrders(encounter.id, 'lab');
  const box = useRef<HTMLElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  const [cancelling, setCancelling] = useState<Order | null>(null);
  usePanelFocus(cancelling?.id ?? null, box, status);
  const rows = useMemo(() => orders.data?.pages.flatMap((page) => page.items) ?? [], [orders.data]);
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);

  const columns = useMemo<GridColumn<Order>[]>(
    () => [
      {
        id: 'test',
        header: t('labOrders.columns.test'),
        value: (row) => row.itemName ?? '',
        hideable: false,
        render: (row, text) =>
          row.status === 'cancelled' ? (
            <span className="text-muted-foreground line-through">{text}</span>
          ) : (
            text
          ),
      },
      {
        id: 'priority',
        header: t('labOrders.columns.priority'),
        value: (row) => t(`labOrders.priority.${row.priority}`),
      },
      {
        id: 'status',
        header: t('labOrders.columns.status'),
        // A word, never the strike-through alone.
        value: (row) =>
          row.status === 'cancelled' && row.cancelReason
            ? t('labOrders.cancelled', { reason: row.cancelReason })
            : t(`labOrders.status.${row.status}`),
      },
      {
        id: 'ordered',
        header: t('labOrders.columns.ordered'),
        value: (row) =>
          t('labOrders.orderedBy', {
            name: row.orderedByName,
            time: format.dateTime(row.placedAt),
          }),
      },
      {
        id: 'instructions',
        header: t('labOrders.columns.instructions'),
        value: (row) => row.instructions ?? '',
      },
    ],
    [t, format],
  );

  const actions = useMemo<GridAction<Order>[]>(
    () =>
      encounter.status === 'cancelled'
        ? []
        : [
            {
              id: 'cancel',
              label: t('labOrders.cancel'),
              requires: 'order:cancel',
              disabled: (row) => !cancellable(row),
              onSelect: (row) => setCancelling(row),
            },
          ],
    [t, encounter.status],
  );

  return (
    <section ref={box} aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2 id={headingId} className="text-lg font-semibold">
        {t('labOrders.heading')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('labOrders.resultsLater')}</p>
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 empty:hidden"
      >
        {message.text}
      </p>
      <DataGrid
        label={t('labOrders.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.itemName ?? ''}
        actions={actions}
        status={orders.isPending ? 'loading' : orders.isError ? 'error' : 'ready'}
        errorMessage={orders.isError ? tCommon(errorMessageKey(orders.error)) : undefined}
        onRetry={() => void orders.refetch()}
        emptyMessage={t('labOrders.empty')}
        hasNextPage={orders.hasNextPage}
        loadingMore={orders.isFetchingNextPage}
        onLoadMore={() => void orders.fetchNextPage()}
      />
      {cancelling && (
        <CancelForm
          // The order as the list has it now: a refusal re-reads the list, so the next try
          // sends the version the server holds, and an order started meanwhile is said so.
          order={rows.find((row) => row.id === cancelling.id) ?? cancelling}
          onCancel={() => setCancelling(null)}
          onCancelled={() => {
            setCancelling(null);
            say(t('labOrders.cancelledNow'));
          }}
        />
      )}
      {canCreate && encounter.status === 'open' && (
        // Kept while a cancellation is asked, so a half-filled order is not lost.
        <div hidden={cancelling !== null}>
          <OrderForm
            encounterId={encounter.id}
            active={rows.filter(isActiveOrder)}
            onPlaced={() => say(t('labOrders.placed'))}
          />
        </div>
      )}
    </section>
  );
}

function CancelForm({
  order,
  onCancel,
  onCancelled,
}: {
  order: Order;
  onCancel: () => void;
  onCancelled: () => void;
}) {
  const { t } = useTranslation('clinical');
  const cancel = useCancelOrder(order.encounterId);
  const form = useZodForm(reasonSchema, { reason: '' });
  const failure = useRefusal(cancel.error);
  const buttons = useRef<HTMLDivElement>(null);
  // Started or cancelled meanwhile (the list was read again after a refusal): nothing to send.
  const settled = !cancellable(order) && !cancel.isPending && !cancel.isSuccess;
  useLayoutEffect(() => {
    if (settled) focusIfLost(buttons.current?.querySelector('button'));
  }, [settled]);
  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <h3 data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('labOrders.cancelHeading', { name: order.itemName ?? '' })}
      </h3>
      <Form
        form={form}
        onSubmit={(values: ReasonValues) =>
          cancel.mutate({ order, reason: values.reason }, { onSuccess: onCancelled })
        }
      >
        <TextField<ReasonValues>
          name="reason"
          label={t('labOrders.cancelReason')}
          required
          maxLength={REASON_MAX}
          autoComplete="off"
        />
        {settled ? (
          <p role="alert" className="text-sm text-destructive">
            {t(
              order.status === 'cancelled'
                ? 'labOrders.refused.alreadyCancelled'
                : 'labOrders.refused.started',
            )}
          </p>
        ) : (
          failure && (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          )
        )}
        <div ref={buttons} className="flex flex-wrap gap-2">
          {!settled && (
            <SubmitButton pending={cancel.isPending}>{t('labOrders.cancelSubmit')}</SubmitButton>
          )}
          <Button type="button" variant="outline" onClick={onCancel}>
            {t(settled ? 'labOrders.close' : 'labOrders.keep')}
          </Button>
        </div>
      </Form>
    </div>
  );
}

/**
 * Orders a test or panel chosen from the catalog, with how soon and instructions. One already in
 * effect in this consultation is said in words beside the choice: it warns, never refuses, as a
 * test may be repeated on purpose.
 */
function OrderForm({
  encounterId,
  active,
  onPlaced,
}: {
  encounterId: string;
  active: Order[];
  onPlaced: () => void;
}) {
  const { t } = useTranslation('clinical');
  const headingId = useId();
  const place = usePlaceOrder(encounterId);
  const form = useZodForm(labOrderFormSchema, blankLabOrder);
  const [test, setTest] = useState<LabTest | null>(null);
  const failure = useRefusal(place.error);
  const choose = (chosen: LabTest | null) => {
    setTest(chosen);
    form.setValue('labTestId', chosen?.id ?? '', { shouldValidate: form.formState.isSubmitted });
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h3 id={headingId} className="font-semibold">
        {t('labOrders.form.heading')}
      </h3>
      <Form
        form={form}
        onSubmit={(values) =>
          place.mutate(toLabOrderCreate(values), {
            onSuccess: () => {
              form.reset(blankLabOrder);
              setTest(null);
              onPlaced();
            },
          })
        }
      >
        <TestField
          test={test}
          onChoose={choose}
          repeated={test ? active.find((order) => order.labTestId === test.id) : undefined}
        />
        <SelectField<LabOrderValues>
          name="priority"
          label={t('labOrders.form.priority')}
          required
          options={ORDER_PRIORITIES.map((priority) => ({
            value: priority,
            label: t(`labOrders.priority.${priority}`),
          }))}
        />
        <TextAreaField<LabOrderValues>
          name="instructions"
          label={t('labOrders.form.instructions')}
          hint={t('labOrders.form.instructionsHint')}
          maxLength={INSTRUCTIONS_MAX}
        />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
        <SubmitButton pending={place.isPending} className="self-start">
          {t('labOrders.form.submit')}
        </SubmitButton>
      </Form>
    </section>
  );
}

/** The test of an order: the search until one is chosen, then its name and "Change". */
function TestField({
  test,
  onChoose,
  repeated,
}: {
  test: LabTest | null;
  onChoose: (test: LabTest | null) => void;
  /** An order of the same test still in effect in this consultation. */
  repeated: Order | undefined;
}) {
  const { t } = useTranslation('clinical');
  const error = useFieldError('labTestId');
  const focusRef = useFieldFocusRef('labTestId');
  const errorId = useId();
  const warningId = useId();
  const box = useRef<HTMLDivElement | null>(null);

  const choose = (chosen: LabTest | null) => {
    onChoose(chosen);
    // The search and the chosen test take each other's place: focus goes to what replaced it.
    requestAnimationFrame(() =>
      focusIfLost(box.current?.querySelector<HTMLElement>('button, input')),
    );
  };

  return (
    <div
      ref={(element) => {
        box.current = element;
        focusRef(element);
      }}
      className="flex flex-col gap-1.5"
    >
      {test ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">{t('labOrders.form.test')}</p>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="break-words">
              {t('labOrders.form.chosen', { code: test.code, name: test.name })}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={t('labOrders.form.changeTest', { name: test.name })}
              aria-describedby={repeated ? warningId : undefined}
              onClick={() => choose(null)}
            >
              {t('labOrders.form.change')}
            </Button>
          </div>
          {repeated && (
            <p id={warningId} className="flex items-start gap-1.5 text-sm">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              {t('labOrders.form.repeated', { status: t(`labOrders.status.${repeated.status}`) })}
            </p>
          )}
        </div>
      ) : (
        <LabTestSearch
          label={t('labOrders.form.test')}
          onSelect={choose}
          invalid={error !== undefined}
          describedBy={error ? errorId : undefined}
        />
      )}
      {error && (
        // Linked to the search box; the form kit moves focus to it on a failed submit.
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
