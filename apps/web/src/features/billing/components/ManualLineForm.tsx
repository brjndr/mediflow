import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { currencyDigits, toMinor } from '@/features/services';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useTenant } from '@/tenancy';
import {
  createManualLineSchema,
  DESCRIPTION_MAX,
  type ManualLineInput,
  type ManualLineValues,
} from '../schemas';
import type { ManualLine } from '../types';

const EMPTY: ManualLineInput = { description: '', quantity: '1', unitPrice: '' };

/**
 * A line the billing desk types in: what it is, how many and the price of one, in the hospital's
 * currency. The price is turned into minor units on its digits (`toMinor`), never through a
 * float, and "12,50" is refused. The line is handed to the builder, not saved here.
 */
export function ManualLineForm({ onAdd }: { onAdd: (line: ManualLine) => void }) {
  const { t } = useTranslation('billing');
  const digits = currencyDigits(useTenant()?.currency);
  const schema = useMemo(() => createManualLineSchema((text) => toMinor(text, digits)), [digits]);
  const form = useZodForm<ManualLineInput, ManualLineValues>(schema, EMPTY);

  return (
    <Form
      form={form}
      onSubmit={(values: ManualLineValues) => {
        onAdd({
          description: values.description,
          quantity: Number(values.quantity),
          unitPriceMinor: toMinor(values.unitPrice, digits) ?? 0,
        });
        form.reset(EMPTY);
        form.setFocus('description');
      }}
    >
      <TextField<ManualLineInput>
        name="description"
        label={t('line.description')}
        hint={t('line.descriptionHint')}
        required
        maxLength={DESCRIPTION_MAX}
        autoComplete="off"
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField<ManualLineInput>
          name="quantity"
          label={t('line.quantity')}
          required
          inputMode="numeric"
          autoComplete="off"
        />
        <TextField<ManualLineInput>
          name="unitPrice"
          label={t('line.unitPrice')}
          hint={t('line.unitPriceHint')}
          required
          inputMode="decimal"
          autoComplete="off"
        />
      </div>
      <div>
        <SubmitButton variant="outline">{t('line.add')}</SubmitButton>
      </div>
    </Form>
  );
}
