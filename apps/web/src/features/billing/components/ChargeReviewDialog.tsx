import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Form, TextAreaField, useZodForm } from '@/shared/ui/form';
import { useResolveChargeReview } from '../hooks/use-billing';
import {
  chargeReviewSchema,
  REASON_MAX,
  type ChargeReviewInput,
  type ChargeReviewValues,
} from '../schemas';
import type { Charge } from '../types';

const FORM = 'charge-review-form';

/**
 * Asks the billing desk to confirm that a flagged charge (brought back, or left on another
 * visit) has been dealt with, and why (#910). The flag then stops holding the bill back. The
 * reason goes to the audit log. For `invoice:issue`.
 */
export function ChargeReviewDialog({
  charge,
  onClose,
  onResolved,
}: {
  charge: Charge | null;
  onClose: () => void;
  /** Called with the charge's description once the flag is off. */
  onResolved: (description: string) => void;
}) {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const resolve = useResolveChargeReview();
  const form = useZodForm<ChargeReviewInput, ChargeReviewValues>(chargeReviewSchema, {
    reason: '',
  });
  const open = charge !== null;
  useEffect(() => {
    if (!open) {
      form.reset({ reason: '' });
      resolve.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit(values: ChargeReviewValues) {
    if (!charge) return;
    try {
      await resolve.mutateAsync({ chargeId: charge.id, reason: values.reason });
      onResolved(charge.description);
      onClose();
    } catch {
      // Said in the dialog.
    }
  }
  const code = isApiError(resolve.error) ? resolve.error.serverCode : undefined;
  const failure = resolve.error
    ? code === 'not_flagged'
      ? t('charges.review.notFlagged')
      : tCommon(errorMessageKey(resolve.error))
    : '';

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={t('charges.review.title')}
      description={t('charges.review.description', { name: charge?.description ?? '' })}
      cancelLabel={t('charges.review.cancel')}
      confirmLabel={t('charges.review.confirm')}
      confirmForm={FORM}
      pending={resolve.isPending}
    >
      <Form form={form} id={FORM} onSubmit={submit} className="gap-3">
        <TextAreaField<ChargeReviewInput>
          name="reason"
          label={t('charges.review.reason')}
          hint={t('charges.review.reasonHint')}
          required
          maxLength={REASON_MAX}
          data-autofocus
        />
      </Form>
      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
    </ConfirmDialog>
  );
}
