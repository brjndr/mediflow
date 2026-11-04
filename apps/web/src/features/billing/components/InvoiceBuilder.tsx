import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import {
  useCreateDraft,
  useIssueInvoice,
  usePendingCharges,
  useTaxRates,
  useUpdateDraft,
} from '../hooks/use-billing';
import { lineTaxMinor } from '../lib/tax';
import { CHARGES_MAX, MANUAL_LINES_MAX } from '../schemas';
import type { Charge, Invoice, InvoiceContent, ManualLine } from '../types';
import { AddChargePanel } from './AddChargePanel';
import { ManualLineForm } from './ManualLineForm';

/** A typed line while it is being built: the API's, with an id for the row. */
type KeyedLine = ManualLine & { key: string };

/** Refusals the desk can act on, by the server's code. Anything else is the common message. */
const REFUSED: Record<string, string> = {
  charge_unavailable: 'builder.refused.chargeUnavailable',
  invoice_not_draft: 'builder.refused.notDraft',
  version_conflict: 'builder.refused.conflict',
  conflict: 'builder.refused.conflict',
  empty_invoice: 'builder.refused.empty',
  encounter_cancelled: 'builder.refused.cancelled',
};

/**
 * What a visit's bill is made of (#109): the pending charges of the visit, each put on the bill
 * or left off it, and lines the desk types in. The total is worked out on minor units, in the
 * hospital's currency. "Save draft" keeps it for later; "Issue invoice" (for `invoice:issue`)
 * saves it and gives it its number, after which it can no longer be changed. A draft already
 * saved is given as `invoice`; without one the first save makes it.
 */
export function InvoiceBuilder({
  encounterId,
  invoice,
  notice = '',
}: {
  encounterId: string;
  invoice?: Invoice;
  /** Already translated: what was done on the page this one replaced (a draft just saved). */
  notice?: string;
}) {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const navigate = useNavigate();
  const canIssue = usePermission('invoice:issue');
  // Typed lines skip the price list: a permission of their own.
  const canAdjust = usePermission('invoice:adjust');
  // The rates only estimate the tax before saving; the server works it out.
  const canSeeRates = usePermission('invoice:read');
  const rates = useTaxRates({ enabled: canSeeRates });
  const charges = usePendingCharges(encounterId);
  const create = useCreateDraft(encounterId);
  const update = useUpdateDraft(invoice?.id ?? '');
  const issue = useIssueInvoice();
  const status = useRef<HTMLParagraphElement>(null);
  const [said, setSaid] = useState(notice);

  // The charges this bill may hold: those no other draft holds.
  const available = useMemo(
    () =>
      (charges.data?.pages.flatMap((page) => page.items) ?? []).filter(
        (charge) => !charge.invoiceId || charge.invoiceId === invoice?.id,
      ),
    [charges.data, invoice?.id],
  );
  // Until someone chooses, a new bill holds every pending charge and a draft what it held.
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const held = useMemo(
    () => new Set(invoice?.lines.flatMap((line) => (line.chargeId ? [line.chargeId] : [])) ?? []),
    [invoice],
  );
  const included = useMemo(
    () => picked ?? (invoice ? held : new Set(available.map((charge) => charge.id))),
    [picked, invoice, held, available],
  );
  // Each typed line has an id of its own, so a row keeps its place when another is removed.
  const [manual, setManual] = useState<KeyedLine[]>(() =>
    (invoice?.lines ?? [])
      .filter((line) => !line.chargeId)
      .map(({ id, description, quantity, unitPriceMinor, taxClass }) => ({
        key: id,
        description,
        quantity,
        unitPriceMinor,
        ...(taxClass ? { taxClass } : {}),
      })),
  );
  // A bill is read whole before it is totalled: the rest of a long list is fetched at once.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = charges;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  // The draft this screen made on its first save, when issuing it then failed.
  const made = useRef<Invoice>(undefined);

  const includedCharges = available.filter((charge) => included.has(charge.id));
  const subtotalMinor =
    includedCharges.reduce((sum, charge) => sum + charge.totalMinor, 0) +
    manual.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor, 0);
  // The tax as the server will work it out, line by line, at the rates now in force.
  const rateBp = (taxClass: string | undefined) =>
    rates.data?.items.find((item) => item.taxClass === taxClass)?.rateBp ?? 0;
  const taxMinor =
    includedCharges.reduce(
      (sum, charge) =>
        sum + lineTaxMinor(charge.quantity, charge.unitPriceMinor, rateBp(charge.taxClass)),
      0,
    ) +
    manual.reduce(
      (sum, line) => sum + lineTaxMinor(line.quantity, line.unitPriceMinor, rateBp(line.taxClass)),
      0,
    );
  const totalMinor = subtotalMinor + taxMinor;
  const lineCount = includedCharges.length + manual.length;
  const content: InvoiceContent = {
    chargeIds: includedCharges.map((c) => c.id),
    manualLines: manual.map(({ description, quantity, unitPriceMinor, taxClass }) => ({
      description,
      quantity,
      unitPriceMinor,
      ...(taxClass ? { taxClass } : {}),
    })),
  };

  const busy = create.isPending || update.isPending || issue.isPending;
  const failed = create.error ?? update.error ?? issue.error;
  const code = isApiError(failed) ? failed.serverCode : undefined;
  const failure = failed
    ? code !== undefined && REFUSED[code]
      ? t(REFUSED[code])
      : tCommon(errorMessageKey(failed))
    : '';

  // A line removed takes the focused button with it: focus moves to the status line.
  useLayoutEffect(() => {
    focusIfLost(status.current);
  }, [manual.length]);

  const toggle = useCallback(
    (charge: Charge, on: boolean) => {
      const next = new Set(included);
      if (on) next.add(charge.id);
      else next.delete(charge.id);
      setPicked(next);
      setSaid('');
    },
    [included],
  );

  const save = async (andIssue: boolean) => {
    if (busy) return;
    if (lineCount === 0) {
      setSaid(t('builder.refused.empty'));
      return;
    }
    create.reset();
    update.reset();
    issue.reset();
    setSaid('');
    // Whether this press made the draft: if issuing it then fails, the draft is not made twice.
    let created = false;
    try {
      const current = invoice ?? made.current;
      const saved = current
        ? await update.mutateAsync({ content, version: current.version })
        : await create.mutateAsync(content);
      created = current === undefined;
      if (!invoice) made.current = saved;
      if (andIssue) {
        // The invoice page says it was issued, with its number.
        await issue.mutateAsync({ invoiceId: saved.id, version: saved.version });
      } else {
        setSaid(t('builder.saved'));
      }
      // A first save is a page of its own, which says what happened (fixed words, no record).
      if (!invoice) {
        void navigate(`/billing/invoices/${saved.id}`, {
          replace: true,
          state: { saved: !andIssue },
        });
      }
    } catch {
      // Said from the mutation state. A draft made by this press has a page of its own now.
      if (created && made.current) {
        void navigate(`/billing/invoices/${made.current.id}`, {
          replace: true,
          state: { saved: true },
        });
      }
    }
  };

  const chargeColumns = useMemo<GridColumn<Charge>[]>(
    () => [
      {
        id: 'description',
        header: t('charges.columns.description'),
        value: (row) => row.description,
      },
      {
        id: 'source',
        header: t('charges.columns.source'),
        value: (row) => t(`charges.source.${row.source}`),
      },
      {
        id: 'quantity',
        header: t('charges.columns.quantity'),
        value: (row) => row.quantity,
        align: 'end',
      },
      {
        id: 'unitPrice',
        header: t('charges.columns.unitPrice'),
        value: (row) => format.money(row.unitPriceMinor),
        align: 'end',
      },
      {
        id: 'amount',
        header: t('charges.columns.amount'),
        value: (row) => format.money(row.totalMinor),
        align: 'end',
      },
      {
        id: 'note',
        header: t('charges.columns.note'),
        value: (row) => (row.flag ? t(`charges.flag.${row.flag}`) : t('charges.noFlag')),
      },
      {
        id: 'onBill',
        header: t('charges.columns.onBill'),
        value: (row) => (included.has(row.id) ? t('charges.yes') : t('charges.no')),
      },
    ],
    [t, format, included],
  );
  const chargeActions = useMemo<GridAction<Charge>[]>(
    () => [
      {
        id: 'add',
        label: t('charges.add'),
        onSelect: (row) => toggle(row, true),
        disabled: (row) => included.has(row.id),
      },
      {
        id: 'leave',
        label: t('charges.leave'),
        onSelect: (row) => toggle(row, false),
        disabled: (row) => !included.has(row.id),
      },
    ],
    [t, included, toggle],
  );

  const manualColumns = useMemo<GridColumn<KeyedLine>[]>(
    () => [
      {
        id: 'description',
        header: t('charges.columns.description'),
        value: (row) => row.description,
      },
      {
        id: 'quantity',
        header: t('charges.columns.quantity'),
        value: (row) => row.quantity,
        align: 'end',
      },
      {
        id: 'unitPrice',
        header: t('charges.columns.unitPrice'),
        value: (row) => format.money(row.unitPriceMinor),
        align: 'end',
      },
      {
        id: 'amount',
        header: t('charges.columns.amount'),
        value: (row) => format.money(row.quantity * row.unitPriceMinor),
        align: 'end',
      },
      {
        id: 'tax',
        header: t('line.taxClass'),
        value: (row) => t(`tax.class.${row.taxClass ?? 'none'}`),
      },
    ],
    [t, format],
  );
  const manualActions = useMemo<GridAction<KeyedLine>[]>(
    () => [
      {
        id: 'remove',
        label: t('line.remove'),
        onSelect: (row) => {
          setManual((lines) => lines.filter((line) => line.key !== row.key));
          setSaid('');
        },
      },
    ],
    [t],
  );

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="pending-heading" className="flex flex-col gap-3">
        <h2 id="pending-heading" className="text-lg font-semibold">
          {t('charges.heading')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('charges.description')}</p>
        <DataGrid
          label={t('charges.heading')}
          columns={chargeColumns}
          rows={available}
          rowId={(row) => row.id}
          rowLabel={(row) => row.description}
          actions={chargeActions}
          status={charges.isPending ? 'loading' : charges.isError ? 'error' : 'ready'}
          errorMessage={charges.isError ? tCommon(errorMessageKey(charges.error)) : undefined}
          onRetry={() => void charges.refetch()}
          emptyMessage={t('charges.empty')}
          hasNextPage={charges.hasNextPage}
          loadingMore={charges.isFetchingNextPage}
          onLoadMore={() => void charges.fetchNextPage()}
        />
        {available.length >= CHARGES_MAX && (
          <p className="text-sm text-muted-foreground">
            {t('charges.tooMany', { count: CHARGES_MAX })}
          </p>
        )}
      </section>

      <AddChargePanel
        encounterId={encounterId}
        onAdded={(chargeId) => {
          // The new charge goes on this bill; what was chosen before stays as it was.
          setPicked(new Set([...included, chargeId]));
          setSaid('');
        }}
      />

      {(canAdjust || manual.length > 0) && (
        <section aria-labelledby="manual-heading" className="flex flex-col gap-3">
          <h2 id="manual-heading" className="text-lg font-semibold">
            {t('line.heading')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('line.description_hint')}</p>
          {manual.length > 0 && (
            <DataGrid
              label={t('line.heading')}
              columns={manualColumns}
              rows={manual}
              rowId={(row) => row.key}
              rowLabel={(row) => row.description}
              actions={manualActions}
              status="ready"
              emptyMessage={t('line.none')}
            />
          )}
          {!canAdjust ? null : manual.length < MANUAL_LINES_MAX ? (
            <ManualLineForm
              onAdd={(line) => {
                setManual((lines) => [...lines, { ...line, key: crypto.randomUUID() }]);
                setSaid('');
              }}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('line.tooMany', { count: MANUAL_LINES_MAX })}
            </p>
          )}
        </section>
      )}

      <section aria-labelledby="total-heading" className="flex flex-col gap-3 border-t pt-4">
        <h2 id="total-heading" className="text-lg font-semibold">
          {t('builder.totalHeading')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('builder.lineCount', { count: lineCount })}
        </p>
        {taxMinor > 0 && (
          <dl className="grid max-w-xs grid-cols-2 gap-x-4 text-sm">
            <dt className="text-muted-foreground">{t('tax.beforeTax')}</dt>
            <dd className="text-right" data-testid="invoice-subtotal">
              {format.money(subtotalMinor)}
            </dd>
            <dt className="text-muted-foreground">{t('tax.tax')}</dt>
            <dd className="text-right" data-testid="invoice-tax">
              {format.money(taxMinor)}
            </dd>
          </dl>
        )}
        <p className="text-2xl font-semibold" data-testid="invoice-total">
          <span className="sr-only">{t('builder.total')}: </span>
          {format.money(totalMinor)}
        </p>
        <p
          ref={status}
          tabIndex={-1}
          role="status"
          className="text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 empty:hidden"
        >
          {said}
        </p>
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            aria-disabled={busy || undefined}
            onClick={() => void save(false)}
          >
            {create.isPending || update.isPending ? t('builder.saving') : t('builder.saveDraft')}
          </Button>
          {canIssue && (
            <Button type="button" aria-disabled={busy || undefined} onClick={() => void save(true)}>
              {issue.isPending ? t('builder.issuing') : t('builder.issue')}
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}
