import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, TextField, useZodForm } from '@/shared/ui/form';
import { dayBoundsUtc } from '@/shared/utils/timezone';
import { useTenant } from '@/tenancy';
import { useRequestLeave } from '../hooks/use-roster';
import { leaveFormSchema, type LeaveFormValues } from '../schemas';
import type { RosterLeave } from '../types';

const REFUSED: Record<string, string> = {
  leave_overlap: 'leave.errors.overlap',
  invalid_period: 'leave.errors.period',
};

/**
 * Asks for leave for the signed-in person, in whole days on the hospital's clock (#591). A second
 * person decides on it; nothing about why is asked or kept.
 */
export function LeaveDialog({
  day,
  onClose,
  onRequested,
}: {
  day: string;
  onClose: () => void;
  onRequested: (made: RosterLeave) => void;
}) {
  const { t } = useTranslation('roster');
  const { t: tCommon } = useTranslation();
  const timezone = useTenant()?.timezone ?? 'UTC';
  const request = useRequestLeave();
  const form = useZodForm(leaveFormSchema, { firstDay: day, lastDay: day });
  const code = isApiError(request.error) ? request.error.serverCode : undefined;
  const failure = !request.error
    ? undefined
    : code !== undefined && REFUSED[code]
      ? t(REFUSED[code])
      : tCommon(errorMessageKey(request.error));

  const submit = async (values: LeaveFormValues) => {
    try {
      onRequested(
        await request.mutateAsync({
          startsAt: dayBoundsUtc(values.firstDay, timezone).start,
          endsAt: dayBoundsUtc(values.lastDay, timezone).end,
        }),
      );
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('leave.new.title')}
      description={t('leave.new.description')}
      closeLabel={t('close')}
      busy={request.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="roster-leave-form" aria-busy={request.isPending}>
            {request.isPending ? t('leave.new.saving') : t('leave.new.save')}
          </Button>
        </>
      }
    >
      <Form form={form} id="roster-leave-form" onSubmit={submit}>
        <TextField<LeaveFormValues>
          name="firstDay"
          type="date"
          label={t('leave.new.first')}
          required
        />
        <TextField<LeaveFormValues>
          name="lastDay"
          type="date"
          label={t('leave.new.last')}
          hint={t('leave.new.lastHint')}
          required
        />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </Form>
    </Dialog>
  );
}
