import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Form, SelectField, useZodForm } from '@/shared/ui/form';
import { useDiscardDraft } from '../hooks/use-billing';
import {
  DISCARD_REASONS,
  discardDraftSchema,
  type DiscardDraftInput,
  type DiscardDraftValues,
} from '../schemas';
import type { Invoice } from '../types';

const FORM = 'discard-draft-form';
const REFUSED = new Set(['version_conflict', 'invoice_not_draft', 'split_issued', 'claim_depends']);

/**
 * "Discard draft" (#1240), for `invoice:discard`: asks why, from a fixed list. The draft stays as
 * a record, shown as discarded, and its charges go back to pending. A split pair goes together.
 * The dialog stays open on a refusal, also one that says the invoice is no longer a draft.
 */
export function DiscardDraftButton({
  invoice,
  open,
  onOpenChange,
}: {
  invoice: Invoice;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const discard = useDiscardDraft();
  const form = useZodForm<DiscardDraftInput, DiscardDraftValues>(discardDraftSchema, {
    reason: '',
  });

  function submit({ reason }: DiscardDraftValues) {
    if (discard.isPending) return;
    discard.mutate(
      { invoiceId: invoice.id, version: invoice.version, reason },
      { onSuccess: () => onOpenChange(false) },
    );
  }
  const code = isApiError(discard.error) ? discard.error.serverCode : undefined;
  const failure = discard.error
    ? code && REFUSED.has(code)
      ? t(`discard.refused.${code}`)
      : tCommon(errorMessageKey(discard.error))
    : '';

  return (
    <>
      {invoice.status === 'draft' && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            // No earlier answer or refusal is left.
            form.reset({ reason: '' });
            discard.reset();
            onOpenChange(true);
          }}
        >
          {t('discard.action')}
        </Button>
      )}
      <ConfirmDialog
        open={open}
        // Not while sending: the answer belongs to this dialog.
        onClose={() => {
          if (!discard.isPending) onOpenChange(false);
        }}
        title={t('discard.title')}
        description={t(invoice.splitGroup ? 'discard.splitDescription' : 'discard.description')}
        cancelLabel={t('discard.cancel')}
        confirmLabel={t('discard.confirm')}
        confirmForm={FORM}
        destructive
        pending={discard.isPending}
      >
        <Form form={form} id={FORM} onSubmit={submit} className="gap-3">
          <SelectField<DiscardDraftInput>
            name="reason"
            label={t('discard.reason')}
            required
            placeholder={t('discard.choose')}
            options={DISCARD_REASONS.map((value) => ({
              value,
              label: t(`discard.reasons.${value}`),
            }))}
          />
        </Form>
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}
