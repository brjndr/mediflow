import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, TextField, useZodForm } from '@/shared/ui/form';
import { useFormatters } from '@/tenancy';
import { useCopyWeek } from '../hooks/use-roster';
import { copyWeekFormSchema, MAX_COPY_WEEKS, type CopyWeekFormValues } from '../schemas';

const WEEK = 7 * 24 * 3_600_000;

/**
 * Copies the week on screen forward (#592), once or for several weeks in a row: the same people,
 * kinds and departments, seven days on. A shift whose person is already on duty then, or on
 * approved leave, is left out and listed; the rest are made. The weeks are a whole number of days
 * apart (the server checks), so a clock change in the hospital's zone moves the hour, not the day.
 */
export function CopyWeekDialog({
  weekStartUtc,
  departmentId,
  onClose,
}: {
  /** The first instant of the week shown, on the hospital's clock. */
  weekStartUtc: string;
  departmentId?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('roster');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const copy = useCopyWeek();
  const form = useZodForm(copyWeekFormSchema, { weeks: '1' });
  const code = isApiError(copy.error) ? copy.error.serverCode : undefined;
  const failure = !copy.error
    ? undefined
    : code === 'too_many_shifts'
      ? t('copy.errors.tooMany')
      : code === 'invalid_period'
        ? t('copy.errors.period')
        : tCommon(errorMessageKey(copy.error));
  const result = copy.data;

  const submit = async (values: CopyWeekFormValues) => {
    try {
      await copy.mutateAsync({
        fromStart: weekStartUtc,
        toStart: new Date(Date.parse(weekStartUtc) + WEEK).toISOString(),
        weeks: Number(values.weeks),
        ...(departmentId ? { departmentId } : {}),
      });
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('copy.title')}
      description={t('copy.description')}
      closeLabel={t('close')}
      busy={copy.isPending}
      footer={
        result ? (
          <Button onClick={onClose}>{t('close')}</Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              {t('close')}
            </Button>
            <Button type="submit" form="roster-copy-form" aria-busy={copy.isPending}>
              {copy.isPending ? t('copy.saving') : t('copy.save')}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3" role="status">
          <p className="text-sm">{t('copy.done', { count: result.copied })}</p>
          {result.skipped.length > 0 && (
            <div className="space-y-1">
              <p className="text-sm font-medium">
                {t('copy.skipped', { count: result.skipped.length })}
              </p>
              <ul className="flex flex-col gap-1 text-sm">
                {result.skipped.map((one, index) => (
                  <li key={`${one.shiftId}-${index}`}>
                    {t('copy.skippedRow', {
                      name: one.userName,
                      when: format.dateTime(one.startsAt),
                      reason: t(`copy.reason.${one.reason}`),
                    })}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <Form form={form} id="roster-copy-form" onSubmit={submit}>
          <TextField<CopyWeekFormValues>
            name="weeks"
            type="number"
            inputMode="numeric"
            label={t('copy.weeks')}
            hint={t('copy.weeksHint', { max: MAX_COPY_WEEKS })}
            required
          />
          {failure && (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          )}
        </Form>
      )}
    </Dialog>
  );
}
