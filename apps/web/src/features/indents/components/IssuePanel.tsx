import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useFormatters } from '@/tenancy';
import { useIssueIndent } from '../hooks/use-indents';
import { useItemName } from '../hooks/use-item-name';
import { createIssueFormSchema, NOTE_MAX, type IssueFormValues } from '../schemas';
import type { StockIndent } from '../types';
import { INDENT_REFUSED } from './refusals';

/** A row of the form: units of one batch for one line. */
interface Row {
  lineId: string;
  name: string;
  batchId: string;
  batchNumber: string;
  expiryDate: string;
  onHand: number;
  /** Started with: the line's units still to issue, from the nearest expiry first. */
  start: number;
}

/**
 * Issuing an approved indent on a voucher (#105), for `indent:issue`, in a panel in place: a row
 * per batch the store may issue of each line still waiting, nearest expiry first, started with
 * what the line still has to issue taken from the nearest expiry first; a row left empty sends
 * nothing. The units leave the store and come in at the place that asked at once. Shown with
 * `data-panel-heading` for the panel's focus.
 */
export function IssuePanel({
  indent,
  onClose,
  onIssued,
}: {
  indent: StockIndent;
  onClose: () => void;
  onIssued: (indent: StockIndent) => void;
}) {
  const { t } = useTranslation('indents');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const nameOf = useItemName();
  const headingId = useId();
  // Taken when the panel opens, with the version it is sent at: the units typed stay with their
  // batch however the indent is read again, and an issue by someone else meanwhile is refused by
  // the server (409 conflict) rather than sent against rows that no longer hold.
  const [version] = useState(indent.version);
  const [{ rows, left, empty }] = useState(() => {
    const open = indent.lines.filter(
      (line) => (line.approvedQuantity ?? 0) - line.issuedQuantity > 0,
    );
    const taken: Row[] = [];
    const still: Record<string, number> = {};
    const without: string[] = [];
    for (const line of open) {
      let wanted = (line.approvedQuantity ?? 0) - line.issuedQuantity;
      still[line.id] = wanted;
      if ((line.batches ?? []).length === 0) without.push(nameOf(line.item));
      for (const batch of line.batches ?? []) {
        const start = Math.min(wanted, batch.onHand);
        wanted -= start;
        taken.push({
          lineId: line.id,
          name: nameOf(line.item),
          batchId: batch.batchId,
          batchNumber: batch.batchNumber,
          expiryDate: batch.expiryDate,
          onHand: batch.onHand,
          start,
        });
      }
    }
    return { rows: taken, left: still, empty: without };
  });
  const schema = useMemo(() => createIssueFormSchema(rows, left), [rows, left]);
  const form = useZodForm<IssueFormValues, IssueFormValues>(schema, {
    units: rows.map((row) => (row.start > 0 ? String(row.start) : '')),
    note: '',
  });
  const issue = useIssueIndent(indent.id);
  const code = isApiError(issue.error) ? issue.error.serverCode : undefined;
  const failure = issue.error
    ? code !== undefined && INDENT_REFUSED[code]
      ? t(INDENT_REFUSED[code])
      : tCommon(errorMessageKey(issue.error))
    : undefined;
  const alert = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (failure) focusIfLost(alert.current);
  }, [failure]);

  const submit = async (values: IssueFormValues) => {
    issue.reset();
    try {
      onIssued(
        await issue.mutateAsync({
          expectedVersion: version,
          ...(values.note === '' ? {} : { note: values.note }),
          lines: rows.flatMap((row, index) => {
            const units = Number(values.units[index] || 0);
            return units > 0
              ? [{ indentLineId: row.lineId, batchId: row.batchId, quantity: units }]
              : [];
          }),
        }),
      );
    } catch {
      // Said from the mutation state.
    }
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h2 id={headingId} data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('issue.heading', { reference: indent.reference })}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t('issue.description', { from: indent.toLocationName, to: indent.fromLocationName })}
      </p>
      {empty.length > 0 && (
        <p className="text-sm">{t('issue.noStock', { items: empty.join(', ') })}</p>
      )}
      {rows.length === 0 ? (
        <Button type="button" variant="outline" onClick={onClose} className="self-start">
          {t('closePanel')}
        </Button>
      ) : (
        <Form form={form} onSubmit={submit} className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {rows.map((row, index) => (
              <TextField
                key={`${row.lineId}:${row.batchId}`}
                name={`units.${index}`}
                label={t('issue.units', { name: row.name, number: row.batchNumber })}
                hint={t('issue.unitsHint', {
                  count: row.onHand,
                  expiry: format.calendarDate(row.expiryDate),
                  left: left[row.lineId] ?? 0,
                })}
                inputMode="numeric"
                autoComplete="off"
              />
            ))}
          </div>
          <TextField name="note" label={t('issue.note')} maxLength={NOTE_MAX} autoComplete="off" />
          {failure && (
            <p
              ref={alert}
              role="alert"
              tabIndex={-1}
              className="text-sm text-destructive outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {failure}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <SubmitButton pending={issue.isPending}>
              {issue.isPending ? t('issue.submitting') : t('issue.submit')}
            </SubmitButton>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('closePanel')}
            </Button>
          </div>
        </Form>
      )}
    </section>
  );
}
