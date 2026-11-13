import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, SelectField, TextField, useZodForm } from '@/shared/ui/form';
import { useFormatters } from '@/tenancy';
import {
  AMOUNT_MAX,
  fluidCorrectSchema,
  INTAKE_KINDS,
  OUTPUT_KINDS,
  REASON_MAX,
  type FluidCorrectValues,
} from '../care-schemas';
import { useSaveFluid } from '../hooks/use-care';
import type { WardFluid } from '../types';

const REFUSED: Record<string, string> = {
  already_corrected: 'fluids.refused.alreadyCorrected',
  direction_changed: 'fluids.refused.directionChanged',
  admission_not_open: 'fluids.refused.notOpen',
};

/**
 * Corrects a fluid entry (#160). The entry stays; the correction is a new one that names it and
 * gives the reason, and it replaces the amount in the totals. It keeps intake or output.
 */
export function CorrectFluidDialog({
  entry,
  admissionId,
  onClose,
  onSaved,
}: {
  entry: WardFluid;
  admissionId: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { t } = useTranslation('nursing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const save = useSaveFluid(admissionId);
  const form = useZodForm(fluidCorrectSchema, {
    kind: entry.kind,
    amount: String(entry.amountMl),
    reason: '',
  });
  const FORM_ID = 'fluid-correct-form';
  const kinds = entry.direction === 'intake' ? INTAKE_KINDS : OUTPUT_KINDS;

  const failure = (): string | undefined => {
    if (!save.error) return undefined;
    if (isApiError(save.error) && save.error.serverCode) {
      const key = REFUSED[save.error.serverCode];
      if (key) return t(key);
    }
    return tCommon(errorMessageKey(save.error));
  };

  const submit = async (values: FluidCorrectValues) => {
    try {
      await save.mutateAsync({
        kind: 'correct',
        entry,
        body: { kind: values.kind, amountMl: Number(values.amount), reason: values.reason },
      });
      onSaved(t('fluids.done.corrected'));
    } catch {
      // Said below, from the mutation state.
    }
  };

  const message = failure();
  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('fluids.correctTitle')}
      description={t('fluids.correctLine', {
        kind: t(`fluids.kinds.${entry.kind}`),
        amount: entry.amountMl,
        time: format.dateTime(entry.observedAt),
      })}
      closeLabel={t('fluids.close')}
      busy={save.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('form.cancel')}
          </Button>
          <Button type="submit" form={FORM_ID} aria-disabled={save.isPending || undefined}>
            {t('fluids.saveCorrection')}
          </Button>
        </>
      }
    >
      <Form form={form} id={FORM_ID} onSubmit={(values) => void submit(values)}>
        <SelectField<FluidCorrectValues>
          name="kind"
          label={t('fluids.kind')}
          options={kinds.map((value) => ({ value, label: t(`fluids.kinds.${value}`) }))}
        />
        <TextField<FluidCorrectValues>
          name="amount"
          label={t('fluids.amount', { max: AMOUNT_MAX })}
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          required
        />
        <TextField<FluidCorrectValues>
          name="reason"
          label={t('fluids.reason')}
          maxLength={REASON_MAX}
          autoComplete="off"
          required
        />
        {message && (
          <p role="alert" className="text-sm text-destructive">
            {message}
          </p>
        )}
      </Form>
    </Dialog>
  );
}
