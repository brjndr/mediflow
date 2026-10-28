import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { currencyDigits, toMinor } from '@/features/services';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import {
  Form,
  SelectField,
  SubmitButton,
  TextField,
  useFieldError,
  useFieldFocusRef,
  useFieldValue,
  useSetFieldValue,
  useZodForm,
} from '@/shared/ui/form';
import { useFormatters, useTenant } from '@/tenancy';
import { useCreateAdjustment, usePlaces, useStock } from '../hooks/use-inventory';
import {
  BATCH_NUMBER_MAX,
  createAdjustmentFormSchema,
  EXPIRING_DEFAULT,
  FIXED_DIRECTION,
  NOTE_MAX,
  REASONS,
  type AdjustmentFormInput,
  type AdjustmentFormValues,
} from '../schemas';
import type { StockAdjustment, StockAdjustmentCreate } from '../types';
import { ItemPicker, type PickedItem } from './ItemPicker';

/** Refusals of what was sent, in words of their own: the form stays open to change it. */
const REFUSED: Record<string, string> = {
  insufficient_stock: 'adjust.refused.insufficient',
  batch_exists: 'adjust.refused.batchExists',
  validation_failed: 'adjust.refused.invalid',
};

/**
 * Asking for a stock adjustment (#102), for `stock:adjust`: a place, an item, a batch of it (or a
 * new batch, for opening stock), a reason, a whole number in or out (fixed by the reason for
 * opening, damaged and expired stock) and a note. Nothing moves until someone else approves it.
 * Shown in place, with `data-panel-heading` for the panel's focus.
 */
export function AdjustmentForm({
  initialItem,
  onClose,
  onAsked,
}: {
  initialItem: PickedItem | null;
  onClose: () => void;
  onAsked: (adjustment: StockAdjustment) => void;
}) {
  const { t } = useTranslation('inventory');
  const { t: tCommon } = useTranslation();
  const digits = currencyDigits(useTenant()?.currency);
  const schema = useMemo(
    () => createAdjustmentFormSchema((text) => toMinor(text, digits)),
    [digits],
  );
  const writeOff = initialItem?.writeOff;
  const form = useZodForm<AdjustmentFormInput, AdjustmentFormValues>(schema, {
    locationId: writeOff?.locationId ?? '',
    drugId: initialItem?.id ?? '',
    reason: writeOff ? 'expired' : 'count_correction',
    batch: writeOff?.batchId ?? '',
    batchNumber: '',
    expiryDate: '',
    mrp: '',
    direction: writeOff ? 'out' : 'in',
    quantity: writeOff ? String(writeOff.quantity) : '',
    note: '',
  });
  const create = useCreateAdjustment();
  const headingId = useId();

  const submit = async (values: AdjustmentFormValues) => {
    create.reset();
    const isNew = values.batch === 'new';
    const quantity = Number(values.quantity) * (values.direction === 'out' ? -1 : 1);
    const mrpMinor = isNew && values.mrp !== '' ? toMinor(values.mrp, digits) : null;
    const body: StockAdjustmentCreate = {
      locationId: values.locationId,
      drugId: values.drugId,
      ...(isNew
        ? {
            batchNumber: values.batchNumber,
            expiryDate: values.expiryDate,
            ...(mrpMinor === null ? {} : { mrpMinor }),
          }
        : { batchId: values.batch }),
      quantity,
      reason: values.reason,
      ...(values.note === '' ? {} : { note: values.note }),
    };
    try {
      onAsked(await create.mutateAsync(body));
    } catch {
      // Said from the mutation state.
    }
  };

  const code = isApiError(create.error) ? create.error.serverCode : undefined;
  const failure = create.error
    ? code !== undefined && REFUSED[code]
      ? t(REFUSED[code])
      : tCommon(errorMessageKey(create.error))
    : undefined;
  const alert = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (failure) focusIfLost(alert.current);
  }, [failure]);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h2 id={headingId} data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('adjust.heading')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('adjust.description')}</p>
      <Form form={form} onSubmit={submit}>
        <AdjustmentFields initialItem={initialItem} />
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
          <SubmitButton pending={create.isPending}>
            {create.isPending ? t('adjust.submitting') : t('adjust.submit')}
          </SubmitButton>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </Form>
    </section>
  );
}

/** The fields, inside the form so each can follow the others. */
function AdjustmentFields({ initialItem }: { initialItem: PickedItem | null }) {
  const { t } = useTranslation('inventory');
  const format = useFormatters();
  const set = useSetFieldValue();
  const places = usePlaces();
  const drugId = String(useFieldValue('drugId') ?? '');
  const locationId = String(useFieldValue('locationId') ?? '');
  const reason = useFieldValue('reason') as AdjustmentFormValues['reason'];
  const batch = String(useFieldValue('batch') ?? '');
  const itemError = useFieldError('drugId');
  const itemFocus = useFieldFocusRef('drugId');
  const itemErrorId = useId();
  // The item as shown; the form holds its id.
  const [item, setItem] = useState(initialItem);

  // The batches of the item with stock somewhere, each once, soonest expiry first, with its units
  // at the place chosen (stock taken out of a batch that is elsewhere is refused): never those of
  // the item chosen before, still shown while the new one's are read.
  const stock = useStock(
    { locationId: '', drugId, alert: '', expiringWithinDays: EXPIRING_DEFAULT },
    drugId !== '',
  );
  const batches = useMemo(() => {
    const seen = new Map<string, { number: string; expiry: string; here: number }>();
    const shown = stock.isPlaceholderData ? undefined : stock.data?.pages[0]?.items[0];
    for (const each of shown?.batches ?? []) {
      const known = seen.get(each.batchId) ?? {
        number: each.batchNumber,
        expiry: each.expiryDate,
        here: 0,
      };
      if (each.locationId === locationId) known.here += each.onHand;
      seen.set(each.batchId, known);
    }
    return [...seen.entries()].map(([id, each]) => ({
      id,
      label: t(locationId ? 'adjust.batchOptionHere' : 'adjust.batchOption', {
        number: each.number,
        expiry: format.calendarDate(each.expiry),
        count: each.here,
      }),
    }));
  }, [stock.data, stock.isPlaceholderData, locationId, t, format]);

  // A write-off's batch is chosen again once the item's batches are read: the list had no such
  // option when the form opened.
  const writeOffBatch = initialItem?.writeOff?.batchId;
  const chosenOnce = useRef(false);
  useEffect(() => {
    if (chosenOnce.current || !writeOffBatch) return;
    if (!batches.some((each) => each.id === writeOffBatch)) return;
    chosenOnce.current = true;
    set('batch', writeOffBatch);
  }, [batches, writeOffBatch, set]);

  // The reason decides the way for opening, damaged and expired stock; a new batch is opening.
  const fixed = FIXED_DIRECTION[reason];
  useEffect(() => {
    if (fixed) set('direction', fixed);
  }, [fixed, set]);
  useEffect(() => {
    if (reason !== 'opening' && batch === 'new') set('batch', '');
  }, [reason, batch, set]);

  const isNew = batch === 'new';
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {/* A failed submit focuses the search box, the control that sets the item. */}
      <div ref={itemFocus}>
        <ItemPicker
          label={t('adjust.item')}
          value={item}
          invalid={Boolean(itemError)}
          describedBy={itemError ? itemErrorId : undefined}
          onChange={(picked) => {
            setItem(picked);
            set('drugId', picked?.id ?? '');
            set('batch', '');
          }}
        />
        {itemError && (
          <p id={itemErrorId} className="mt-1 text-sm text-destructive">
            {itemError}
          </p>
        )}
      </div>
      <SelectField
        name="locationId"
        label={t('adjust.place')}
        required
        placeholder={t('adjust.choosePlace')}
        options={places.map((place) => ({ value: place.id, label: place.name }))}
      />
      <SelectField
        name="reason"
        label={t('adjust.reason')}
        required
        options={REASONS.map((each) => ({ value: each, label: t(`reason.${each}`) }))}
      />
      <SelectField
        name="batch"
        label={t('adjust.batch')}
        hint={drugId ? undefined : t('adjust.batchHint')}
        required
        placeholder={t('adjust.chooseBatch')}
        options={[
          ...batches.map((each) => ({ value: each.id, label: each.label })),
          ...(reason === 'opening' ? [{ value: 'new', label: t('adjust.newBatch') }] : []),
        ]}
      />
      {isNew && (
        <>
          <TextField
            name="batchNumber"
            label={t('adjust.batchNumber')}
            required
            maxLength={BATCH_NUMBER_MAX}
            autoComplete="off"
          />
          <TextField name="expiryDate" type="date" label={t('adjust.expiryDate')} required />
          <TextField
            name="mrp"
            label={t('adjust.mrp')}
            hint={t('adjust.mrpHint')}
            inputMode="decimal"
            autoComplete="off"
          />
        </>
      )}
      {fixed ? (
        <p className="self-end text-sm text-muted-foreground md:pb-2">
          {t(`adjust.fixed.${fixed}`)}
        </p>
      ) : (
        <SelectField
          name="direction"
          label={t('adjust.direction')}
          required
          options={[
            { value: 'in', label: t('adjust.in') },
            { value: 'out', label: t('adjust.out') },
          ]}
        />
      )}
      <TextField
        name="quantity"
        label={t('adjust.quantity')}
        hint={t('adjust.quantityHint')}
        required
        inputMode="numeric"
        autoComplete="off"
      />
      <TextField
        name="note"
        label={t('adjust.note')}
        hint={t(reason === 'other' ? 'adjust.noteRequired' : 'adjust.noteHint')}
        maxLength={NOTE_MAX}
        autoComplete="off"
      />
    </div>
  );
}
