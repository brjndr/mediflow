import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Form, SubmitButton, TextAreaField, TextField, useZodForm } from '@/shared/ui/form';
import { PageSkeleton } from '@/shared/ui/page-skeleton';
import { useHospitalProfile, useSaveHospitalProfile } from '../hooks/use-hospital-profile';
import {
  ADDRESS_MAX,
  PHONE_MAX,
  PROFILE_FIELDS,
  profileFormSchema,
  REGISTRATION_MAX,
  toFormValues,
  type ProfileField,
  type ProfileFormValues,
} from '../schemas';
import type { HospitalProfile } from '../types';

/**
 * The form, working from the profile as it was when the screen opened. What someone else saves
 * meanwhile goes into the fields this person has not touched; a field both changed keeps what
 * was typed and shows the saved value.
 */
function ProfileForm({ latest, canManage }: { latest: HospitalProfile; canManage: boolean }) {
  const { t } = useTranslation('hospital-profile');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const save = useSaveHospitalProfile();
  // The profile the person started from, and the version a save is made from.
  const [from, setFrom] = useState(latest);
  const [expected, setExpected] = useState(latest.version);
  const [done, setDone] = useState('');
  const form = useZodForm(profileFormSchema, toFormValues(latest));
  const { dirtyFields } = form.formState;
  const { reset } = form;

  useEffect(() => {
    reset(toFormValues(latest), { keepDirtyValues: true });
  }, [reset, latest]);

  const conflicted = isApiError(save.error) && save.error.serverCode === 'conflict';
  // After a conflict the newest version is the one to save from, the typed values stay.
  if (conflicted && latest.version !== expected) setExpected(latest.version);

  const shown = (profile: HospitalProfile, field: ProfileField) => profile[field] || t('notSet');
  const theirs = PROFILE_FIELDS.filter(
    (field) => dirtyFields[field] === true && shown(latest, field) !== shown(from, field),
  );

  const onSubmit = async (values: ProfileFormValues) => {
    setDone('');
    const changed = PROFILE_FIELDS.filter((field) => dirtyFields[field] === true);
    if (changed.length === 0) return;
    const body = Object.fromEntries(changed.map((field) => [field, values[field]]));
    try {
      const saved = await save.mutateAsync({ ...body, expectedVersion: expected });
      setFrom(saved);
      setExpected(saved.version);
      reset(toFormValues(saved));
      setDone(t('saved'));
    } catch {
      // Shown below; a conflict also refreshes the profile, which moves `expected`.
    }
  };

  const discard = () => {
    save.reset();
    setDone('');
    setFrom(latest);
    setExpected(latest.version);
    reset(toFormValues(latest));
  };

  const readOnly = !canManage;
  return (
    <Form form={form} onSubmit={onSubmit} className="flex max-w-xl flex-col gap-4">
      {conflicted && (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.conflict')}
        </p>
      )}
      {save.isError && !conflicted && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(save.error))}
        </p>
      )}
      <p role="status" className="text-sm text-muted-foreground">
        {done}
      </p>
      <fieldset disabled={readOnly} className="flex flex-col gap-4">
        <TextAreaField
          name="address"
          label={t('address')}
          hint={t('addressHint')}
          maxLength={ADDRESS_MAX}
          rows={4}
          autoComplete="off"
        />
        <TextField
          name="phone"
          label={t('phone')}
          type="tel"
          inputMode="tel"
          maxLength={PHONE_MAX}
          autoComplete="off"
        />
        <TextField
          name="registrationNumber"
          label={t('registrationNumber')}
          hint={t('registrationNumberHint')}
          maxLength={REGISTRATION_MAX}
          autoComplete="off"
        />
        <TextField
          name="gstin"
          label={t('gstin')}
          hint={t('gstinHint')}
          maxLength={15}
          autoCapitalize="characters"
          autoComplete="off"
        />
      </fieldset>
      {theirs.length > 0 && (
        <div role="status" className="rounded-md border p-3 text-sm">
          <p className="font-medium">{t('theySaved')}</p>
          <ul className="mt-1 list-disc pl-5">
            {theirs.map((field) => (
              <li key={field} className="whitespace-pre-line">
                {t(field)}: {shown(latest, field)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {readOnly ? (
        <p className="text-sm text-muted-foreground">{t('readOnly')}</p>
      ) : (
        <div className="flex flex-wrap gap-3">
          <SubmitButton pending={save.isPending}>{t('save')}</SubmitButton>
          <Button
            type="button"
            variant="outline"
            aria-disabled={save.isPending || undefined}
            onClick={discard}
          >
            {t('cancel')}
          </Button>
        </div>
      )}
    </Form>
  );
}

function HospitalProfileScreen() {
  const { t } = useTranslation('hospital-profile');
  const profile = useHospitalProfile();
  const canManage = usePermission('hospitalProfile:manage');

  let body;
  if (profile.isPending) {
    body = <PageSkeleton label={t('loading')} />;
  } else if (profile.data === undefined) {
    body = (
      <div role="alert" className="flex flex-col items-start gap-3 text-sm">
        <p className="text-destructive">{t('errors.loadFailed')}</p>
        <Button variant="outline" onClick={() => void profile.refetch()}>
          {t('tryAgain')}
        </Button>
      </div>
    );
  } else {
    body = <ProfileForm latest={profile.data} canManage={canManage} />;
  }
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">{t('heading')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      {body}
    </div>
  );
}

export default HospitalProfileScreen;
