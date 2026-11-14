import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { SlotProps } from '@/registry';
import { usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Form, SubmitButton, TextAreaField, TextField, useZodForm } from '@/shared/ui/form';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import {
  usePatientMerges,
  usePatientSettings,
  useSavePatientSettings,
  useUnmergePatient,
} from '../hooks/use-merge';
import {
  mergeFormSchema,
  windowFormSchema,
  type MergeFormValues,
  type WindowFormValues,
} from '../schemas';
import type { PatientMerge } from '../types';
import { DetailTab } from './DetailTabs';

/**
 * The "Merge history" tab (`patient.detail.tabs`, #558): the records merged into this one, newest
 * first, with why, who and when, and how many rows each module moved. For `patient:merge`.
 */
export default function MergeHistoryTab({ context }: SlotProps) {
  const { t } = useTranslation('patients');
  const patientId = typeof context?.patientId === 'string' ? context.patientId : '';
  if (!patientId) return null;
  return (
    <DetailTab id="merges" title={t('merge.history.tab')}>
      <MergeHistory key={patientId} patientId={patientId} />
    </DetailTab>
  );
}

const DAY_MS = 86_400_000;
const UNMERGE_FORM = 'patient-unmerge-form';
const WINDOW_FORM = 'patient-window-form';
/** The refusals the server gives for an unmerge, each said in words. */
const UNMERGE_REFUSALS = new Set([
  'not_merged',
  'patient_merged',
  'unmerge_window_closed',
  'unmerge_unsupported',
]);

function MergeHistory({ patientId }: { patientId: string }) {
  const { t } = useTranslation('patients');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const merges = usePatientMerges(patientId);
  const canUnmerge = usePermission('patient:unmerge');
  const settings = usePatientSettings(canUnmerge);
  const unmerge = useUnmergePatient();
  const [undoing, setUndoing] = useState<PatientMerge | null>(null);
  const [done, setDone] = useState(false);
  const form = useZodForm(mergeFormSchema, { reason: '' });

  const days = settings.data?.unmergeWindowDays;
  // The server decides; this only keeps an action that would be refused from being offered.
  const windowEnd = (row: PatientMerge) =>
    days === undefined ? undefined : new Date(Date.parse(row.mergedAt) + days * DAY_MS);
  const closed = (row: PatientMerge) => {
    if (days === undefined) return false;
    const end = windowEnd(row);
    return days === 0 || (end !== undefined && end.getTime() < Date.now());
  };
  const undoable = (row: PatientMerge) => row.unmergedAt === undefined && !closed(row);

  const columns = useMemo<GridColumn<PatientMerge>[]>(
    () => [
      {
        id: 'when',
        header: t('merge.history.when'),
        value: (row) => format.dateTime(row.mergedAt),
        hideable: false,
        // The merged record keeps its id: the link opens it, read-only.
        render: (row, text) => (
          <Link className="font-medium underline" to={`/patients/${row.sourcePatientId}`}>
            {text}
          </Link>
        ),
      },
      { id: 'reason', header: t('merge.history.reason'), value: (row) => row.reason },
      { id: 'by', header: t('merge.history.by'), value: (row) => row.mergedBy },
      {
        id: 'moved',
        header: t('merge.history.moved'),
        value: (row) => {
          const parts = Object.entries(row.moved).map(
            ([module, count]) =>
              `${t(`merge.modules.${module}`, { defaultValue: module })}: ${count}`,
          );
          return parts.length > 0 ? parts.join(', ') : t('merge.history.nothing');
        },
      },
      {
        id: 'status',
        header: t('merge.history.status'),
        value: (row) => {
          if (row.unmergedAt !== undefined) {
            return t('merge.history.undone', {
              when: format.dateTime(row.unmergedAt),
              by: row.unmergedBy ?? '',
              reason: row.unmergeReason ?? '',
            });
          }
          if (!canUnmerge || days === undefined) return t('merge.history.active');
          if (days === 0) return t('merge.history.windowOff');
          const end = new Date(Date.parse(row.mergedAt) + days * DAY_MS);
          if (end.getTime() < Date.now()) return t('merge.history.windowClosed');
          return t('merge.history.windowOpen', { when: format.dateTime(end.toISOString()) });
        },
      },
    ],
    [t, format, canUnmerge, days],
  );

  const close = () => {
    setUndoing(null);
    unmerge.reset();
    form.reset({ reason: '' });
  };
  const submit = async (values: MergeFormValues) => {
    if (!undoing) return;
    try {
      await unmerge.mutateAsync({ sourceId: undoing.sourcePatientId, reason: values.reason });
      setDone(true);
      close();
    } catch {
      // Said in the dialog.
    }
  };
  const code = isApiError(unmerge.error) ? unmerge.error.serverCode : undefined;
  const failure = unmerge.error
    ? code !== undefined && UNMERGE_REFUSALS.has(code)
      ? t(`merge.undo.errors.${code}`)
      : tCommon(errorMessageKey(unmerge.error))
    : undefined;

  return (
    <section aria-labelledby="merge-history-heading" className="flex flex-col gap-3">
      <h2 id="merge-history-heading" className="text-lg font-semibold">
        {t('merge.history.heading')}
      </h2>
      <p role="status" className="text-sm">
        {done ? t('merge.undo.done') : ''}
      </p>
      <DataGrid
        label={t('merge.history.heading')}
        columns={columns}
        rows={merges.data ?? []}
        rowId={(row) => row.id}
        rowLabel={(row) => t('merge.history.rowLabel', { when: format.dateTime(row.mergedAt) })}
        status={merges.isPending ? 'loading' : merges.isError ? 'error' : 'ready'}
        errorMessage={merges.isError ? tCommon(errorMessageKey(merges.error)) : undefined}
        onRetry={() => void merges.refetch()}
        emptyMessage={t('merge.history.empty')}
        actions={[
          {
            id: 'undo',
            label: t('merge.history.undo'),
            requires: 'patient:unmerge',
            disabled: (row) => !undoable(row),
            onSelect: (row) => {
              setDone(false);
              setUndoing(row);
            },
          },
        ]}
      />
      <ConfirmDialog
        open={undoing !== null}
        onClose={close}
        title={t('merge.undo.title')}
        description={t('merge.undo.body')}
        cancelLabel={t('merge.undo.cancel')}
        confirmLabel={t('merge.undo.confirm')}
        confirmForm={UNMERGE_FORM}
        destructive
        pending={unmerge.isPending}
      >
        <Form form={form} id={UNMERGE_FORM} onSubmit={submit} className="gap-3">
          <TextAreaField<MergeFormValues>
            name="reason"
            label={t('merge.undo.reason')}
            required
            data-autofocus
          />
        </Form>
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </ConfirmDialog>
      {canUnmerge && <WindowSetting />}
    </section>
  );
}

/** The days a merge may be undone, for `patient:unmerge`: 0 turns undoing off. */
function WindowSetting() {
  const { t } = useTranslation('patients');
  const { t: tCommon } = useTranslation();
  const settings = usePatientSettings(true);
  const save = useSavePatientSettings();
  const [saved, setSaved] = useState(false);
  const form = useZodForm(windowFormSchema, { days: '' });
  const current = settings.data?.unmergeWindowDays;
  const [filled, setFilled] = useState(false);
  // Fill the field once the setting arrives.
  if (current !== undefined && !filled) {
    setFilled(true);
    form.reset({ days: String(current) });
  }

  const submit = async (values: WindowFormValues) => {
    setSaved(false);
    try {
      await save.mutateAsync({ unmergeWindowDays: Number(values.days) });
      setSaved(true);
    } catch {
      // Said below.
    }
  };
  const failed = save.error ?? settings.error;

  return (
    <section aria-labelledby="merge-window-heading" className="flex max-w-xl flex-col gap-2">
      <h3 id="merge-window-heading" className="font-semibold">
        {t('merge.settings.heading')}
      </h3>
      <p className="text-sm text-muted-foreground">{t('merge.settings.description')}</p>
      <Form form={form} id={WINDOW_FORM} onSubmit={submit} className="gap-3">
        <TextField<WindowFormValues>
          name="days"
          label={t('merge.settings.days')}
          inputMode="numeric"
          autoComplete="off"
        />
        <div>
          <SubmitButton pending={save.isPending || settings.isPending}>
            {save.isPending ? t('merge.settings.saving') : t('merge.settings.save')}
          </SubmitButton>
        </div>
      </Form>
      <p role="status" className="text-sm">
        {saved ? t('merge.settings.saved') : ''}
      </p>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(failed))}
        </p>
      )}
    </section>
  );
}
