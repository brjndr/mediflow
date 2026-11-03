import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { currencyDigits, toMinor } from '@/features/services';
import { Form, SubmitButton, TextAreaField, TextField, useZodForm } from '@/shared/ui/form';
import { useTenant } from '@/tenancy';
import { refusalText } from '../lib/panel-helpers';
import { CLOSE_REFUSALS } from '../lib/register';
import {
  createCloseRegisterSchema,
  NOTE_MAX,
  type CloseRegisterInput,
  type CloseRegisterValues,
} from '../schemas';
import type { useCloseRegister } from '../hooks/use-billing';
import type { RegisterSession } from '../types';

/**
 * Settles the caller's drawer: the cash counted and an optional handover note. The server works
 * out the difference against what it expected; this form never decides it.
 */
export function CloseRegisterForm({
  close,
  onClosed,
  onRefused,
}: {
  close: ReturnType<typeof useCloseRegister>;
  onClosed: (settled: RegisterSession) => void;
  onRefused: (text: string) => void;
}) {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const digits = currencyDigits(useTenant()?.currency);
  const schema = useMemo(
    () => createCloseRegisterSchema((text) => toMinor(text, digits)),
    [digits],
  );
  const form = useZodForm<CloseRegisterInput, CloseRegisterValues>(schema, {
    counted: '',
    note: '',
  });

  async function submit(values: CloseRegisterValues) {
    try {
      const settled = await close.mutateAsync({
        countedMinor: toMinor(values.counted, digits) ?? 0,
        ...(values.note ? { note: values.note } : {}),
      });
      onClosed(settled);
    } catch (error) {
      onRefused(refusalText(error, CLOSE_REFUSALS, 'register', t, tCommon));
    }
  }

  return (
    <Form form={form} onSubmit={submit}>
      <h2 className="text-lg font-semibold">{t('register.close.heading')}</h2>
      <TextField<CloseRegisterInput>
        name="counted"
        label={t('register.close.counted')}
        hint={t('register.close.countedHint')}
        required
        inputMode="decimal"
        autoComplete="off"
      />
      <TextAreaField<CloseRegisterInput>
        name="note"
        label={t('register.close.note')}
        hint={t('register.close.noteHint')}
        maxLength={NOTE_MAX}
      />
      <div>
        <SubmitButton pending={close.isPending}>
          {close.isPending ? t('register.close.saving') : t('register.close.submit')}
        </SubmitButton>
      </div>
    </Form>
  );
}
