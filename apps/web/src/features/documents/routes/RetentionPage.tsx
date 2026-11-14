import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Can } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { CheckboxField, Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useFormatters } from '@/tenancy';
import { HoldsSection } from '../components/HoldsSection';
import { useRetentionRules, useSetRetention } from '../hooks/use-retention';
import { RETENTION_MAX_YEARS, retentionFormSchema, type RetentionValues } from '../schemas';
import type { RetentionRuleStatus } from '../types';

/**
 * How long each category of document is kept (`/document-retention`, #561), for
 * `documentRetention:read`; `documentRetention:manage` changes a category. A rule applies to
 * documents attached from now on, never to one already kept.
 */
export default function RetentionPage() {
  const { t } = useTranslation('documents');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const rules = useRetentionRules();
  const box = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const [editing, setEditing] = useState<RetentionRuleStatus | null>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  usePanelFocus(editing ? `edit:${editing.category}` : null, box, status);
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);

  const columns = useMemo<GridColumn<RetentionRuleStatus>[]>(
    () => [
      {
        id: 'category',
        header: t('columns.category'),
        value: (row) => t(`category.${row.category}`),
        hideable: false,
        render: (_row, text) => <span className="font-medium">{text}</span>,
      },
      {
        id: 'years',
        header: t('retention.columns.kept'),
        value: (row) =>
          row.years === null
            ? t('keptForEver')
            : t('retention.years', { count: row.years, value: format.number(row.years) }),
      },
      {
        id: 'otherRule',
        header: t('retention.columns.otherRule'),
        value: (row) =>
          row.otherRuleCount === 0
            ? t('retention.otherRuleNone')
            : t('retention.otherRule', {
                count: row.otherRuleCount,
                value: format.number(row.otherRuleCount),
              }),
      },
    ],
    [t, format],
  );
  const actions: GridAction<RetentionRuleStatus>[] = [
    {
      id: 'change',
      label: t('retention.change'),
      requires: 'documentRetention:manage',
      onSelect: (row) => setEditing(row),
    },
  ];

  return (
    <section className="flex flex-col gap-3" aria-labelledby="retention-heading">
      <h1 id="retention-heading" className="text-2xl font-semibold">
        {t('retention.heading')}
      </h1>
      <p className="text-sm text-muted-foreground">{t('retention.note')}</p>
      <div ref={box} className="flex flex-col gap-3">
        <p
          ref={status}
          tabIndex={-1}
          role="status"
          className="text-sm outline-none empty:hidden focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {message.text && <span key={message.count}>{message.text}</span>}
        </p>
        <Can permission="documentRetention:manage">
          {editing && (
            <RuleForm
              key={editing.category}
              rule={editing}
              onClose={() => setEditing(null)}
              onSaved={(text) => {
                setEditing(null);
                setMessage((now) => ({ text, count: now.count + 1 }));
              }}
            />
          )}
        </Can>
        <DataGrid
          label={t('retention.heading')}
          columns={columns}
          rows={rules.data ?? []}
          rowId={(row) => row.category}
          rowLabel={(row) => t('retention.rowLabel', { category: t(`category.${row.category}`) })}
          actions={actions}
          status={rules.isPending ? 'loading' : rules.isError ? 'error' : 'ready'}
          errorMessage={rules.isError ? tCommon(errorMessageKey(rules.error)) : undefined}
          onRetry={() => void rules.refetch()}
          emptyMessage={t('retention.empty')}
        />
      </div>
      <HoldsSection />
    </section>
  );
}

function RuleForm({
  rule,
  onClose,
  onSaved,
}: {
  rule: RetentionRuleStatus;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const { t } = useTranslation('documents');
  const { t: tCommon } = useTranslation();
  const set = useSetRetention();
  const form = useZodForm(retentionFormSchema, {
    years: rule.years === null ? '' : String(rule.years),
    forever: rule.years === null,
  });
  const name = t(`category.${rule.category}`);

  const submit = async (values: RetentionValues) => {
    set.reset();
    try {
      await set.mutateAsync({
        category: rule.category,
        years: values.forever ? null : Number(values.years),
      });
      onSaved(t('retention.done', { category: name }));
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <h2 data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('retention.formHeading', { category: name })}
      </h2>
      <Form form={form} onSubmit={submit} className="max-w-xl">
        <TextField<RetentionValues>
          name="years"
          label={t('retention.yearsLabel')}
          hint={t('retention.yearsHint', { max: RETENTION_MAX_YEARS })}
          inputMode="numeric"
          autoComplete="off"
        />
        <CheckboxField<RetentionValues> name="forever" label={t('retention.forever')} />
        {set.error && (
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(set.error))}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending={set.isPending}>
            {set.isPending ? t('retention.saving') : t('retention.save')}
          </SubmitButton>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </Form>
    </div>
  );
}
