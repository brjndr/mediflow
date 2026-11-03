import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { currencyDigits, toMinor } from '@/features/services';
import { cn } from '@/shared/lib/utils';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { Form, SubmitButton, TextAreaField, TextField, useZodForm } from '@/shared/ui/form';
import { useFormatters, useTenant } from '@/tenancy';
import { useCreditNotes, useIssueCreditNote } from '../hooks/use-billing';
import { amountText, refusalText, useFocusWhenFormGoes } from '../lib/panel-helpers';
import {
  createCreditNoteSchema,
  REASON_MAX,
  type CreditNoteInput,
  type CreditNoteValues,
} from '../schemas';
import type { CreditNote, Invoice } from '../types';

/** Refusals of the API that have words of their own; any other failure gets the generic ones. */
const REFUSALS = new Set(['credit_exceeds', 'refund_first', 'invoice_not_creditable']);

/**
 * The credit notes of an issued invoice (#112): the way to correct one that is issued, since it
 * is never edited. The notes are listed for `invoice:read`; for `creditNote:create` a form issues
 * one with a reason. Money already paid has to be refunded first, so the form offers only what
 * is still unpaid; a credit of the whole invoice makes it void.
 */
export function CreditNotePanel({ invoice }: { invoice: Invoice }) {
  const { t } = useTranslation('billing');
  const canCreate = usePermission('creditNote:create');
  const format = useFormatters();
  const notes = useCreditNotes(invoice.id);
  const issue = useIssueCreditNote(invoice.id);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const leftMinor = invoice.totalMinor - invoice.creditedMinor;
  const unpaidMinor = leftMinor - invoice.paidMinor;
  const open = invoice.status === 'issued' || invoice.status === 'paid';
  const creditable = canCreate && open && unpaidMinor > 0;
  const refundFirst = canCreate && open && leftMinor > 0 && unpaidMinor <= 0;

  useFocusWhenFormGoes(creditable, message !== null, status);

  const columns = useMemo<GridColumn<CreditNote>[]>(
    () => [
      { id: 'number', header: t('credit.columns.number'), value: (row) => row.number },
      {
        id: 'at',
        header: t('credit.columns.at'),
        value: (row) => format.dateTime(row.createdAt),
      },
      { id: 'reason', header: t('credit.columns.reason'), value: (row) => row.reason },
      { id: 'by', header: t('credit.columns.by'), value: (row) => row.createdByName },
      {
        id: 'amount',
        header: t('credit.columns.amount'),
        value: (row) => format.money(row.amountMinor),
        align: 'end',
      },
    ],
    [t, format],
  );

  return (
    <section aria-labelledby="credit-heading" className="flex flex-col gap-3">
      <h2 id="credit-heading" className="text-lg font-semibold">
        {t('credit.heading')}
      </h2>
      {invoice.status === 'void' && (
        <p className="text-sm font-medium" data-testid="void-notice">
          {t('credit.void', { credited: format.money(invoice.creditedMinor) })}
        </p>
      )}
      {refundFirst && <p className="text-sm text-muted-foreground">{t('credit.refundFirst')}</p>}
      {/* Always on the page, so an issued or refused credit note is announced. */}
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className={cn(
          'text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 empty:hidden',
          message?.failed && 'text-destructive',
        )}
      >
        {message?.text}
      </p>
      {creditable && (
        <CreditForm
          // A new balance is a new form: its limit and first amount follow what is unpaid.
          key={unpaidMinor}
          issue={issue}
          leftMinor={unpaidMinor}
          whole={unpaidMinor === leftMinor}
          onIssued={(number) => setMessage({ text: t('credit.issued', { number }), failed: false })}
          onRefused={(text) => setMessage({ text, failed: true })}
        />
      )}
      <DataGrid
        label={t('credit.heading')}
        columns={columns}
        rows={notes.data ?? []}
        rowId={(row) => row.id}
        rowLabel={(row) => row.number}
        status={notes.isPending ? 'loading' : notes.isError ? 'error' : 'ready'}
        emptyMessage={t('credit.none')}
        onRetry={() => void notes.refetch()}
      />
    </section>
  );
}

function CreditForm({
  issue,
  leftMinor,
  whole,
  onIssued,
  onRefused,
}: {
  issue: ReturnType<typeof useIssueCreditNote>;
  leftMinor: number;
  whole: boolean;
  onIssued: (number: string) => void;
  onRefused: (text: string) => void;
}) {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const digits = currencyDigits(useTenant()?.currency);
  const schema = useMemo(
    () => createCreditNoteSchema((text) => toMinor(text, digits), leftMinor),
    [digits, leftMinor],
  );
  const form = useZodForm<CreditNoteInput, CreditNoteValues>(schema, {
    amount: amountText(leftMinor, digits),
    reason: '',
  });

  async function submit(values: CreditNoteValues) {
    try {
      const note = await issue.mutateAsync({
        amountMinor: toMinor(values.amount, digits) ?? 0,
        reason: values.reason,
      });
      onIssued(note.number);
    } catch (error) {
      onRefused(refusalText(error, REFUSALS, 'credit', t, tCommon));
    }
  }

  return (
    <Form form={form} onSubmit={submit}>
      <TextField<CreditNoteInput>
        name="amount"
        label={t('credit.amount')}
        hint={t(whole ? 'credit.amountHintWhole' : 'credit.amountHint', {
          left: format.money(leftMinor),
        })}
        required
        inputMode="decimal"
        autoComplete="off"
      />
      <TextAreaField<CreditNoteInput>
        name="reason"
        label={t('credit.reason')}
        hint={t('credit.reasonHint')}
        required
        maxLength={REASON_MAX}
      />
      <div>
        <SubmitButton pending={issue.isPending}>
          {issue.isPending ? t('credit.saving') : t('credit.submit')}
        </SubmitButton>
      </div>
    </Form>
  );
}
