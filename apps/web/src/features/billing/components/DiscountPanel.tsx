import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { currencyDigits, toMinor } from '@/features/services';
import { focusIfLost } from '@/shared/lib/focus';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { Form, SelectField, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useFormatters, useTenant } from '@/tenancy';
import { bpToPercent, percentToBp } from '../lib/tax';
import {
  createDiscountSchema,
  DISCOUNT_REASONS,
  type DiscountInput,
  type DiscountValues,
} from '../schemas';
import type { Discount } from '../types';

/** The key of the discount on the whole bill, beside the keys of the lines. */
export const BILL = 'bill';

export interface DiscountTarget {
  key: string;
  label: string;
}

interface Row {
  key: string;
  label: string;
  discount: Discount;
}

const EMPTY: DiscountInput = { target: BILL, kind: 'percent', value: '', reason: 'goodwill' };

/**
 * Discounts on a draft (#116): on one line or on the whole bill, a percentage or an amount, with
 * a reason. Giving one needs `discount:apply` (`canApply`); without it the discounts a draft
 * already has are listed and nothing can be changed. A discount on a line that is already
 * discounted replaces it. The builder keeps the discounts and sends them with the draft; the
 * server works every amount out and decides whether the result needs approval.
 */
export function DiscountPanel({
  targets,
  discounts,
  bill,
  canApply,
  onApply,
  onRemove,
}: {
  targets: DiscountTarget[];
  discounts: Record<string, Discount>;
  bill: Discount | undefined;
  canApply: boolean;
  onApply: (target: string, discount: Discount) => void;
  onRemove: (target: string) => void;
}) {
  const { t } = useTranslation('billing');
  const format = useFormatters();
  const digits = currencyDigits(useTenant()?.currency);
  const schema = useMemo(
    () => createDiscountSchema(percentToBp, (text) => toMinor(text, digits)),
    [digits],
  );
  const form = useZodForm<DiscountInput, DiscountValues>(schema, EMPTY);
  const status = useRef<HTMLParagraphElement>(null);
  const [said, setSaid] = useState('');

  const rows = useMemo<Row[]>(
    () => [
      ...(bill ? [{ key: BILL, label: t('discount.wholeBill'), discount: bill }] : []),
      ...targets.flatMap((target) => {
        const discount = discounts[target.key];
        return discount ? [{ key: target.key, label: target.label, discount }] : [];
      }),
    ],
    [bill, targets, discounts, t],
  );

  // A removed row takes the focused button with it: focus moves to the status line.
  useLayoutEffect(() => {
    focusIfLost(status.current);
  }, [rows.length]);

  const columns = useMemo<GridColumn<Row>[]>(
    () => [
      { id: 'target', header: t('discount.columns.target'), value: (row) => row.label },
      {
        id: 'discount',
        header: t('discount.columns.discount'),
        value: (row) =>
          row.discount.kind === 'percent'
            ? t('discount.percentOf', { percent: bpToPercent(row.discount.value) })
            : format.money(row.discount.value),
        align: 'end',
      },
      {
        id: 'reason',
        header: t('discount.columns.reason'),
        value: (row) => t(`discount.reason.${row.discount.reason}`),
      },
    ],
    [t, format],
  );
  const actions = useMemo<GridAction<Row>[]>(
    () =>
      canApply
        ? [
            {
              id: 'remove',
              label: t('discount.remove'),
              onSelect: (row) => {
                onRemove(row.key);
                setSaid(t('discount.removed'));
              },
            },
          ]
        : [],
    [canApply, t, onRemove],
  );

  return (
    <section aria-labelledby="discount-heading" className="flex flex-col gap-3">
      <h2 id="discount-heading" className="text-lg font-semibold">
        {t('discount.heading')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('discount.hint')}</p>
      {rows.length > 0 && (
        <DataGrid
          label={t('discount.heading')}
          columns={columns}
          rows={rows}
          rowId={(row) => row.key}
          rowLabel={(row) => row.label}
          actions={actions}
          status="ready"
          emptyMessage={t('discount.none')}
        />
      )}
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 empty:hidden"
      >
        {said}
      </p>
      {canApply && (
        <Form
          form={form}
          onSubmit={(values: DiscountValues) => {
            const value =
              values.kind === 'percent' ? percentToBp(values.value) : toMinor(values.value, digits);
            if (value === null) return;
            onApply(values.target, { kind: values.kind, value, reason: values.reason });
            setSaid(t('discount.added'));
            form.reset({ ...EMPTY, target: values.target, reason: values.reason });
            form.setFocus('value');
          }}
        >
          <SelectField<DiscountInput>
            name="target"
            label={t('discount.target')}
            options={[
              { value: BILL, label: t('discount.wholeBill') },
              ...targets.map((target) => ({ value: target.key, label: target.label })),
            ]}
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SelectField<DiscountInput>
              name="kind"
              label={t('discount.kind')}
              options={[
                { value: 'percent', label: t('discount.kindPercent') },
                { value: 'amount', label: t('discount.kindAmount') },
              ]}
            />
            <TextField<DiscountInput>
              name="value"
              label={t('discount.value')}
              hint={t('discount.valueHint')}
              required
              inputMode="decimal"
              autoComplete="off"
            />
          </div>
          <SelectField<DiscountInput>
            name="reason"
            label={t('discount.reasonLabel')}
            options={DISCOUNT_REASONS.map((value) => ({
              value,
              label: t(`discount.reason.${value}`),
            }))}
          />
          <div>
            <SubmitButton variant="outline">{t('discount.add')}</SubmitButton>
          </div>
        </Form>
      )}
    </section>
  );
}
