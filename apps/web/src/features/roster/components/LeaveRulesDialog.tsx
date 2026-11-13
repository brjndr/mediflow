import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, SelectField, TextField, useZodForm } from '@/shared/ui/form';
import { useLeaveSettings, useSaveLeaveSettings } from '../hooks/use-roster';
import { LEAVE_KINDS, leaveRulesFormSchema, type LeaveRulesFormValues } from '../schemas';
import type { LeaveSettings } from '../types';

/**
 * The hospital's leave rules (#667): the days a year for each kind (blank is no limit) and whether
 * the only person who can approve leave may approve their own. Leave already asked is not looked at
 * again.
 */
export function LeaveRulesDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation('roster');
  const { t: tCommon } = useTranslation();
  const current = useLeaveSettings();
  const save = useSaveLeaveSettings();
  const days = (kind: string) => {
    const one = current.data?.allowances.find((entry) => entry.kind === kind);
    return one ? String(one.days) : '';
  };
  const form = useZodForm(leaveRulesFormSchema, {
    selfApproval: current.data?.selfApproval ?? 'never',
    annual: days('annual'),
    sick: days('sick'),
    casual: days('casual'),
    unpaid: days('unpaid'),
  });

  const submit = async (values: LeaveRulesFormValues) => {
    const body: LeaveSettings = {
      selfApproval: values.selfApproval,
      allowances: LEAVE_KINDS.flatMap((kind) =>
        values[kind] === '' ? [] : [{ kind, days: Number(values[kind]) }],
      ),
    };
    try {
      await save.mutateAsync(body);
      onSaved();
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('leave.rules.title')}
      description={t('leave.rules.description')}
      closeLabel={t('close')}
      busy={save.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="roster-leave-rules-form" aria-busy={save.isPending}>
            {save.isPending ? t('leave.rules.saving') : t('leave.rules.save')}
          </Button>
        </>
      }
    >
      {current.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('leave.rules.loading')}
        </p>
      ) : (
        <Form form={form} id="roster-leave-rules-form" onSubmit={submit}>
          {LEAVE_KINDS.map((kind) => (
            <TextField<LeaveRulesFormValues>
              key={kind}
              name={kind}
              inputMode="numeric"
              label={t('leave.rules.days', { kind: t(`leave.kind.${kind}`) })}
              hint={t('leave.rules.daysHint')}
            />
          ))}
          <SelectField<LeaveRulesFormValues>
            name="selfApproval"
            label={t('leave.rules.selfApproval')}
            hint={t('leave.rules.selfApprovalHint')}
            required
            options={[
              { value: 'never', label: t('leave.rules.never') },
              { value: 'sole_manager', label: t('leave.rules.soleManager') },
            ]}
          />
          {save.error && (
            <p role="alert" className="text-sm text-destructive">
              {tCommon(errorMessageKey(save.error))}
            </p>
          )}
        </Form>
      )}
    </Dialog>
  );
}
