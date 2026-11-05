import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useUpdateHospitalLimits } from '../hooks/use-hospitals';
import { limitsSchema, type LimitsFormValues } from '../schemas';
import type { Hospital } from '../types';

const FIELDS = ['maxUsers', 'storageMb'] as const;

const toValues = (h: Hospital): LimitsFormValues => ({
  maxUsers: h.maxUsers === null ? '' : String(h.maxUsers),
  storageMb: h.storageMb === null ? '' : String(h.storageMb),
});

/**
 * The hospital's limits. The form works from the hospital as it was when it opened; if someone
 * else saves first, what was typed stays, the other fields take the saved value, and a field both
 * changed shows theirs.
 */
export function HospitalLimits({ hospital }: { hospital: Hospital }) {
  const { t } = useTranslation();
  const update = useUpdateHospitalLimits(hospital.id);
  const [from, setFrom] = useState(hospital);
  const form = useZodForm(limitsSchema, toValues(from));
  const { dirtyFields } = form.formState;
  const { reset } = form;
  const [expected, setExpected] = useState(from.version);
  const [conflict, setConflict] = useState<'none' | 'awaiting' | 'shown'>('none');
  const [done, setDone] = useState(false);

  useEffect(() => {
    reset(toValues(hospital), { keepDirtyValues: true });
  }, [reset, hospital]);

  if (conflict === 'awaiting' && hospital.version !== expected) {
    setExpected(hospital.version);
    setConflict('shown');
  }

  const theirs = FIELDS.filter(
    (f) => dirtyFields[f] === true && toValues(hospital)[f] !== toValues(from)[f],
  );

  const save = async (values: LimitsFormValues) => {
    setDone(false);
    const changed = FIELDS.filter((f) => dirtyFields[f] === true);
    // Nothing changed: there is nothing to send, and the button already says so.
    if (changed.length === 0) return;
    const body = Object.fromEntries(
      changed.map((f) => [f, values[f] === '' ? null : Number(values[f])]),
    );
    try {
      const saved = await update.mutateAsync({ ...body, version: expected });
      reset(toValues(saved));
      setFrom(saved);
      setExpected(saved.version);
      setConflict('none');
      setDone(true);
    } catch (error) {
      if (isApiError(error) && error.serverCode === 'version_conflict') setConflict('awaiting');
    }
  };

  const clashed = isApiError(update.error) && update.error.serverCode === 'version_conflict';
  return (
    <section aria-labelledby="hospital-limits" className="flex flex-col gap-3">
      <h2 id="hospital-limits" className="text-lg font-semibold">
        {t('platform.detail.limits')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('platform.detail.limitsHint')}</p>
      <p className="text-sm">{t('platform.detail.staffNow', { count: hospital.memberCount })}</p>
      <Form form={form} onSubmit={save} className="flex max-w-md flex-col gap-4">
        <TextField
          name="maxUsers"
          label={t('platform.create.maxUsers')}
          hint={t('platform.create.limitHint')}
          inputMode="numeric"
          autoComplete="off"
        />
        <TextField
          name="storageMb"
          label={t('platform.create.storageMb')}
          hint={t('platform.create.limitHint')}
          inputMode="numeric"
          autoComplete="off"
        />
        {(conflict !== 'none' || clashed) && (
          <div role="alert" className="text-sm text-destructive">
            <p>{t('platform.detail.conflict')}</p>
            {conflict === 'shown' && theirs.length > 0 && (
              <>
                <p className="mt-1 font-medium">{t('platform.detail.theySaved')}</p>
                <ul className="list-disc pl-5">
                  {theirs.map((f) => (
                    <li key={f}>
                      {t(`platform.create.${f}`)}:{' '}
                      {toValues(hospital)[f] || t('platform.create.noLimit')}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        {update.isError && !clashed && (
          <p role="alert" className="text-sm text-destructive">
            {t(errorMessageKey(update.error))}
          </p>
        )}
        <p role="status" className="text-sm text-muted-foreground">
          {done ? t('platform.detail.limitsSaved') : ''}
        </p>
        <div>
          <SubmitButton
            pending={update.isPending || conflict === 'awaiting'}
            disabled={Object.keys(dirtyFields).length === 0}
          >
            {t('platform.detail.saveLimits')}
          </SubmitButton>
        </div>
      </Form>
    </section>
  );
}
