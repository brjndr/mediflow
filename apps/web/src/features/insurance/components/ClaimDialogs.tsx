import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { currencyDigits } from '@/features/services';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, TextAreaField, TextField, useZodForm } from '@/shared/ui/form';
import { useFormatters, useTenant } from '@/tenancy';
import {
  ACTION_FIELDS,
  actionFormSchema,
  packetFormSchema,
  toClaimAction,
  toClaimCreate,
  type ActionFormValues,
  type PacketFormValues,
} from '../claims';
import { useActOnClaim, useCreateClaim } from '../hooks/use-claims';
import type { ClaimActionKind, ClaimDetail } from '../types';
import { refusalKey } from './refusal';

/**
 * The packet of a claim for a visit: what is enclosed, by name (the files are on the patient
 * record). The amount is the payer share from the visit split; the server takes it again.
 */
export function ClaimPacketDialog({
  encounterId,
  payerMinor,
  onClose,
  onCreated,
}: {
  encounterId: string;
  payerMinor: number;
  onClose: () => void;
  onCreated: (claim: ClaimDetail) => void;
}) {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const form = useZodForm(packetFormSchema, { documents: '', note: '' });
  const create = useCreateClaim(encounterId);
  const refused = refusalKey(create.error);

  const submit = async (values: PacketFormValues) => {
    try {
      onCreated(await create.mutateAsync(toClaimCreate(values)));
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('claims.packet.title')}
      description={t('claims.packet.description', { amount: format.money(payerMinor) })}
      closeLabel={t('close')}
      busy={create.isPending}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="claim-packet-form" aria-busy={create.isPending}>
            {create.isPending ? t('saving') : t('claims.packet.submit')}
          </Button>
        </>
      }
    >
      <Form form={form} id="claim-packet-form" onSubmit={submit} className="flex flex-col gap-4">
        <TextAreaField<PacketFormValues>
          name="documents"
          label={t('claims.packet.documents')}
          hint={t('claims.packet.documentsHint')}
          rows={4}
        />
        <TextAreaField<PacketFormValues>
          name="note"
          label={t('claims.packet.note')}
          rows={2}
          maxLength={500}
        />
        {create.error && (
          <p role="alert" className="text-sm text-destructive">
            {refused ? t(refused) : tCommon(errorMessageKey(create.error))}
          </p>
        )}
      </Form>
    </Dialog>
  );
}

const NOTE_LABEL: Partial<Record<ClaimActionKind, 'query' | 'reply' | 'reason'>> = {
  raise_query: 'query',
  reply: 'reply',
  reject: 'reason',
  write_off: 'reason',
};

/** One step of the claim state machine, with the fields that step asks for. */
export function ClaimActionDialog({
  claim,
  action,
  onClose,
  onDone,
}: {
  claim: ClaimDetail;
  action: ClaimActionKind;
  onClose: () => void;
  onDone: (claim: ClaimDetail) => void;
}) {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const digits = currencyDigits(useTenant()?.currency);
  const fields = ACTION_FIELDS[action];
  // Approval is up to what was claimed, a payment up to what was approved.
  const limitMinor = action === 'approve' ? claim.claimedMinor : claim.approvedMinor;
  const schema = useMemo(
    () => actionFormSchema(digits, action, limitMinor),
    [digits, action, limitMinor],
  );
  const form = useZodForm(schema, { note: '', amount: '', referenceNumber: '', documents: '' });
  const act = useActOnClaim(claim.id);
  const refused = refusalKey(act.error);
  const formId = 'claim-action-form';

  const submit = async (values: ActionFormValues) => {
    try {
      onDone(await act.mutateAsync(toClaimAction(action, values, digits, claim.version)));
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t(`claims.action.${action}`)}
      description={t(`claims.dialog.description.${action}`)}
      closeLabel={t('close')}
      busy={act.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form={formId} aria-busy={act.isPending}>
            {act.isPending ? t('saving') : t('claims.dialog.submit')}
          </Button>
        </>
      }
    >
      <Form form={form} id={formId} onSubmit={submit} className="flex flex-col gap-4">
        {action === 'write_off' && (
          <p className="text-sm font-medium">
            {t('claims.dialog.writeOffAmount', { amount: format.money(claim.outstandingMinor) })}
          </p>
        )}
        {fields.amount === 'approved' && (
          <TextField<ActionFormValues>
            name="amount"
            label={t('claims.dialog.approved')}
            hint={t('claims.dialog.approvedHint')}
            required
            inputMode="decimal"
            autoComplete="off"
          />
        )}
        {fields.amount === 'received' && (
          <TextField<ActionFormValues>
            name="amount"
            label={t('claims.dialog.received')}
            hint={t('claims.dialog.receivedHint')}
            required
            inputMode="decimal"
            autoComplete="off"
          />
        )}
        {fields.note !== 'none' && (
          <TextAreaField<ActionFormValues>
            name="note"
            label={t(`claims.dialog.note.${NOTE_LABEL[action] ?? 'other'}`)}
            required={fields.note === 'required'}
            rows={3}
            maxLength={500}
          />
        )}
        {fields.reference && (
          <TextField<ActionFormValues>
            name="referenceNumber"
            label={t('claims.dialog.reference')}
            maxLength={60}
            autoComplete="off"
          />
        )}
        {fields.documents && (
          <TextAreaField<ActionFormValues>
            name="documents"
            label={t('claims.dialog.documents')}
            hint={t('claims.dialog.documentsHint')}
            rows={3}
          />
        )}
        {act.error && (
          <p role="alert" className="text-sm text-destructive">
            {refused ? t(refused) : tCommon(errorMessageKey(act.error))}
          </p>
        )}
      </Form>
    </Dialog>
  );
}
