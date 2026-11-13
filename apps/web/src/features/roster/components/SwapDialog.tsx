import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, SelectField, useFieldValue, useZodForm } from '@/shared/ui/form';
import { useFormatters } from '@/tenancy';
import { useSwapShift } from '../hooks/use-roster';
import { swapFormSchema, type SwapFormValues } from '../schemas';
import type { RosterShift } from '../types';
import { PersonField } from './PersonField';

const REFUSED: Record<string, string> = {
  shift_overlap: 'swap.errors.overlap',
  on_leave: 'errors.onLeave',
  unknown_user: 'errors.user',
  invalid_swap: 'swap.errors.invalid',
  conflict: 'swap.errors.changed',
  invalid_transition: 'swap.errors.changed',
  shift_not_found: 'swap.errors.changed',
};

function Target({ others }: { others: RosterShift[] }) {
  const { t } = useTranslation('roster');
  const format = useFormatters();
  const mode = useFieldValue('mode') as SwapFormValues['mode'];
  return mode === 'hand_over' ? (
    <PersonField label={t('swap.to')} />
  ) : (
    <SelectField<SwapFormValues>
      name="withShiftId"
      label={t('swap.with')}
      hint={t('swap.withHint')}
      placeholder={t('swap.choose')}
      required
      options={others.map((one) => ({
        value: one.id,
        label: t('swap.option', {
          name: one.userName,
          kind: t(`kind.${one.shiftKind}`),
          when: format.dateTime(one.startsAt),
        }),
      }))}
    />
  );
}

/**
 * Hands a scheduled shift to someone else, or exchanges it with another person's shift (#592).
 * The old shift is cancelled and a new one scheduled for the new person, all or nothing; the
 * server refuses it when the new person is already on duty then or on approved leave.
 */
export function SwapDialog({
  shift,
  others,
  onClose,
  onDone,
}: {
  shift: RosterShift;
  /** Scheduled shifts of other people on screen, the ones it can be exchanged with. */
  others: RosterShift[];
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const { t } = useTranslation('roster');
  const { t: tCommon } = useTranslation();
  const swap = useSwapShift();
  const form = useZodForm(swapFormSchema, { mode: 'hand_over', userId: '', withShiftId: '' });
  const code = isApiError(swap.error) ? swap.error.serverCode : undefined;
  const failure = !swap.error
    ? undefined
    : code !== undefined && REFUSED[code]
      ? t(REFUSED[code])
      : tCommon(errorMessageKey(swap.error));

  const submit = async (values: SwapFormValues) => {
    const other = others.find((one) => one.id === values.withShiftId);
    try {
      await swap.mutateAsync({
        shiftId: shift.id,
        body:
          values.mode === 'hand_over'
            ? { version: shift.version, userId: values.userId }
            : {
                version: shift.version,
                withShiftId: values.withShiftId,
                withVersion: other?.version ?? 1,
              },
      });
      onDone(t('swap.done', { name: shift.userName }));
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('swap.title', { name: shift.userName })}
      description={t('swap.description')}
      closeLabel={t('close')}
      busy={swap.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
          <Button type="submit" form="roster-swap-form" aria-busy={swap.isPending}>
            {swap.isPending ? t('swap.saving') : t('swap.save')}
          </Button>
        </>
      }
    >
      <Form form={form} id="roster-swap-form" onSubmit={submit}>
        <SelectField<SwapFormValues>
          name="mode"
          label={t('swap.mode')}
          required
          options={[
            { value: 'hand_over', label: t('swap.handOver') },
            { value: 'exchange', label: t('swap.exchange') },
          ]}
        />
        <Target others={others} />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </Form>
    </Dialog>
  );
}
