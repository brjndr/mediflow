import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFieldArray, useFormContext } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import {
  CheckboxField,
  Form,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
  useZodForm,
} from '@/shared/ui/form';
import { useCertificateFormats, useSetCertificateFormat } from '../hooks/use-consents';
import { fieldLabel, hasStandardLabel } from '../labels';
import {
  FIELD_TYPES,
  FIELDS_MAX,
  formatEditorSchema,
  fromEditor,
  newFieldName,
  toEditor,
  type FormatEditorValues,
} from '../schemas';
import type { CertificateFormat } from '../types';

/**
 * The fields of each kind of certificate (`/certificate-formats`, #567), for
 * `certificate:configure`. A hospital reorders, relabels, makes optional or required, removes
 * and adds fields; a change applies to certificates issued from now on, never to one issued.
 */
export default function FormatsPage() {
  const { t } = useTranslation('consents');
  const { t: tCommon } = useTranslation();
  const formats = useCertificateFormats();
  const box = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const [editing, setEditing] = useState<CertificateFormat | null>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  usePanelFocus(editing ? `edit:${editing.kind}` : null, box, status);
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);

  const columns = useMemo<GridColumn<CertificateFormat>[]>(
    () => [
      {
        id: 'kind',
        header: t('formats.columns.kind'),
        value: (row) => t(`certificate.kind.${row.kind}`),
        hideable: false,
        render: (_row, text) => <span className="font-medium">{text}</span>,
      },
      {
        id: 'fields',
        header: t('formats.columns.fields'),
        value: (row) => row.fields.map((field) => fieldLabel(t, row.kind, field)).join(', '),
      },
      {
        id: 'custom',
        header: t('formats.columns.state'),
        value: (row) => (row.custom ? t('formats.custom') : t('formats.standard')),
      },
    ],
    [t],
  );
  const actions: GridAction<CertificateFormat>[] = [
    {
      id: 'change',
      label: t('formats.change'),
      requires: 'certificate:configure',
      onSelect: (row) => setEditing(row),
    },
  ];

  return (
    <section className="flex flex-col gap-3" aria-labelledby="formats-heading">
      <h1 id="formats-heading" className="text-2xl font-semibold">
        {t('formats.heading')}
      </h1>
      <p className="text-sm text-muted-foreground">{t('formats.note')}</p>
      <div ref={box} className="flex flex-col gap-3">
        <p
          ref={status}
          tabIndex={-1}
          role="status"
          className="text-sm outline-none empty:hidden focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {message.text && <span key={message.count}>{message.text}</span>}
        </p>
        {editing && (
          <FormatEditor
            key={editing.kind}
            format={editing}
            onClose={() => setEditing(null)}
            onSaved={(text) => {
              setEditing(null);
              setMessage((now) => ({ text, count: now.count + 1 }));
            }}
          />
        )}
        <DataGrid
          label={t('formats.heading')}
          columns={columns}
          rows={formats.data ?? []}
          rowId={(row) => row.kind}
          rowLabel={(row) => t('formats.rowLabel', { kind: t(`certificate.kind.${row.kind}`) })}
          actions={actions}
          status={formats.isPending ? 'loading' : formats.isError ? 'error' : 'ready'}
          errorMessage={formats.isError ? tCommon(errorMessageKey(formats.error)) : undefined}
          onRetry={() => void formats.refetch()}
          emptyMessage={t('formats.empty')}
        />
      </div>
    </section>
  );
}

function FormatEditor({
  format,
  onClose,
  onSaved,
}: {
  format: CertificateFormat;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const { t } = useTranslation('consents');
  const { t: tCommon } = useTranslation();
  const set = useSetCertificateFormat();
  const form = useZodForm(formatEditorSchema, toEditor(format.fields, format.kind));
  const kindName = t(`certificate.kind.${format.kind}`);

  const submit = async (values: FormatEditorValues) => {
    set.reset();
    try {
      await set.mutateAsync({ kind: format.kind, update: { fields: fromEditor(values) } });
      onSaved(t('formats.done', { kind: kindName }));
    } catch {
      // Said below, from the mutation state.
    }
  };
  const reset = async () => {
    set.reset();
    try {
      await set.mutateAsync({ kind: format.kind, update: null });
      onSaved(t('formats.resetDone', { kind: kindName }));
    } catch {
      // Said below.
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <h2 data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('formats.formHeading', { kind: kindName })}
      </h2>
      <Form form={form} onSubmit={submit} className="max-w-2xl">
        <Rows kind={format.kind} />
        {set.error && (
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(set.error))}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending={set.isPending}>
            {set.isPending ? t('formats.saving') : t('formats.save')}
          </SubmitButton>
          {format.custom && (
            <Button type="button" variant="outline" onClick={() => void reset()}>
              {t('formats.reset')}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </Form>
    </div>
  );
}

/** The fields, one card each; moving is by buttons, never by dragging. */
function Rows({ kind }: { kind: CertificateFormat['kind'] }) {
  const { t } = useTranslation('consents');
  const { control, watch, formState } = useFormContext<FormatEditorValues>();
  const rows = useFieldArray({ control, name: 'fields', keyName: 'key' });
  const values = watch('fields');
  const listError = formState.errors.fields?.root?.message ?? formState.errors.fields?.message;
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-3">
        {rows.fields.map((row, index) => {
          const current = values[index];
          const title =
            current?.label ||
            (hasStandardLabel(kind, row.name) ? t(`certificate.field.${kind}.${row.name}`) : '') ||
            t('formats.newField');
          return (
            <li key={row.key} className="flex flex-col gap-2 rounded-md border p-3">
              <p className="font-medium">
                {t('formats.fieldTitle', { n: index + 1, label: title })}
              </p>
              <TextField<FormatEditorValues>
                name={`fields.${index}.label`}
                label={t('formats.label')}
                hint={current?.standard ? t('formats.labelHint') : undefined}
                required={!current?.standard}
                autoComplete="off"
              />
              {!current?.standard && (
                <SelectField<FormatEditorValues>
                  name={`fields.${index}.type`}
                  label={t('formats.type')}
                  options={FIELD_TYPES.map((value) => ({
                    value,
                    label: t(`formats.types.${value}`),
                  }))}
                />
              )}
              {!current?.standard && current?.type === 'select' && (
                <TextAreaField<FormatEditorValues>
                  name={`fields.${index}.optionsText`}
                  label={t('formats.options')}
                  hint={t('formats.optionsHint')}
                  required
                />
              )}
              <CheckboxField<FormatEditorValues>
                name={`fields.${index}.required`}
                label={t('formats.required')}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  aria-disabled={index === 0}
                  aria-label={t('formats.up', { n: index + 1 })}
                  onClick={() => index > 0 && rows.move(index, index - 1)}
                >
                  {t('formats.moveUp')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  aria-disabled={index === rows.fields.length - 1}
                  aria-label={t('formats.down', { n: index + 1 })}
                  onClick={() => index < rows.fields.length - 1 && rows.move(index, index + 1)}
                >
                  {t('formats.moveDown')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  aria-label={t('formats.removeField', { n: index + 1 })}
                  onClick={() => rows.remove(index)}
                >
                  {t('formats.remove')}
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
      {listError && (
        <p role="alert" className="text-sm text-destructive">
          {t('formats.needOne')}
        </p>
      )}
      <div>
        <Button
          type="button"
          variant="outline"
          aria-disabled={rows.fields.length >= FIELDS_MAX}
          onClick={() => {
            if (rows.fields.length >= FIELDS_MAX) return;
            rows.append(
              {
                name: newFieldName(values.map((value) => value.name)),
                label: '',
                type: 'text',
                required: false,
                standard: false,
                optionsText: '',
              },
              { shouldFocus: false },
            );
          }}
        >
          {t('formats.add')}
        </Button>
      </div>
    </div>
  );
}
