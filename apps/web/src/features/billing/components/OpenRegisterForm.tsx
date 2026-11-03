import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { currencyDigits, toMinor } from '@/features/services';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useTenant } from '@/tenancy';
import { refusalText } from '../lib/panel-helpers';
import { OPEN_REFUSALS } from '../lib/register';
import {
  createOpenRegisterSchema,
  type OpenRegisterInput,
  type OpenRegisterValues,
} from '../schemas';
import type { useOpenRegister } from '../hooks/use-billing';

/**
 * Opens the caller's drawer with the cash in it (`cashRegister:manage`). The opening cash may be
 * nothing. The sending lives above, in the screen, so its idempotency key outlives this form.
 */
export function OpenRegisterForm({
  open,
  onOpened,
  onRefused,
}: {
  open: ReturnType<typeof useOpenRegister>;
  onOpened: (openingMinor: number) => void;
  onRefused: (text: string) => void;
}) {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const digits = currencyDigits(useTenant()?.currency);
  const schema = useMemo(() => createOpenRegisterSchema((text) => toMinor(text, digits)), [digits]);
  const form = useZodForm<OpenRegisterInput, OpenRegisterValues>(schema, { opening: '0' });

  async function submit(values: OpenRegisterValues) {
    const openingMinor = toMinor(values.opening, digits) ?? 0;
    try {
      await open.mutateAsync({ openingMinor });
      onOpened(openingMinor);
    } catch (error) {
      onRefused(refusalText(error, OPEN_REFUSALS, 'register', t, tCommon));
    }
  }

  return (
    <Form form={form} onSubmit={submit}>
      <h2 className="text-lg font-semibold">{t('register.open.heading')}</h2>
      <TextField<OpenRegisterInput>
        name="opening"
        label={t('register.open.opening')}
        hint={t('register.open.openingHint')}
        required
        inputMode="decimal"
        autoComplete="off"
      />
      <div>
        <SubmitButton pending={open.isPending}>
          {open.isPending ? t('register.open.saving') : t('register.open.submit')}
        </SubmitButton>
      </div>
    </Form>
  );
}
