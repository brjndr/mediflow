import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Form, SelectField, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useSendInvite } from '../hooks/use-staff';
import { EMAIL_MAX, inviteFormSchema, NAME_MAX, type InviteFormValues } from '../schemas';
import type { StaffRole } from '../types';

const EMPTY: InviteFormValues = { name: '', email: '', roleId: '' };

/** Invites one person by email into a role. */
export function InviteForm({ roles }: { roles: StaffRole[] }) {
  const { t } = useTranslation('staff');
  const { t: tCommon } = useTranslation();
  const invite = useSendInvite();
  const form = useZodForm(inviteFormSchema, EMPTY);
  const [sentTo, setSentTo] = useState<string | null>(null);
  // A key identifies one request body: an identical resubmit (double click, retry) reuses it and
  // sends one email, while an edited form gets a new key.
  const attempt = useRef<{ body: string; key: string }>(undefined);

  const submit = async (values: InviteFormValues) => {
    setSentTo(null);
    // Addresses are kept in lower case, as the bulk invite sends them.
    const body = { ...values, email: values.email.toLowerCase() };
    const serialized = JSON.stringify(body);
    if (attempt.current?.body !== serialized) {
      attempt.current = { body: serialized, key: crypto.randomUUID() };
    }
    try {
      const sent = await invite.mutateAsync({ body, idempotencyKey: attempt.current.key });
      attempt.current = undefined;
      setSentTo(sent.email);
      // Ready for the next person, in the same role.
      form.reset({ ...EMPTY, roleId: values.roleId });
    } catch {
      // Shown from the mutation state below.
    }
  };

  const refused =
    isApiError(invite.error) && invite.error.serverCode === 'unknown_role'
      ? t('errors.unknownRole')
      : isApiError(invite.error) && invite.error.serverCode === 'rate_limited'
        ? t('errors.busy')
        : null;

  return (
    <section aria-labelledby="staff-invite-one" className="flex flex-col gap-3">
      <h2 id="staff-invite-one" className="text-lg font-semibold">
        {t('inviteOne.heading')}
      </h2>
      {invite.isError && (
        <p role="alert" className="text-sm text-destructive">
          {refused ?? tCommon(errorMessageKey(invite.error))}
        </p>
      )}
      <Form form={form} onSubmit={submit} className="flex max-w-xl flex-col gap-4">
        <TextField
          name="name"
          label={t('inviteOne.name')}
          required
          maxLength={NAME_MAX}
          autoComplete="off"
        />
        <TextField
          name="email"
          type="email"
          inputMode="email"
          label={t('inviteOne.email')}
          hint={t('inviteOne.emailHint')}
          required
          maxLength={EMAIL_MAX}
          autoComplete="off"
        />
        <SelectField
          name="roleId"
          label={t('inviteOne.role')}
          required
          options={roles.map((role) => ({ value: role.id, label: role.name }))}
          placeholder={t('inviteOne.chooseRole')}
        />
        <SubmitButton pending={invite.isPending} className="self-start">
          {t('inviteOne.submit')}
        </SubmitButton>
      </Form>
      <p role="status" className="text-sm text-muted-foreground">
        {sentTo ? t('inviteOne.sent', { email: sentTo }) : ''}
      </p>
    </section>
  );
}
