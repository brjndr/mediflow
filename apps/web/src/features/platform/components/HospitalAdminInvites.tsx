import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { useFormatters } from '@/tenancy/use-formatters';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useAdminInvites, useInviteAdmin, useRevokeInvite } from '../hooks/use-hospitals';
import { adminInviteSchema } from '../schemas';
import type { HospitalInvite } from '../types';

const EMPTY = { name: '', email: '' };

/**
 * Invites the hospital's first admin, and lists the invites still open so one can be sent again
 * or withdrawn. Sending again is inviting the same address again: the API withdraws the earlier
 * invite and emails a new link. The invitee sets a password through the link (A-03).
 */
export function HospitalAdminInvites({ hospitalId }: { hospitalId: string }) {
  const { t } = useTranslation();
  const format = useFormatters();
  const invites = useAdminInvites(hospitalId);
  const invite = useInviteAdmin(hospitalId);
  const revoke = useRevokeInvite(hospitalId);
  const form = useZodForm(adminInviteSchema, EMPTY);
  const statusLine = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState('');

  const say = (text: string) => {
    setMessage(text);
    // A row that leaves the list takes the keyboard's place with it.
    queueMicrotask(() => focusIfLost(statusLine.current));
  };

  const send = async (values: { name: string; email: string }) => {
    setMessage('');
    try {
      const sent = await invite.mutateAsync({ ...values, email: values.email.toLowerCase() });
      form.reset(EMPTY);
      say(t('platform.invite.sent', { email: sent.email }));
    } catch {
      // Shown from the mutation state below.
    }
  };

  const resend = (row: HospitalInvite) => {
    setMessage('');
    invite.mutate(
      { name: row.name, email: row.email },
      { onSuccess: () => say(t('platform.invite.sent', { email: row.email })) },
    );
  };

  const withdraw = (row: HospitalInvite) => {
    setMessage('');
    revoke.mutate(row.id, {
      onSuccess: () => say(t('platform.invite.revoked', { email: row.email })),
    });
  };

  const columns = useMemo<GridColumn<HospitalInvite>[]>(
    () => [
      { id: 'email', header: t('platform.invite.columns.email'), value: (row) => row.email },
      { id: 'name', header: t('platform.invite.columns.name'), value: (row) => row.name },
      {
        id: 'expires',
        header: t('platform.invite.columns.expires'),
        value: (row) =>
          new Date(row.expiresAt).getTime() < Date.now()
            ? t('platform.invite.expired', { when: format.dateTime(row.expiresAt) })
            : format.dateTime(row.expiresAt),
      },
    ],
    // `format` is rebuilt on each render; its inputs do not change while the page is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );

  const code = isApiError(invite.error) ? invite.error.serverCode : undefined;
  const refused =
    code === 'hospital_has_admin'
      ? t('platform.invite.hasAdmin')
      : code === 'hospital_not_active'
        ? t('platform.invite.notActive')
        : code === 'validation_failed'
          ? t('platform.invite.notAllowed')
          : null;

  return (
    <section aria-labelledby="hospital-invite" className="flex flex-col gap-3">
      <h2 id="hospital-invite" className="text-lg font-semibold">
        {t('platform.invite.heading')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('platform.invite.hint')}</p>

      <Form form={form} onSubmit={send} className="flex max-w-md flex-col gap-4">
        <TextField
          name="name"
          label={t('platform.invite.name')}
          required
          maxLength={200}
          autoComplete="off"
        />
        <TextField
          name="email"
          type="email"
          inputMode="email"
          label={t('platform.invite.email')}
          required
          maxLength={254}
          autoComplete="off"
        />
        {invite.isError && (
          <p role="alert" className="text-sm text-destructive">
            {refused ?? t(errorMessageKey(invite.error))}
          </p>
        )}
        <div>
          <SubmitButton pending={invite.isPending}>{t('platform.invite.submit')}</SubmitButton>
        </div>
      </Form>

      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {message}
      </p>
      {revoke.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t(errorMessageKey(revoke.error))}
        </p>
      )}

      <h3 className="text-base font-medium">{t('platform.invite.openHeading')}</h3>
      <DataGrid
        label={t('platform.invite.gridLabel')}
        columns={columns}
        rows={invites.data?.items ?? []}
        rowId={(row) => row.id}
        rowLabel={(row) => row.email}
        status={invites.isPending ? 'loading' : invites.isError ? 'error' : 'ready'}
        errorMessage={invites.isError ? t(errorMessageKey(invites.error)) : undefined}
        onRetry={() => void invites.refetch()}
        emptyMessage={t('platform.invite.empty')}
        actions={[
          {
            id: 'resend',
            label: t('platform.invite.resend'),
            onSelect: resend,
            disabled: () => invite.isPending,
          },
          {
            id: 'revoke',
            label: t('platform.invite.revoke'),
            onSelect: withdraw,
            disabled: () => revoke.isPending,
          },
        ]}
      />
    </section>
  );
}
