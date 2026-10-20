import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { LabTestSearch } from '@/features/lab-tests';
import { ServiceSearch } from '@/features/services';
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
  blankOrder,
  INSTRUCTIONS_MAX,
  isActiveOrder,
  ORDER_PRIORITIES,
  orderedItemId,
  orderFormSchema,
  REASON_MAX,
  reasonSchema,
  toOrderCreate,
  type OrderKind,
  type OrderValues,
  type ReasonValues,
} from '../schemas';
import type { Encounter, Order } from '../types';

/** What the server's refusal codes say, in the kind's own words where they differ. */
const refusals = (kind: OrderKind): Record<string, string> => ({
  encounter_not_open: 'orders.refused.notOpen',
  unknown_lab_test: `${kind}Orders.refused.unknownItem`,
  unknown_service: `${kind}Orders.refused.unknownItem`,
  invalid_transition: `${kind}Orders.refused.started`,
  conflict: 'orders.refused.conflict',
  order_not_found: 'orders.refused.gone',
});

function useRefusal(kind: OrderKind, error: unknown) {
  const { t } = useTranslation('clinical');
  const { t: tCommon } = useTranslation();
  if (!error) return undefined;
  const code = isApiError(error) ? error.serverCode : undefined;
  const key = code === undefined ? undefined : refusals(kind)[code];
  return key ? t(key) : tCommon(errorMessageKey(error));
}

/** The catalog item an order is for, as its search gives it. */
interface Item {
  id: string;
  code: string;
  name: string;
}

/** Results and reports come with the lab and radiology modules; a procedure has none. */
const SAYS_LATER: Record<OrderKind, boolean> = { lab: true, imaging: true, procedure: false };

const cancellable = (order: Order) => order.status === 'placed' || order.status === 'accepted';

/**
 * The encounter's orders of one kind, for `order:read`: lab (#82), imaging or procedure (#87).
 * Oldest first with the cancelled ones kept and marked, each with its status in words.
 * `order:create` orders a test or panel from the lab catalog, or a service of the kind's category,
 * while the encounter is open; `order:cancel` cancels one not yet started, with a reason, also
 * after it closed. Moving an order on is the department's that does it, and so are its results.
 */
export function OrdersPanel({ encounter, kind }: { encounter: Encounter; kind: OrderKind }) {
  const { t } = useTranslation('clinical');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const headingId = useId();
  const canCreate = usePermission('order:create');
  const orders = useOrders(encounter.id, kind);
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
        id: 'item',
        header: t(`${kind}Orders.item`),
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
        header: t('orders.columns.priority'),
        value: (row) => t(`orders.priority.${row.priority}`),
      },
      {
        id: 'status',
        header: t('orders.columns.status'),
        // A word, never the strike-through alone.
        value: (row) =>
          row.status === 'cancelled' && row.cancelReason
            ? t('orders.cancelled', { reason: row.cancelReason })
            : t(`${kind}Orders.status.${row.status}`),
      },
      {
        id: 'ordered',
        header: t('orders.columns.ordered'),
        value: (row) =>
          t('orders.orderedBy', {
            name: row.orderedByName,
            time: format.dateTime(row.placedAt),
          }),
      },
      {
        id: 'instructions',
        header: t('orders.columns.instructions'),
        value: (row) => row.instructions ?? '',
      },
    ],
    [t, format, kind],
  );

  const actions = useMemo<GridAction<Order>[]>(
    () =>
      encounter.status === 'cancelled'
        ? []
        : [
            {
              id: 'cancel',
              label: t('orders.cancel'),
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
        {t(`${kind}Orders.heading`)}
      </h2>
      {SAYS_LATER[kind] && (
        <p className="text-sm text-muted-foreground">{t(`${kind}Orders.later`)}</p>
      )}
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 empty:hidden"
      >
        {message.text}
      </p>
      <DataGrid
        label={t(`${kind}Orders.heading`)}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.itemName ?? ''}
        actions={actions}
        status={orders.isPending ? 'loading' : orders.isError ? 'error' : 'ready'}
        errorMessage={orders.isError ? tCommon(errorMessageKey(orders.error)) : undefined}
        onRetry={() => void orders.refetch()}
        emptyMessage={t(`${kind}Orders.empty`)}
        hasNextPage={orders.hasNextPage}
        loadingMore={orders.isFetchingNextPage}
        onLoadMore={() => void orders.fetchNextPage()}
      />
      {cancelling && (
        <CancelForm
          kind={kind}
          // The order as the list has it now: a refusal re-reads the list, so the next try
          // sends the version the server holds, and an order started meanwhile is said so.
          order={rows.find((row) => row.id === cancelling.id) ?? cancelling}
          onCancel={() => setCancelling(null)}
          onCancelled={() => {
            setCancelling(null);
            say(t('orders.cancelledNow'));
          }}
        />
      )}
      {canCreate && encounter.status === 'open' && (
        // Kept while a cancellation is asked, so a half-filled order is not lost.
        <div hidden={cancelling !== null}>
          <OrderForm
            kind={kind}
            encounterId={encounter.id}
            active={rows.filter(isActiveOrder)}
            onPlaced={() => say(t(`${kind}Orders.placed`))}
          />
        </div>
      )}
    </section>
  );
}

function CancelForm({
  kind,
  order,
  onCancel,
  onCancelled,
}: {
  kind: OrderKind;
  order: Order;
  onCancel: () => void;
  onCancelled: () => void;
}) {
  const { t } = useTranslation('clinical');
  const cancel = useCancelOrder(order.encounterId);
  const form = useZodForm(reasonSchema, { reason: '' });
  const failure = useRefusal(kind, cancel.error);
  const buttons = useRef<HTMLDivElement>(null);
  // Started or cancelled meanwhile (the list was read again after a refusal): nothing to send.
  const settled = !cancellable(order) && !cancel.isPending && !cancel.isSuccess;
  useLayoutEffect(() => {
    if (settled) focusIfLost(buttons.current?.querySelector('button'));
  }, [settled]);
  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <h3 data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('orders.cancelHeading', { name: order.itemName ?? '' })}
      </h3>
      <Form
        form={form}
        onSubmit={(values: ReasonValues) =>
          cancel.mutate({ order, reason: values.reason }, { onSuccess: onCancelled })
        }
      >
        <TextField<ReasonValues>
          name="reason"
          label={t('orders.cancelReason')}
          required
          maxLength={REASON_MAX}
          autoComplete="off"
        />
        {settled ? (
          <p role="alert" className="text-sm text-destructive">
            {t(
              order.status === 'cancelled'
                ? 'orders.refused.alreadyCancelled'
                : `${kind}Orders.refused.started`,
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
            <SubmitButton pending={cancel.isPending}>{t('orders.cancelSubmit')}</SubmitButton>
          )}
          <Button type="button" variant="outline" onClick={onCancel}>
            {t(settled ? 'orders.close' : 'orders.keep')}
          </Button>
        </div>
      </Form>
    </div>
  );
}

/**
 * Orders a test, study or procedure chosen from its catalog, with how soon and instructions. One
 * already in effect in this consultation is said in words beside the choice: it warns, never
 * refuses, as an order may be repeated on purpose.
 */
function OrderForm({
  kind,
  encounterId,
  active,
  onPlaced,
}: {
  kind: OrderKind;
  encounterId: string;
  active: Order[];
  onPlaced: () => void;
}) {
  const { t } = useTranslation('clinical');
  const headingId = useId();
  const place = usePlaceOrder(encounterId);
  const schema = useMemo(() => orderFormSchema(kind), [kind]);
  const form = useZodForm(schema, blankOrder);
  const [item, setItem] = useState<Item | null>(null);
  const failure = useRefusal(kind, place.error);
  const choose = (chosen: Item | null) => {
    setItem(chosen);
    form.setValue('itemId', chosen?.id ?? '', { shouldValidate: form.formState.isSubmitted });
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h3 id={headingId} className="font-semibold">
        {t(`${kind}Orders.form.heading`)}
      </h3>
      <Form
        form={form}
        onSubmit={(values) =>
          place.mutate(toOrderCreate(kind, values), {
            onSuccess: () => {
              form.reset(blankOrder);
              setItem(null);
              onPlaced();
            },
          })
        }
      >
        <ItemField
          kind={kind}
          item={item}
          onChoose={choose}
          repeated={item ? active.find((order) => orderedItemId(order) === item.id) : undefined}
        />
        <SelectField<OrderValues>
          name="priority"
          label={t('orders.form.priority')}
          required
          options={ORDER_PRIORITIES.map((priority) => ({
            value: priority,
            label: t(`orders.priority.${priority}`),
          }))}
        />
        <TextAreaField<OrderValues>
          name="instructions"
          label={t('orders.form.instructions')}
          hint={t(`${kind}Orders.form.instructionsHint`)}
          maxLength={INSTRUCTIONS_MAX}
        />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
        <SubmitButton pending={place.isPending} className="self-start">
          {t(`${kind}Orders.form.submit`)}
        </SubmitButton>
      </Form>
    </section>
  );
}

/** What is ordered: the kind's search until one is chosen, then its name and "Change". */
function ItemField({
  kind,
  item,
  onChoose,
  repeated,
}: {
  kind: OrderKind;
  item: Item | null;
  onChoose: (item: Item | null) => void;
  /** An order of the same item still in effect in this consultation. */
  repeated: Order | undefined;
}) {
  const { t } = useTranslation('clinical');
  const error = useFieldError('itemId');
  const focusRef = useFieldFocusRef('itemId');
  const errorId = useId();
  const warningId = useId();
  const box = useRef<HTMLDivElement | null>(null);

  const choose = (chosen: Item | null) => {
    onChoose(chosen);
    // The search and the chosen item take each other's place: focus goes to what replaced it.
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
      {item ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">{t(`${kind}Orders.form.item`)}</p>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="break-words">
              {t('orders.form.chosen', { code: item.code, name: item.name })}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={t(`${kind}Orders.form.changeItem`, { name: item.name })}
              aria-describedby={repeated ? warningId : undefined}
              onClick={() => choose(null)}
            >
              {t('orders.form.change')}
            </Button>
          </div>
          {repeated && (
            <p id={warningId} className="flex items-start gap-1.5 text-sm">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              {t(`${kind}Orders.form.repeated`, {
                status: t(`${kind}Orders.status.${repeated.status}`),
              })}
            </p>
          )}
        </div>
      ) : (
        <ItemSearch
          kind={kind}
          label={t(`${kind}Orders.form.item`)}
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

/** A lab order searches the lab catalog; imaging and procedure the services of their category. */
function ItemSearch({
  kind,
  ...props
}: {
  kind: OrderKind;
  label: string;
  onSelect: (item: Item) => void;
  invalid: boolean;
  describedBy: string | undefined;
}) {
  return kind === 'lab' ? (
    <LabTestSearch {...props} />
  ) : (
    <ServiceSearch category={kind} {...props} />
  );
}
