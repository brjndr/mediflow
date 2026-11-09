import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { useStaffOptions } from '@/features/staff';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, SelectField, useZodForm } from '@/shared/ui/form';
import { useCreateTask, useRequestableBeds, useWardOptions } from '../hooks/use-tasks';
import { requestFormSchema, type RequestFormValues } from '../schemas';

/** Refusals this form has words for, as keys of the feature's strings. */
const REFUSALS: Record<string, string> = {
  bed_not_available: 'request.refused.notAvailable',
  task_exists: 'request.refused.exists',
  unknown_bed: 'request.refused.unknownBed',
  unknown_user: 'request.refused.unknownUser',
  feature_disabled: 'refused.wardsOff',
};

/**
 * Asks for a routine cleaning of a bed that is not in use, from a ward and its free beds, and
 * optionally names the person who will do it. The server decides in the end: a bed taken
 * meanwhile is refused.
 */
export function RequestCleaning({
  onClose,
  onRequested,
}: {
  onClose: () => void;
  onRequested: (bedNumber: string) => void;
}) {
  const { t } = useTranslation('housekeeping');
  const { t: tCommon } = useTranslation();
  const create = useCreateTask();
  const mayWards = usePermission('ward:read');
  const wards = useWardOptions(mayWards);
  const staff = useStaffOptions();
  const form = useZodForm(requestFormSchema, { wardId: '', bedId: '', assignedTo: '' });
  const wardId = form.watch('wardId');
  const beds = useRequestableBeds(wardId);

  const refusal =
    create.error && isApiError(create.error) ? REFUSALS[create.error.serverCode ?? ''] : undefined;
  const failure = !create.error
    ? undefined
    : refusal
      ? t(refusal)
      : tCommon(errorMessageKey(create.error));

  const submit = async (values: RequestFormValues) => {
    try {
      await create.mutateAsync({
        bedId: values.bedId,
        ...(values.assignedTo ? { assignedTo: values.assignedTo } : {}),
      });
      const number = beds.data?.find((bed) => bed.id === values.bedId)?.number ?? '';
      onRequested(number);
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('request.title')}
      description={t('request.description')}
      closeLabel={t('request.close')}
      busy={create.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('request.cancel')}
          </Button>
          <Button type="submit" form="request-cleaning-form" aria-busy={create.isPending}>
            {create.isPending ? t('request.saving') : t('request.save')}
          </Button>
        </>
      }
    >
      <Form form={form} id="request-cleaning-form" onSubmit={submit}>
        {!mayWards ? (
          <p className="text-sm text-muted-foreground">{t('request.noWards')}</p>
        ) : (
          <>
            <SelectField<RequestFormValues>
              name="wardId"
              label={t('request.ward')}
              required
              placeholder={t('request.chooseWard')}
              options={(wards.data ?? []).map((ward) => ({ value: ward.id, label: ward.name }))}
            />
            <SelectField<RequestFormValues>
              name="bedId"
              label={t('request.bed')}
              required
              placeholder={t('request.chooseBed')}
              hint={
                wardId && beds.isSuccess && beds.data.length === 0 ? t('request.noBeds') : undefined
              }
              options={(beds.data ?? []).map((bed) => ({
                value: bed.id,
                label: t('request.bedOption', { number: bed.number, room: bed.roomName }),
              }))}
            />
          </>
        )}
        {staff.available && (
          <SelectField<RequestFormValues>
            name="assignedTo"
            label={t('request.assignee')}
            placeholder={t('request.noAssignee')}
            options={(staff.data ?? []).map((person) => ({
              value: person.id,
              label: person.name,
            }))}
          />
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
