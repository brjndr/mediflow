import { TriangleAlert } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { matchesAllergy } from '@/features/clinical';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import {
  Form,
  SelectField,
  SubmitButton,
  TextField,
  useFieldValue,
  useSetFieldValue,
  useZodForm,
} from '@/shared/ui/form';
import { useFormatters } from '@/tenancy';
import { useDispense, useDispenseOptions } from '../hooks/use-pharmacy';
import {
  createDispenseFormSchema,
  nearestExpiryFirst,
  REASON_MAX,
  remainingOf,
  type DispenseFormValues,
} from '../schemas';
import type {
  DispensableItem,
  Dispense,
  DispenseCreate,
  PharmacyLine,
  PharmacyPrescription,
} from '../types';

/** The patient's allergies to check against, or why there are none to check. */
export interface AllergyCheck {
  substances: string[];
  /** Set when the check cannot be made: a key of `pharmacy`. */
  notice?: string;
}

/** Refusals in words of their own. */
const REFUSED: Record<string, string> = {
  conflict: 'dispense.refused.conflict',
  invalid_transition: 'dispense.refused.closed',
  order_not_found: 'dispense.refused.gone',
  over_quantity: 'dispense.refused.overQuantity',
  insufficient_stock: 'dispense.refused.insufficient',
  batch_expired: 'dispense.refused.expired',
  unknown_location: 'dispense.refused.place',
  unknown_batch: 'dispense.refused.batch',
  not_a_substitute: 'dispense.refused.substitute',
  item_archived: 'dispense.refused.archived',
};
/** After these the line cannot be dispensed from what the panel holds. */
const FINAL = new Set(['conflict', 'invalid_transition', 'order_not_found']);
/** After these the batches are read again, and the form starts over from them. */
const STOCK = new Set(['insufficient_stock', 'batch_expired']);

/**
 * Dispensing a line (#100), for `dispense:create`, in a panel in place: the medicine prescribed or
 * a generic substitute (the same generic name, form and strength) with a reason, and the units of
 * each of its batches in date at the place, filled nearest expiry first with what is left to give.
 * A medicine whose name matches a recorded allergy is warned of, and so is a check that could not
 * be made; sending then asks once more. Shown with `data-panel-heading` for the panel's focus.
 */
export function DispensePanel({
  prescription,
  line,
  locationId,
  allergies,
  onClose,
  onDispensed,
}: {
  prescription: PharmacyPrescription;
  line: PharmacyLine;
  locationId: string;
  allergies: AllergyCheck;
  onClose: () => void;
  onDispensed: (dispense: Dispense) => void;
}) {
  const { t } = useTranslation('pharmacy');
  const { t: tCommon } = useTranslation();
  const headingId = useId();
  const options = useDispenseOptions(line.orderId, locationId);
  // Only what has stock in date here can be given.
  const items = useMemo(
    () =>
      [
        ...(options.data?.prescribed ? [options.data.prescribed] : []),
        ...(options.data?.substitutes ?? []),
      ].filter((item) => item.batches.length > 0),
    [options.data],
  );
  const remaining = remainingOf(line);
  // The dispense lives here, above the form, so a refusal stays said when the form starts over.
  const dispense = useDispense(prescription.prescriptionId);
  const code = isApiError(dispense.error) ? dispense.error.serverCode : undefined;
  const failure = dispense.error
    ? code !== undefined && REFUSED[code]
      ? t(REFUSED[code])
      : tCommon(errorMessageKey(dispense.error))
    : undefined;
  const final = code !== undefined && FINAL.has(code);
  const alert = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (failure) focusIfLost(alert.current);
  }, [failure]);

  const send = async (body: DispenseCreate) => {
    dispense.reset();
    try {
      onDispensed(await dispense.mutateAsync(body));
    } catch (error) {
      // Said from the mutation state; a refusal of stock reads the batches again.
      if (isApiError(error) && STOCK.has(error.serverCode ?? '')) void options.refetch();
    }
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h2 id={headingId} data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('dispense.heading', { item: line.itemName })}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t('dispense.dosage', { dose: line.dose, frequency: line.frequency })}{' '}
        {remaining === null
          ? t('dispense.noQuantity', { count: line.dispensedQuantity })
          : t('dispense.remaining', { count: remaining, given: line.dispensedQuantity })}
      </p>
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
      {options.isPending ? (
        <p className="text-sm text-muted-foreground">{t('dispense.loading')}</p>
      ) : options.isError ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(options.error))}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => void options.refetch()}>
              {t('retry')}
            </Button>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('close')}
            </Button>
          </div>
        </div>
      ) : final || items.length === 0 ? (
        <div className="flex flex-col gap-2">
          {!final && (
            <p className="text-sm">
              {t(
                options.data.prescribed || options.data.substitutes.length > 0
                  ? 'dispense.noStock'
                  : 'dispense.archivedNoSubstitute',
              )}
            </p>
          )}
          <div>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('close')}
            </Button>
          </div>
        </div>
      ) : (
        // Read again after a refusal of stock: the form starts over from the batches as they are.
        <DispenseForm
          key={options.dataUpdatedAt}
          line={line}
          locationId={locationId}
          items={items}
          allergies={allergies}
          pending={dispense.isPending}
          onSend={send}
          onClose={onClose}
        />
      )}
    </section>
  );
}

function DispenseForm({
  line,
  locationId,
  items,
  allergies,
  pending,
  onSend,
  onClose,
}: {
  line: PharmacyLine;
  locationId: string;
  items: DispensableItem[];
  allergies: AllergyCheck;
  pending: boolean;
  onSend: (body: DispenseCreate) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation('pharmacy');
  const remaining = remainingOf(line);
  const schema = useMemo(
    () => createDispenseFormSchema(items, line.drugId, remaining),
    [items, line.drugId, remaining],
  );
  // The prescribed medicine when it has stock here, else the first substitute.
  const first = items.find((item) => item.drugId === line.drugId) ?? items[0];
  const form = useZodForm<DispenseFormValues, DispenseFormValues>(schema, {
    drugId: first?.drugId ?? '',
    reason: '',
    batches: nearestExpiryFirst(first?.batches ?? [], remaining),
  });
  const [asking, setAsking] = useState<DispenseFormValues | null>(null);
  const confirmHeading = useRef<HTMLHeadingElement>(null);
  const buttons = useRef<HTMLDivElement>(null);
  const confirmId = useId();
  const drugId = form.watch('drugId');
  const item = items.find((each) => each.drugId === drugId);
  const warnings = item
    ? allergies.substances.filter((substance) => matchesAllergy(substance, [item.name]))
    : [];
  const needsAsking = warnings.length > 0 || allergies.notice !== undefined;

  const send = (values: DispenseFormValues) => {
    const chosen = items.find((each) => each.drugId === values.drugId);
    if (!chosen) return Promise.resolve();
    const substitute = values.drugId !== line.drugId;
    return onSend({
      orderId: line.orderId,
      expectedVersion: line.version,
      expectedDispensedQuantity: line.dispensedQuantity,
      locationId,
      ...(substitute ? { drugId: values.drugId, substitutionReason: values.reason.trim() } : {}),
      batches: chosen.batches.flatMap((batch, index) => {
        const units = Number(values.batches[index] || 0);
        return units > 0 ? [{ batchId: batch.batchId, quantity: units }] : [];
      }),
    });
  };

  // The fields are locked while the question is asked, so what is sent is what was asked about.
  const submit = (values: DispenseFormValues) => (needsAsking ? setAsking(values) : send(values));
  const answered = (go: boolean) => {
    const values = asking;
    setAsking(null);
    if (go && values) void send(values);
  };
  useLayoutEffect(() => {
    if (asking) confirmHeading.current?.focus();
    // The question went away: focus goes back to Dispense, never to the page.
    else focusIfLost(buttons.current?.querySelector<HTMLElement>('button[type="submit"]'));
  }, [asking]);

  return (
    <Form form={form} onSubmit={submit}>
      <fieldset disabled={asking !== null} className="flex flex-col gap-3">
        <DispenseFields items={items} prescribedDrugId={line.drugId} remaining={remaining} />
        {item && warnings.length > 0 && (
          <p className="flex items-start gap-2 text-sm font-medium text-destructive">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('dispense.allergyWarning', { item: item.name, allergies: warnings.join(', ') })}
          </p>
        )}
        {allergies.notice && (
          <p className="flex items-start gap-2 text-sm">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t(allergies.notice)}
          </p>
        )}
      </fieldset>
      {asking ? (
        <section aria-labelledby={confirmId} className="flex flex-col gap-2 rounded-md border p-3">
          <h3
            id={confirmId}
            ref={confirmHeading}
            tabIndex={-1}
            className="font-semibold outline-none"
          >
            {t(warnings.length > 0 ? 'dispense.confirm.warned' : 'dispense.confirm.unchecked')}
          </h3>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => answered(true)}>
              {t('dispense.confirm.anyway')}
            </Button>
            <Button type="button" variant="outline" onClick={() => answered(false)}>
              {t('dispense.confirm.review')}
            </Button>
          </div>
        </section>
      ) : (
        <div ref={buttons} className="flex flex-wrap gap-2">
          <SubmitButton pending={pending}>
            {pending ? t('dispense.submitting') : t('dispense.submit')}
          </SubmitButton>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      )}
    </Form>
  );
}

/** The fields, inside the form so the batches follow the item chosen. */
function DispenseFields({
  items,
  prescribedDrugId,
  remaining,
}: {
  items: DispensableItem[];
  prescribedDrugId: string;
  remaining: number | null;
}) {
  const { t } = useTranslation('pharmacy');
  const format = useFormatters();
  const set = useSetFieldValue();
  const drugId = String(useFieldValue('drugId') ?? '');
  const item = items.find((each) => each.drugId === drugId);
  const substitute = drugId !== prescribedDrugId;

  // Another item has its own batches: they start again nearest expiry first.
  const shown = useRef(drugId);
  useEffect(() => {
    if (shown.current === drugId) return;
    shown.current = drugId;
    set('batches', nearestExpiryFirst(item?.batches ?? [], remaining));
    if (!substitute) set('reason', '');
  }, [drugId, item, remaining, set, substitute]);

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <SelectField
        name="drugId"
        label={t('dispense.item')}
        required
        options={items.map((each) => ({
          value: each.drugId,
          label: t(
            each.drugId === prescribedDrugId
              ? 'dispense.prescribedOption'
              : 'dispense.substituteOption',
            { name: each.name, count: each.batches.reduce((sum, batch) => sum + batch.onHand, 0) },
          ),
        }))}
      />
      {substitute && (
        <TextField
          name="reason"
          label={t('dispense.reason')}
          hint={t('dispense.reasonHint')}
          required
          maxLength={REASON_MAX}
          autoComplete="off"
        />
      )}
      {item?.batches.map((batch, index) => (
        <TextField
          key={batch.batchId}
          name={`batches.${index}`}
          label={t('dispense.batch', {
            number: batch.batchNumber,
            expiry: format.calendarDate(batch.expiryDate),
          })}
          hint={t('dispense.batchHint', { count: batch.onHand })}
          inputMode="numeric"
          autoComplete="off"
        />
      ))}
    </div>
  );
}
