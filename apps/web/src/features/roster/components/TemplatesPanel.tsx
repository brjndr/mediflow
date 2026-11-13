import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Can } from '@/access';
import { useDepartmentOptions } from '@/features/departments';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { Dialog } from '@/shared/ui/dialog';
import { Form, SelectField, TextField, useZodForm } from '@/shared/ui/form';
import { useCreateTemplate, useRetireTemplate, useShiftTemplates } from '../hooks/use-roster';
import {
  SHIFT_KINDS,
  SHIFT_TEMPLATES,
  templateFormSchema,
  type TemplateFormValues,
} from '../schemas';
import type { ShiftTemplate } from '../types';

function TemplateDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (name: string) => void;
}) {
  const { t } = useTranslation('roster');
  const { t: tCommon } = useTranslation();
  const create = useCreateTemplate();
  const departments = useDepartmentOptions();
  const form = useZodForm(templateFormSchema, {
    name: '',
    shiftKind: 'morning',
    departmentId: '',
    startTime: SHIFT_TEMPLATES.morning.start,
    endTime: SHIFT_TEMPLATES.morning.end,
  });
  const code = isApiError(create.error) ? create.error.serverCode : undefined;
  const failure = !create.error
    ? undefined
    : code === 'template_exists'
      ? t('templates.errors.exists')
      : code === 'unknown_department'
        ? t('errors.department')
        : tCommon(errorMessageKey(create.error));
  const submit = async (values: TemplateFormValues) => {
    try {
      await create.mutateAsync({
        name: values.name.trim(),
        shiftKind: values.shiftKind,
        startTime: values.startTime,
        endTime: values.endTime,
        ...(values.departmentId !== '' ? { departmentId: values.departmentId } : {}),
      });
      onDone(values.name.trim());
    } catch {
      // Said below, from the mutation state.
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('templates.new.title')}
      description={t('templates.new.description')}
      closeLabel={t('close')}
      busy={create.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
          <Button type="submit" form="roster-template-form" aria-busy={create.isPending}>
            {create.isPending ? t('templates.new.saving') : t('templates.new.save')}
          </Button>
        </>
      }
    >
      <Form form={form} id="roster-template-form" onSubmit={submit}>
        <TextField<TemplateFormValues> name="name" label={t('templates.new.name')} required />
        <SelectField<TemplateFormValues>
          name="shiftKind"
          label={t('new.kind')}
          required
          options={SHIFT_KINDS.map((value) => ({ value, label: t(`kind.${value}`) }))}
        />
        {departments.available && (
          <SelectField<TemplateFormValues>
            name="departmentId"
            label={t('new.department')}
            placeholder={t('new.anyDepartment')}
            options={(departments.data ?? []).map((one) => ({ value: one.id, label: one.name }))}
          />
        )}
        <TextField<TemplateFormValues>
          name="startTime"
          type="time"
          label={t('new.start')}
          required
        />
        <TextField<TemplateFormValues>
          name="endTime"
          type="time"
          label={t('new.end')}
          hint={t('new.endHint')}
          required
        />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </Form>
    </Dialog>
  );
}

/**
 * The hospital's shift templates (#592): a named kind of shift with its hours on the hospital's
 * clock, offered when a shift is added. `roster:manage` adds and retires them; everyone who can
 * read the roster sees them. A retired template stays out of the list; shifts made from it stay.
 */
export function TemplatesPanel({ say }: { say: (text: string) => void }) {
  const { t } = useTranslation('roster');
  const { t: tCommon } = useTranslation();
  const templates = useShiftTemplates();
  const [adding, setAdding] = useState(false);
  const [retiringId, setRetiringId] = useState<string | null>(null);
  const rows = useMemo(() => templates.data ?? [], [templates.data]);
  const retiring = rows.find((one) => one.id === retiringId);
  const retire = useRetireTemplate();

  const columns = useMemo<GridColumn<ShiftTemplate>[]>(
    () => [
      {
        id: 'name',
        header: t('templates.columns.name'),
        value: (row) => row.name,
        hideable: false,
      },
      { id: 'kind', header: t('columns.kind'), value: (row) => t(`kind.${row.shiftKind}`) },
      {
        id: 'hours',
        header: t('templates.columns.hours'),
        value: (row) => t('templates.hours', { start: row.startTime, end: row.endTime }),
      },
      {
        id: 'department',
        header: t('columns.department'),
        value: (row) => row.departmentName ?? '',
      },
    ],
    [t],
  );
  const actions = useMemo<GridAction<ShiftTemplate>[]>(
    () => [
      {
        id: 'retire',
        label: t('templates.retire'),
        requires: 'roster:manage',
        onSelect: (row) => setRetiringId(row.id),
      },
    ],
    [t],
  );

  return (
    <section
      aria-labelledby="roster-templates"
      className="flex flex-col gap-3 rounded-md border p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="roster-templates" className="text-base font-semibold">
          {t('templates.heading')}
        </h2>
        <Can permission="roster:manage">
          <Button variant="outline" onClick={() => setAdding(true)}>
            {t('templates.new.open')}
          </Button>
        </Can>
      </div>
      <p className="text-sm text-muted-foreground">{t('templates.intro')}</p>
      <DataGrid
        label={t('templates.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.name}
        actions={actions}
        status={templates.isPending ? 'loading' : templates.isError ? 'error' : 'ready'}
        errorMessage={templates.isError ? tCommon(errorMessageKey(templates.error)) : undefined}
        onRetry={() => void templates.refetch()}
        emptyMessage={t('templates.empty')}
      />
      {adding && (
        <TemplateDialog
          onClose={() => setAdding(false)}
          onDone={(name) => {
            setAdding(false);
            say(t('templates.new.done', { name }));
          }}
        />
      )}
      {retiring && (
        <ConfirmDialog
          open
          onClose={() => setRetiringId(null)}
          title={t('templates.retireDialog.title', { name: retiring.name })}
          description={t('templates.retireDialog.description')}
          cancelLabel={t('close')}
          confirmLabel={t('templates.retire')}
          destructive
          pending={retire.isPending}
          onConfirm={() => {
            retire.mutate(
              { templateId: retiring.id, version: retiring.version },
              {
                onSuccess: () => {
                  setRetiringId(null);
                  say(t('templates.retireDialog.done', { name: retiring.name }));
                },
                onError: () => {
                  setRetiringId(null);
                  say(t('templates.retireDialog.failed'));
                },
              },
            );
          }}
        />
      )}
    </section>
  );
}
