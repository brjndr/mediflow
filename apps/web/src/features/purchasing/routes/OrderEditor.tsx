import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useFeatureFlag, usePermission } from '@/access';
import { DrugSearch, useMedicineName } from '@/features/drugs';
import { usePlaces } from '@/features/inventory';
import { currencyDigits, toMinor } from '@/features/services';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button, buttonVariants } from '@/shared/ui/button';
import {
  Form,
  SelectField,
  SubmitButton,
  TextField,
  useFieldRows,
  useZodForm,
} from '@/shared/ui/form';
import { useFormatters, useTenant } from '@/tenancy';
import { PurchasingLinks } from '../components/PurchasingLinks';
import { useOrder, useSaveOrder, useSuppliers } from '../hooks/use-purchasing';
import {
  createOrderFormSchema,
  ORDER_LINES_MAX,
  ORDER_NOTE_MAX,
  type OrderFormValues,
} from '../schemas';
import type { PurchaseOrder } from '../types';

const REFUSED: Record<string, string> = {
  order_status: 'order.refused.status',
  conflict: 'order.refused.conflict',
  order_not_found: 'order.refused.gone',
  validation_failed: 'order.refused.invalid',
};

const useOrderForm = (schema: ReturnType<typeof createOrderFormSchema>, values: OrderFormValues) =>
  useZodForm<OrderFormValues, OrderFormValues>(schema, values);
type OrderForm = ReturnType<typeof useOrderForm>;

/** An amount in minor units as it is typed: 1250 with two digits is "12.50". */
const typed = (minor: number, digits: number) => (minor / 10 ** digits).toFixed(digits);

/** The form's values of an order, or of a new one. */
const valuesOf = (order: PurchaseOrder | null, digits: number): OrderFormValues => ({
  supplierId: order?.supplierId ?? '',
  locationId: order?.locationId ?? '',
  note: order?.note ?? '',
  lines:
    order?.lines.map((line) => ({
      drugId: line.drugId,
      name: line.itemName,
      quantity: String(line.quantity),
      unitCost: typed(line.unitCostMinor, digits),
    })) ?? [],
});

const FIELDS = ['supplierId', 'locationId', 'note', 'lines'] as const;
type Field = (typeof FIELDS)[number];
/** Whether a field holds the same in two sets of values; the lines as a whole. */
const same = (a: OrderFormValues, b: OrderFormValues, field: Field) =>
  field === 'lines'
    ? JSON.stringify(a.lines.map(({ name: _name, ...line }) => line)) ===
      JSON.stringify(b.lines.map(({ name: _name, ...line }) => line))
    : a[field] === b[field];

/**
 * A purchase order drafted (`purchasing/orders/new`) or a draft changed
 * (`purchasing/orders/:orderId/edit`), for `purchaseOrder:create`: the supplier, the place it is
 * to be delivered to (inventory's places), a note, and its lines, each an item added with the
 * drug search (medicines and consumables), its units and the agreed price of one. Saving opens
 * the order. Works at every width.
 */
export default function OrderEditor() {
  const { orderId = '' } = useParams();
  const { t } = useTranslation('purchasing');
  const { t: tCommon } = useTranslation();
  const order = useOrder(orderId);
  if (orderId === '') return <OrderFormScreen order={null} />;
  if (order.isPending) {
    return <p className="px-4 py-6 text-sm text-muted-foreground">{t('order.loading')}</p>;
  }
  if (!order.data) {
    const gone = isApiError(order.error) && order.error.status === 404;
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-4 py-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('order.editHeading')}</h1>
        <p role="alert" className="text-sm text-destructive">
          {gone ? t('order.notFound') : tCommon(errorMessageKey(order.error))}
        </p>
        <Link to="/purchasing" className={buttonVariants({ variant: 'outline' })}>
          {t('order.back')}
        </Link>
      </div>
    );
  }
  if (order.data.status !== 'draft') {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-4 py-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('order.editHeading')}</h1>
        <p className="text-sm">{t('order.notDraft', { reference: order.data.reference })}</p>
        <Link
          to={`/purchasing/orders/${order.data.id}`}
          className={buttonVariants({ variant: 'outline' })}
        >
          {t('order.openIt')}
        </Link>
      </div>
    );
  }
  return <OrderFormScreen key={order.data.id} order={order.data} />;
}

/**
 * The form. An edit is made from the order as it was when the form opened, and sends only the
 * fields changed since. When someone else saved the draft meanwhile (409 `conflict`), the form
 * moves to the newest version: a field this person did not touch takes what was saved, what they
 * typed stays, and the fields both changed are named, so saving again is a choice.
 */
function OrderFormScreen({ order }: { order: PurchaseOrder | null }) {
  const { t } = useTranslation('purchasing');
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();
  const digits = currencyDigits(useTenant()?.currency);
  const schema = useMemo(() => createOrderFormSchema((text) => toMinor(text, digits)), [digits]);
  // The order the edit is made from: the one read when the form opened, then the newest after a
  // conflict. `order` itself follows every read in the background.
  const [from, setFrom] = useState(order);
  const [awaiting, setAwaiting] = useState(false);
  const [theirs, setTheirs] = useState<Field[]>([]);
  const form = useOrderForm(schema, valuesOf(from, digits));
  const { getValues, setValue } = form;
  // What someone else saved, taken in once the newest version is read after a conflict: noticed
  // while rendering, as the drugs screen does, and written into the untouched fields after it.
  const [taken, setTaken] = useState<{ fields: Field[]; values: OrderFormValues } | null>(null);
  if (awaiting && order && from && order.version !== from.version) {
    const before = valuesOf(from, digits);
    const saved = valuesOf(order, digits);
    const now = getValues();
    const untouched = FIELDS.filter((field) => same(now, before, field));
    setFrom(order);
    setTheirs(FIELDS.filter((field) => !untouched.includes(field) && !same(saved, before, field)));
    setTaken({ fields: untouched, values: saved });
    setAwaiting(false);
  }
  useEffect(() => {
    for (const field of taken?.fields ?? []) {
      if (taken) setValue(field, taken.values[field]);
    }
  }, [taken, setValue]);

  // The places are inventory's: read only by whoever may, with inventory switched on.
  const mayReadStock = usePermission('stock:read');
  const inventoryOn = useFeatureFlag('inventory');
  const canSeePlaces = mayReadStock && inventoryOn;
  const places = usePlaces(canSeePlaces);
  const supplierList = useSuppliers(false);
  const suppliers = useMemo(
    () => supplierList.data?.pages.flatMap((page) => page.items) ?? [],
    [supplierList.data],
  );

  const save = useSaveOrder();
  const code = isApiError(save.error) ? save.error.serverCode : undefined;
  const failure = save.error
    ? code !== undefined && REFUSED[code]
      ? t(REFUSED[code])
      : tCommon(errorMessageKey(save.error))
    : undefined;
  const alert = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (failure) focusIfLost(alert.current);
  }, [failure]);

  const submit = async (values: OrderFormValues) => {
    save.reset();
    const before = valuesOf(from, digits);
    const changed = FIELDS.filter((field) => !same(values, before, field));
    if (from && changed.length === 0) {
      navigate(`/purchasing/orders/${from.id}`);
      return;
    }
    try {
      const saved = await save.mutateAsync({
        order: from,
        changed,
        create: {
          supplierId: values.supplierId,
          locationId: values.locationId,
          ...(values.note === '' ? {} : { note: values.note }),
          lines: values.lines.map((line) => ({
            drugId: line.drugId,
            quantity: Number(line.quantity),
            unitCostMinor: toMinor(line.unitCost, digits) ?? 0,
          })),
        },
      });
      navigate(`/purchasing/orders/${saved.id}`, {
        state: { saved: order ? 'edited' : 'drafted' },
      });
    } catch (error) {
      // Said from the mutation state; after a conflict the newest version is read and taken in.
      if (isApiError(error) && error.serverCode === 'conflict') setAwaiting(true);
    }
  };

  // The place to deliver to is one of inventory's: without them no order can be made here.
  if (!canSeePlaces) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-4 py-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          {order ? t('order.editHeadingOf', { reference: order.reference }) : t('order.newHeading')}
        </h1>
        <p className="text-sm">{t('order.placesHidden')}</p>
        <Link to="/purchasing" className={buttonVariants({ variant: 'outline' })}>
          {t('order.back')}
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {order ? t('order.editHeadingOf', { reference: order.reference }) : t('order.newHeading')}
        </h1>
        <PurchasingLinks />
      </div>
      <Form form={form} onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <SelectField
            name="supplierId"
            label={t('order.supplier')}
            required
            placeholder={t(
              supplierList.isPending ? 'order.loadingSuppliers' : 'order.chooseSupplier',
            )}
            hint={
              !supplierList.isPending && suppliers.length === 0 ? t('order.noSuppliers') : undefined
            }
            options={suppliers.map((supplier) => ({ value: supplier.id, label: supplier.name }))}
          />
          <SelectField
            name="locationId"
            label={t('order.place')}
            required
            placeholder={t('order.choosePlace')}
            options={places.map((place) => ({ value: place.id, label: place.name }))}
          />
          <TextField
            name="note"
            label={t('order.note')}
            maxLength={ORDER_NOTE_MAX}
            autoComplete="off"
          />
        </div>
        <OrderLines form={form} />
        {theirs.length > 0 && (
          <div role="status" className="rounded-md border p-3 text-sm">
            <p className="font-medium">{t('order.theySaved')}</p>
            <ul className="mt-1 list-disc pl-5">
              {theirs.map((field) => (
                <li key={field}>{t(`order.field.${field}`)}</li>
              ))}
            </ul>
          </div>
        )}
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
          {/* Until the newest version is taken in after a conflict, a save would only conflict again. */}
          <SubmitButton pending={save.isPending || awaiting}>
            {save.isPending
              ? t('order.saving')
              : t(order ? 'order.saveChanges' : 'order.saveDraft')}
          </SubmitButton>
          <Link
            to={order ? `/purchasing/orders/${order.id}` : '/purchasing'}
            className={buttonVariants({ variant: 'outline' })}
          >
            {t('order.cancelEdit')}
          </Link>
        </div>
      </Form>
    </div>
  );
}

/**
 * The lines, a row per item: its units, the price of one and Remove; then the search to add
 * another. Focus goes to a new row's units, and to the search when a row is removed.
 */
function OrderLines({ form }: { form: OrderForm }) {
  const { t } = useTranslation('purchasing');
  const format = useFormatters();
  const nameOf = useMedicineName();
  const digits = currencyDigits(useTenant()?.currency);
  const rows = useFieldRows('lines');
  const lines = form.watch('lines');
  const search = useRef<HTMLDivElement>(null);
  const focusNext = useRef<number | 'search' | null>(null);
  const [notice, setNotice] = useState('');
  const count = rows.keys.length;
  useLayoutEffect(() => {
    const next = focusNext.current;
    focusNext.current = null;
    if (next === 'search') search.current?.querySelector('input')?.focus();
    else if (next !== null) form.setFocus(`lines.${next}.quantity`);
  }, [count, form]);
  const linesError = form.formState.errors.lines?.message;
  const linesErrorId = useId();
  useLayoutEffect(() => {
    if (linesError) search.current?.querySelector('input')?.focus();
  }, [linesError]);

  let total = 0;
  for (const line of lines) {
    const cost = toMinor(line.unitCost, digits);
    if (cost !== null && /^\d+$/.test(line.quantity)) total += cost * Number(line.quantity);
  }

  return (
    <section className="flex flex-col gap-3" aria-labelledby={`${linesErrorId}-heading`}>
      <h2 id={`${linesErrorId}-heading`} className="font-semibold">
        {t('order.lines')}
      </h2>
      {count === 0 && <p className="text-sm text-muted-foreground">{t('order.noLinesYet')}</p>}
      <ul className="flex flex-col gap-3">
        {rows.keys.map((key, index) => {
          const line = lines[index];
          return (
            <li key={key} className="flex flex-col gap-2 rounded-md border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="min-w-0 break-words font-medium">{line?.name}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={t('order.remove', { name: line?.name })}
                  onClick={() => {
                    focusNext.current = 'search';
                    rows.remove(index);
                  }}
                >
                  {t('order.removeShort')}
                </Button>
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <TextField
                  name={`lines.${index}.quantity`}
                  label={t('order.units', { name: line?.name })}
                  inputMode="numeric"
                  autoComplete="off"
                  required
                />
                <TextField
                  name={`lines.${index}.unitCost`}
                  label={t('order.unitCost', { name: line?.name })}
                  hint={t('order.unitCostHint')}
                  inputMode="decimal"
                  autoComplete="off"
                  required
                />
              </div>
            </li>
          );
        })}
      </ul>
      {linesError && (
        <p id={linesErrorId} role="alert" className="text-sm text-destructive">
          {t(linesError)}
        </p>
      )}
      <p role="status" className="text-sm text-muted-foreground">
        {notice}
      </p>
      {count < ORDER_LINES_MAX ? (
        <div ref={search}>
          <DrugSearch
            label={t('order.add')}
            includeConsumables
            invalid={linesError !== undefined}
            describedBy={linesError ? linesErrorId : undefined}
            onSelect={(drug) => {
              const at = lines.findIndex((each) => each.drugId === drug.id);
              if (at >= 0) {
                setNotice(t('order.alreadyThere', { name: nameOf(drug) }));
                form.setFocus(`lines.${at}.quantity`);
                return;
              }
              setNotice('');
              focusNext.current = lines.length;
              rows.add({ drugId: drug.id, name: nameOf(drug), quantity: '', unitCost: '' });
              form.clearErrors('lines');
            }}
          />
        </div>
      ) : (
        <p className="text-sm">{t('order.full', { count: ORDER_LINES_MAX })}</p>
      )}
      <p className="font-semibold">{t('order.total', { total: format.money(total) })}</p>
    </section>
  );
}
