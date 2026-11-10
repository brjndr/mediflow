import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { CheckboxField, Form, SelectField, TextField, useZodForm } from '@/shared/ui/form';
import { useFormatters } from '@/tenancy';
import { useSaveMar } from '../hooks/use-mar';
import {
  blankMar,
  differsFromOrder,
  DOSE_MAX,
  MAR_REASON_MAX,
  marFormSchema,
  OUTCOMES,
  ROUTES,
  toCorrect,
  toCreate,
  type MarValues,
} from '../mar-schemas';
import type { MarEntry, MarOrder } from '../types';

export interface MarTarget {
  order: MarOrder;
  scheduledAt: string;
  /** Present when amending the entry that stands for the slot. */
  entry?: MarEntry;
}

const REFUSED: Record<string, string> = {
  admission_not_open: 'mar.refused.notOpen',
  slot_recorded: 'mar.refused.slotRecorded',
  order_cancelled: 'mar.refused.orderCancelled',
  slot_out_of_window: 'mar.refused.slotOutOfWindow',
  already_corrected: 'mar.refused.alreadyCorrected',
  reason_required: 'mar.refused.reason',
};

/**
 * Charts one dose, or amends an entry (#158). An entry is never edited: amending adds a new one
 * that names it. The dose checks are made here before sending: a dose that is not the ordered one,
 * or one given where the patient is allergic, needs a reason or a confirmation. The server makes
 * the check on the doses a day and the dialog then asks for the reason.
 */
export function MarDialog({
  target,
  admissionId,
  allergies,
  unchecked,
  onClose,
  onSaved,
}: {
  target: MarTarget;
  admissionId: string;
  /** The patient's recorded allergies that cover this medicine, as the patient has them listed. */
  allergies: string[];
  /** The allergies could not be read (no permission or an error): the nurse must say so. */
  unchecked: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { t } = useTranslation('nursing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const save = useSaveMar(admissionId);
  const { order, entry } = target;
  const [extraDose, setExtraDose] = useState(false);
  const allergyHit = allergies.length > 0;
  const schema = marFormSchema({
    orderDose: order.dose,
    amending: entry !== undefined,
    allergyHit: allergyHit || unchecked,
    extraDose,
  });
  const form = useZodForm(schema, blankMar(order, entry));
  const outcome = form.watch('outcome');
  const typedDose = form.watch('doseGiven');
  const doseDiffers = outcome === 'given' && differsFromOrder(typedDose, order.dose);

  const failure = (): string | undefined => {
    if (!save.error) return undefined;
    if (isApiError(save.error)) {
      const key = save.error.serverCode ? REFUSED[save.error.serverCode] : undefined;
      if (key) return t(key);
    }
    return tCommon(errorMessageKey(save.error));
  };

  const submit = async (values: MarValues) => {
    try {
      const saved = entry
        ? await save.mutateAsync({ kind: 'amend', entry, body: toCorrect(values) })
        : await save.mutateAsync({
            kind: 'record',
            body: toCreate(values, {
              admissionId,
              orderId: order.id,
              scheduledAt: target.scheduledAt,
            }),
          });
      const notDispensed = saved.warnings?.includes('not_dispensed') === true;
      onSaved(
        t(entry ? 'mar.done.amended' : 'mar.done.recorded') +
          (notDispensed ? ' ' + t('mar.done.notDispensed') : ''),
      );
    } catch (error) {
      if (isApiError(error) && error.serverCode === 'extra_dose_reason_required') {
        setExtraDose(true);
        save.reset();
        form.setError('reason', { message: 'nursing:mar.errors.extraDose' });
        form.setFocus('reason');
      }
      // Anything else is said below, from the mutation state.
    }
  };

  const message = failure();
  const FORM_ID = 'mar-entry-form';

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={entry ? t('mar.amendTitle') : t('mar.recordTitle')}
      description={t('mar.dialogLine', {
        medicine: order.itemName,
        time: format.dateTime(target.scheduledAt),
      })}
      closeLabel={t('mar.close')}
      busy={save.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('form.cancel')}
          </Button>
          <Button type="submit" form={FORM_ID} aria-disabled={save.isPending || undefined}>
            {entry ? t('mar.saveAmendment') : t('mar.save')}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        {t('mar.ordered', { dose: order.dose, route: order.route, frequency: order.frequency })}
      </p>
      {allergyHit && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm font-medium text-destructive"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t('mar.allergyWarning', { allergies: allergies.join(', ') })}
        </p>
      )}
      {unchecked && (
        <p role="alert" className="text-sm font-medium text-amber-900 dark:text-amber-200">
          {t('mar.allergiesUnchecked')}
        </p>
      )}
      {!order.dispensed && (
        <p className="text-sm text-amber-900 dark:text-amber-200">{t('mar.notDispensedWarning')}</p>
      )}
      <Form form={form} id={FORM_ID} onSubmit={submit}>
        <SelectField<MarValues>
          name="outcome"
          label={t('mar.outcome')}
          options={OUTCOMES.map((each) => ({ value: each, label: t(`mar.outcomes.${each}`) }))}
        />
        {outcome === 'given' && (
          <>
            <TextField<MarValues>
              name="doseGiven"
              label={t('mar.doseGiven')}
              maxLength={DOSE_MAX}
              autoComplete="off"
              required
            />
            {doseDiffers && (
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                {t('mar.doseDiffers', { dose: order.dose })}
              </p>
            )}
            <SelectField<MarValues>
              name="route"
              label={t('mar.route')}
              placeholder={t('mar.routeOrder')}
              options={ROUTES.map((each) => ({ value: each, label: each }))}
            />
          </>
        )}
        <TextField<MarValues>
          name="reason"
          label={t('mar.reason')}
          maxLength={MAR_REASON_MAX}
          autoComplete="off"
          required={outcome !== 'given' || entry !== undefined || doseDiffers || extraDose}
        />
        {(allergyHit || unchecked) && outcome === 'given' && (
          <CheckboxField<MarValues>
            name="allergyChecked"
            label={t(allergyHit ? 'mar.allergyChecked' : 'mar.allergyCheckedElsewhere')}
          />
        )}
        {message && (
          <p role="alert" className="text-sm text-destructive">
            {message}
          </p>
        )}
      </Form>
    </Dialog>
  );
}
