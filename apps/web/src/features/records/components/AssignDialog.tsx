import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { useDoctorOptions } from '@/features/doctors';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, SelectField, useZodForm } from '@/shared/ui/form';
import { useAssignRecord } from '../hooks/use-records';
import type { IncompleteRecord } from '../types';

const assignFormSchema = z.object({ doctorId: z.string() });
type AssignFormValues = z.infer<typeof assignFormSchema>;

/** Asks a doctor to finish an incomplete record, or takes the assignment off (#571). */
export function AssignDialog({
  record,
  onClose,
  onAssigned,
}: {
  record: IncompleteRecord;
  onClose: () => void;
  onAssigned: (updated: IncompleteRecord) => void;
}) {
  const { t } = useTranslation('records');
  const { t: tCommon } = useTranslation();
  const doctors = useDoctorOptions();
  const assign = useAssignRecord(record.encounterId);
  const form = useZodForm(assignFormSchema, { doctorId: record.assignedDoctorId ?? '' });
  const failure = assign.error
    ? isApiError(assign.error) && assign.error.serverCode === 'doctor_invalid'
      ? t('assign.failed')
      : tCommon(errorMessageKey(assign.error))
    : undefined;

  const submit = async (values: AssignFormValues) => {
    try {
      onAssigned(await assign.mutateAsync({ doctorId: values.doctorId || null }));
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('assign.title', { name: record.patientName })}
      description={t('assign.description')}
      closeLabel={t('close')}
      busy={assign.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="record-assign-form" aria-busy={assign.isPending}>
            {assign.isPending ? t('assign.submitting') : t('assign.submit')}
          </Button>
        </>
      }
    >
      <Form form={form} id="record-assign-form" onSubmit={submit}>
        {doctors.available ? (
          <SelectField<AssignFormValues>
            name="doctorId"
            label={t('assign.doctor')}
            options={[
              { value: '', label: t('assign.nobody') },
              ...(doctors.data ?? []).map((each) => ({ value: each.id, label: each.name })),
            ]}
          />
        ) : (
          <p className="text-sm text-muted-foreground">{t('assign.noDoctors')}</p>
        )}
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </Form>
    </Dialog>
  );
}
