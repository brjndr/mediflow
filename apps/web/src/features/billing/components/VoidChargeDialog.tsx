import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { CheckboxField, Form, SelectField, useZodForm } from '@/shared/ui/form';
import { useVoidCharge } from '../hooks/use-billing';
import {
  VOID_REASONS,
  voidChargeSchema,
  type VoidChargeInput,
  type VoidChargeValues,
} from '../schemas';
import type { Charge } from '../types';

const FORM = 'void-charge-form';
const EMPTY: VoidChargeInput = { reason: '', confirmCovered: false };
const REFUSED = new Set(['charge_not_pending', 'charge_on_draft', 'charge_billed']);

/**
 * Asks why a pending charge is voided (#1240), from a fixed list. A package that covers other
 * charges is voided only after a second, explicit tick: the API says so (409 `covers_charges`)
 * and the covered charges stay void. For `charge:void`.
 */
export function VoidChargeDialog({
  charge,
  onClose,
  onVoided,
}: {
  charge: Charge | null;
  onClose: () => void;
  /** Called with the charge's description once it is void. */
  onVoided: (description: string) => void;
}) {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const voiding = useVoidCharge();
  const form = useZodForm<VoidChargeInput, VoidChargeValues>(voidChargeSchema, EMPTY);
  // The server said the package covers other charges: stays until the dialog closes.
  const [covers, setCovers] = useState(false);
  const open = charge !== null;
  useEffect(() => {
    if (!open) {
      form.reset(EMPTY);
      voiding.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Not while sending: the answer belongs to this charge's dialog.
  const close = () => {
    if (voiding.isPending) return;
    setCovers(false);
    onClose();
  };

  async function submit(values: VoidChargeValues) {
    if (!charge || voiding.isPending) return;
    if (covers && !values.confirmCovered) {
      form.setError(
        'confirmCovered',
        { message: 'billing:charges.void.confirmNeeded' },
        { shouldFocus: true },
      );
      return;
    }
    try {
      await voiding.mutateAsync({
        chargeId: charge.id,
        reason: values.reason,
        ...(covers ? { confirmCovered: true } : {}),
      });
      onVoided(charge.description);
      setCovers(false);
      onClose();
    } catch (error) {
      if (isApiError(error) && error.serverCode === 'covers_charges') setCovers(true);
    }
  }
  const code = isApiError(voiding.error) ? voiding.error.serverCode : undefined;
  const failure =
    voiding.error && code !== 'covers_charges'
      ? code && REFUSED.has(code)
        ? t(`charges.void.refused.${code}`)
        : tCommon(errorMessageKey(voiding.error))
      : '';

  return (
    <ConfirmDialog
      open={open}
      onClose={close}
      title={t('charges.void.title')}
      description={t('charges.void.description', { name: charge?.description ?? '' })}
      cancelLabel={t('charges.void.cancel')}
      confirmLabel={t('charges.void.confirm')}
      confirmForm={FORM}
      destructive
      pending={voiding.isPending}
    >
      <Form form={form} id={FORM} onSubmit={submit} className="gap-3">
        <SelectField<VoidChargeInput>
          name="reason"
          label={t('charges.void.reason')}
          required
          placeholder={t('charges.void.choose')}
          options={VOID_REASONS.map((value) => ({
            value,
            label: t(`charges.void.reasons.${value}`),
          }))}
        />
        {/* Always on the page, so the warning is announced when it arrives. */}
        <p role="alert" className="text-sm font-medium text-destructive empty:hidden">
          {covers ? t('charges.void.covers') : ''}
        </p>
        {covers && (
          <CheckboxField<VoidChargeInput>
            name="confirmCovered"
            label={t('charges.void.confirmCovered')}
          />
        )}
      </Form>
      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
    </ConfirmDialog>
  );
}
