import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFeatureFlag, usePermission } from '@/access';
import { usePlaces } from '@/features/inventory';
import { currencyDigits, toMinor } from '@/features/services';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { Form, SubmitButton, TextField, useFieldRows, useZodForm } from '@/shared/ui/form';
import { todayIn } from '@/shared/utils';
import { useFormatters, useTenant } from '@/tenancy';
import { useReceiveGoods } from '../hooks/use-purchasing';
import {
  BATCH_NUMBER_MAX,
  createReceiveFormSchema,
  INVOICE_MAX,
  NOTE_MAX,
  RECEIPT_LINES_MAX,
  type ReceiveFormValues,
} from '../schemas';
import type { GoodsReceipt, PurchaseOrder } from '../types';
import { field } from './field';

const REFUSED: Record<string, string> = {
  over_receipt: 'receive.refused.over',
  cost_above_order: 'receive.refused.costAbove',
  item_archived: 'receive.refused.itemArchived',
  batch_exists: 'receive.refused.batchExists',
  batch_expired: 'receive.refused.expired',
  order_status: 'receive.refused.status',
  validation_failed: 'receive.refused.invalid',
  unknown_location: 'receive.refused.place',
};

const typed = (minor: number, digits: number) => (minor / 10 ** digits).toFixed(digits);

const useReceiveForm = (
  schema: ReturnType<typeof createReceiveFormSchema>,
  values: ReceiveFormValues,
) => useZodForm<ReceiveFormValues, ReceiveFormValues>(schema, values);
type ReceiveForm = ReturnType<typeof useReceiveForm>;

/**
 * Goods received against an approved order (#103), for `goodsReceipt:create`, in a panel in
 * place: where they came in (the order's place first), the supplier's invoice, and a row per
 * batch, each started with what its line still waits for and its agreed price; **Another batch**
 * adds a row for a line that came in two batches. A row left without units is not received. The
 * batches come into stock at once. Shown with `data-panel-heading` for the panel's focus.
 */
export function ReceivePanel({
  order,
  onClose,
  onReceived,
}: {
  order: PurchaseOrder;
  onClose: () => void;
  onReceived: (receipt: GoodsReceipt) => void;
}) {
  const { t } = useTranslation('purchasing');
  const { t: tCommon } = useTranslation();
  const tenant = useTenant();
  const digits = currencyDigits(tenant?.currency);
  const today = todayIn(tenant?.timezone ?? 'UTC');
  const headingId = useId();
  const placeFieldId = useId();
  // Taken when the panel opens, so the rows stay with their lines while the order is read again.
  const [open] = useState(() =>
    order.lines.filter((line) => line.receivedQuantity < line.quantity),
  );
  const left = useMemo(
    () => Object.fromEntries(open.map((line) => [line.id, line.quantity - line.receivedQuantity])),
    [open],
  );
  const agreed = useMemo(
    () => Object.fromEntries(open.map((line) => [line.id, line.unitCostMinor])),
    [open],
  );
  const schema = useMemo(
    () => createReceiveFormSchema((text) => toMinor(text, digits), today, left, agreed),
    [digits, today, left, agreed],
  );
  const form = useReceiveForm(schema, {
    supplierInvoice: '',
    note: '',
    rows: open.map((line) => ({
      orderLineId: line.id,
      batchNumber: '',
      expiryDate: '',
      quantity: String(line.quantity - line.receivedQuantity),
      unitCost: typed(line.unitCostMinor, digits),
      mrp: '',
    })),
  });

  const mayReadStock = usePermission('stock:read');
  const inventoryOn = useFeatureFlag('inventory');
  const places = usePlaces(mayReadStock && inventoryOn);
  const [locationId, setLocationId] = useState(order.locationId);

  const receive = useReceiveGoods(order.id);
  const code = isApiError(receive.error) ? receive.error.serverCode : undefined;
  const failure = receive.error
    ? code !== undefined && REFUSED[code]
      ? t(REFUSED[code])
      : tCommon(errorMessageKey(receive.error))
    : undefined;
  const alert = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (failure) focusIfLost(alert.current);
  }, [failure]);

  const submit = async (values: ReceiveFormValues) => {
    receive.reset();
    try {
      const receipt = await receive.mutateAsync({
        ...(locationId === order.locationId ? {} : { locationId }),
        ...(values.supplierInvoice === '' ? {} : { supplierInvoice: values.supplierInvoice }),
        ...(values.note === '' ? {} : { note: values.note }),
        lines: values.rows
          .filter((row) => row.quantity !== '')
          .map((row) => {
            const mrpMinor = row.mrp === '' ? null : toMinor(row.mrp, digits);
            return {
              orderLineId: row.orderLineId,
              batchNumber: row.batchNumber,
              expiryDate: row.expiryDate,
              quantity: Number(row.quantity),
              unitCostMinor: toMinor(row.unitCost, digits) ?? 0,
              ...(mrpMinor === null ? {} : { mrpMinor }),
            };
          }),
      });
      onReceived(receipt);
    } catch {
      // Said from the mutation state.
    }
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h2 id={headingId} data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('receive.heading', { reference: order.reference })}
      </h2>
      <p className="text-sm text-muted-foreground">{t('receive.description')}</p>
      <Form form={form} onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={placeFieldId} className="text-sm font-medium">
              {t('receive.place')}
            </label>
            <select
              id={placeFieldId}
              className={field}
              value={locationId}
              onChange={(event) => setLocationId(event.target.value)}
            >
              {!places.some((place) => place.id === order.locationId) && (
                <option value={order.locationId}>{order.locationName}</option>
              )}
              {places.map((place) => (
                <option key={place.id} value={place.id}>
                  {place.name}
                </option>
              ))}
            </select>
          </div>
          <TextField
            name="supplierInvoice"
            label={t('receive.invoice')}
            maxLength={INVOICE_MAX}
            autoComplete="off"
          />
        </div>
        <ReceiveRows form={form} order={order} />
        <TextField name="note" label={t('receive.note')} maxLength={NOTE_MAX} autoComplete="off" />
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
          <SubmitButton pending={receive.isPending}>
            {receive.isPending ? t('receive.submitting') : t('receive.submit')}
          </SubmitButton>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </Form>
    </section>
  );
}

/** A row per batch, named by its item; a new row's batch number takes focus. */
function ReceiveRows({ form, order }: { form: ReceiveForm; order: PurchaseOrder }) {
  const { t } = useTranslation('purchasing');
  const format = useFormatters();
  const rows = useFieldRows('rows');
  const values = form.watch('rows');
  const focusNext = useRef<number | null>(null);
  const count = rows.keys.length;
  useLayoutEffect(() => {
    const next = focusNext.current;
    focusNext.current = null;
    if (next !== null) form.setFocus(`rows.${next}.batchNumber`);
  }, [count, form]);
  const lineOf = (orderLineId: string) => order.lines.find((line) => line.id === orderLineId);

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {rows.keys.map((key, index) => {
          const row = values[index];
          const line = lineOf(row?.orderLineId ?? '');
          const name = line?.itemName ?? '';
          return (
            <li key={key} className="flex flex-col gap-2 rounded-md border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-words font-medium">{name}</p>
                  {line && (
                    <p className="text-xs text-muted-foreground">
                      {t('receive.waiting', {
                        count: line.quantity - line.receivedQuantity,
                        price: format.money(line.unitCostMinor),
                      })}
                    </p>
                  )}
                </div>
                {count < RECEIPT_LINES_MAX && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t('receive.anotherBatchOf', { name })}
                    onClick={() => {
                      focusNext.current = count;
                      rows.add({
                        orderLineId: row?.orderLineId ?? '',
                        batchNumber: '',
                        expiryDate: '',
                        quantity: '',
                        unitCost: row?.unitCost ?? '',
                        mrp: row?.mrp ?? '',
                      });
                    }}
                  >
                    {t('receive.anotherBatch')}
                  </Button>
                )}
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                <TextField
                  name={`rows.${index}.batchNumber`}
                  label={t('receive.batchNumber', { name })}
                  maxLength={BATCH_NUMBER_MAX}
                  autoComplete="off"
                />
                <TextField
                  name={`rows.${index}.expiryDate`}
                  type="date"
                  label={t('receive.expiryDate', { name })}
                />
                <TextField
                  name={`rows.${index}.quantity`}
                  label={t('receive.units', { name })}
                  hint={t('receive.unitsHint')}
                  inputMode="numeric"
                  autoComplete="off"
                />
                <TextField
                  name={`rows.${index}.unitCost`}
                  label={t('receive.unitCost', { name })}
                  inputMode="decimal"
                  autoComplete="off"
                />
                <TextField
                  name={`rows.${index}.mrp`}
                  label={t('receive.mrp', { name })}
                  hint={t('receive.mrpHint')}
                  inputMode="decimal"
                  autoComplete="off"
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
