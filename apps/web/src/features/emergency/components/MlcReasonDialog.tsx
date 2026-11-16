import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, SelectField, useZodForm } from '@/shared/ui/form';
import { MLC_ACCESS_REASONS, mlcReasonFormSchema, type MlcReasonFormValues } from '../schemas';
import type { MlcAccessReason } from '../types';

/**
 * Asked before a medico-legal record is opened, its history read or a print made: one reason from a
 * fixed list, never free text. The server stores it in the audit log with the view or print.
 */
export function MlcReasonDialog({
  onChosen,
  onClose,
}: {
  onChosen: (reason: MlcAccessReason) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('emergency');
  const form = useZodForm(mlcReasonFormSchema, { reason: '' as MlcAccessReason });
  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('mlc.reasonTitle')}
      description={t('mlc.reasonDescription')}
      closeLabel={t('close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="emergency-mlc-reason-form">
            {t('mlc.reasonConfirm')}
          </Button>
        </>
      }
    >
      <Form
        form={form}
        id="emergency-mlc-reason-form"
        onSubmit={(values: MlcReasonFormValues) => onChosen(values.reason)}
      >
        <SelectField<MlcReasonFormValues>
          name="reason"
          label={t('mlc.reasonLabel')}
          required
          placeholder={t('mlc.reasonPlaceholder')}
          options={MLC_ACCESS_REASONS.map((value) => ({
            value,
            label: t(`mlc.reasons.${value}`),
          }))}
        />
      </Form>
    </Dialog>
  );
}
