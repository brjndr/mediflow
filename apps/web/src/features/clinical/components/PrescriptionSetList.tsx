import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { Form, TextField, useZodForm } from '@/shared/ui/form';
import { useFormatters } from '@/tenancy';
import {
  useLoadPrescriptionSet,
  usePrescriptionSets,
  useSetAccess,
  useUpdatePrescriptionSet,
} from '../hooks/use-prescription-sets';
import {
  lineOfView,
  renameSetSchema,
  SET_NAME_MAX,
  type RenameSetOutput,
  type RenameSetValues,
} from '../sets-schemas';
import type { PrescriptionSet, PrescriptionSetLineView } from '../types';

const EDIT_FORM = 'edit-prescription-set';

interface Editing {
  set: PrescriptionSet;
  lines: PrescriptionSetLineView[];
}

/**
 * The prescription sets the caller may use, to rename, trim and archive (#485): their own, and
 * the hospital's shared ones for whoever holds `prescriptionSet:manageShared`. The archived ones
 * are listed on request and can be restored. A set is changed from the version the edit began at;
 * a conflict says so and asks to open it again. Medicines cannot be added here: a set is filled
 * from a prescription ("Save as a set").
 */
export function PrescriptionSetList() {
  const { t } = useTranslation('clinical');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const access = useSetAccess();
  const [archived, setArchived] = useState(false);
  const sets = usePrescriptionSets(access.canRead, archived);
  const loadSet = useLoadPrescriptionSet();
  const update = useUpdatePrescriptionSet();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [refusal, setRefusal] = useState('');
  const [message, setMessage] = useState('');
  const status = useRef<HTMLParagraphElement>(null);
  const form = useZodForm(renameSetSchema, { name: '' });
  const rows = useMemo(() => sets.data?.items ?? [], [sets.data]);

  const reason = (error: unknown): string => {
    const code = isApiError(error) ? error.serverCode : undefined;
    return code === 'prescription_set_name_taken'
      ? t('sets.manage.nameTaken')
      : code === 'conflict'
        ? t('sets.manage.conflict')
        : code === 'prescription_set_not_found'
          ? t('sets.manage.gone')
          : code === 'permission_denied'
            ? t('sets.manage.notAllowed')
            : code === 'unknown_drug'
              ? t('sets.manage.unknownDrug')
              : tCommon(errorMessageKey(error));
  };

  const open = async (set: PrescriptionSet) => {
    setMessage(t('sets.load.loading', { name: set.name }));
    try {
      const detail = await loadSet(set.id);
      setMessage('');
      setRefusal('');
      form.reset({ name: detail.set.name });
      setEditing({ set: detail.set, lines: detail.lines });
    } catch (error) {
      setMessage(reason(error));
    }
  };

  const change = (set: PrescriptionSet, body: { archived: boolean }) =>
    update.mutate(
      { setId: set.id, body: { version: set.version, ...body } },
      {
        onSuccess: () => {
          setMessage(
            t(body.archived ? 'sets.manage.archivedDone' : 'sets.manage.restoredDone', {
              name: set.name,
            }),
          );
          // The row left the list: focus moves to the status line.
          requestAnimationFrame(() => focusIfLost(status.current));
        },
        onError: (error) => setMessage(reason(error)),
      },
    );

  const submit = (values: RenameSetOutput) => {
    if (!editing) return;
    const { set, lines } = editing;
    const trimmedAway = lines.length !== set.lineCount;
    const renamed = values.name !== set.name;
    if (!renamed && !trimmedAway) {
      setEditing(null);
      return;
    }
    setRefusal('');
    update.mutate(
      {
        setId: set.id,
        body: {
          version: set.version,
          ...(renamed ? { name: values.name } : {}),
          ...(trimmedAway ? { lines: lines.map(lineOfView) } : {}),
        },
      },
      {
        onSuccess: (detail) => {
          setEditing(null);
          setMessage(t('sets.manage.saved', { name: detail.set.name }));
        },
        onError: (error) => setRefusal(reason(error)),
      },
    );
  };

  const columns = useMemo<GridColumn<PrescriptionSet>[]>(
    () => [
      {
        id: 'name',
        header: t('sets.manage.columns.name'),
        value: (row) => row.name,
        hideable: false,
      },
      {
        id: 'owner',
        header: t('sets.manage.columns.owner'),
        value: (row) => t(row.shared ? 'sets.manage.shared' : 'sets.manage.own'),
      },
      {
        id: 'lines',
        header: t('sets.manage.columns.lines'),
        value: (row) => row.lineCount,
        align: 'end',
      },
      {
        id: 'updated',
        header: t('sets.manage.columns.updated'),
        value: (row) => format.dateTime(row.updatedAt),
      },
    ],
    [t, format],
  );

  const locked = (row: PrescriptionSet) => (row.shared && !access.canShare) || update.isPending;
  const actions: GridAction<PrescriptionSet>[] = archived
    ? [
        {
          id: 'restore',
          label: t('sets.manage.restore'),
          requires: 'prescriptionSet:manage',
          disabled: locked,
          onSelect: (row) => change(row, { archived: false }),
        },
      ]
    : [
        {
          id: 'edit',
          label: t('sets.manage.edit'),
          requires: 'prescriptionSet:manage',
          disabled: locked,
          onSelect: (row) => void open(row),
        },
        {
          id: 'archive',
          label: t('sets.manage.archive'),
          requires: 'prescriptionSet:manage',
          disabled: locked,
          onSelect: (row) => change(row, { archived: true }),
        },
      ];

  if (!access.canRead) return null;
  const total = sets.data?.total;

  return (
    <section aria-labelledby="sets-heading" className="flex flex-col gap-3">
      <h2 id="sets-heading" className="text-lg font-semibold">
        {t('sets.manage.heading')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('sets.manage.intro')}</p>
      <label className="flex min-h-6 items-center gap-2 text-sm pointer-coarse:min-h-11">
        <input
          type="checkbox"
          className="size-4"
          checked={archived}
          onChange={(event) => {
            setArchived(event.target.checked);
            setMessage('');
          }}
        />
        {t('sets.manage.showArchived')}
      </label>
      <p
        ref={status}
        role="status"
        tabIndex={-1}
        className="text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {message || (total === undefined ? '' : t('sets.manage.count', { count: total }))}
      </p>
      <DataGrid
        label={t(archived ? 'sets.manage.archivedHeading' : 'sets.manage.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.name}
        actions={actions}
        status={sets.isPending ? 'loading' : sets.isError ? 'error' : 'ready'}
        errorMessage={sets.isError ? tCommon(errorMessageKey(sets.error)) : undefined}
        onRetry={() => void sets.refetch()}
        emptyMessage={t(archived ? 'sets.manage.emptyArchived' : 'sets.manage.empty')}
        total={total}
      />
      <ConfirmDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={t('sets.manage.editTitle')}
        description={t('sets.manage.editDescription')}
        cancelLabel={t('cancel')}
        confirmLabel={t('sets.manage.editConfirm')}
        confirmForm={EDIT_FORM}
        pending={update.isPending}
      >
        <Form form={form} id={EDIT_FORM} onSubmit={submit} className="gap-3">
          <TextField<RenameSetValues>
            name="name"
            label={t('sets.save.name')}
            required
            maxLength={SET_NAME_MAX}
            autoComplete="off"
            data-autofocus
          />
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">{t('sets.manage.medicines')}</legend>
            <ul className="flex flex-col gap-2">
              {editing?.lines.map((line, index) => {
                const only = editing.lines.length === 1;
                return (
                  <li
                    key={`${line.drugId}-${index}`}
                    className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
                  >
                    <span className="min-w-0 break-words">
                      {line.drugArchived
                        ? t('sets.manage.lineArchived', { name: line.drugName })
                        : line.drugName}
                      <span className="block text-xs text-muted-foreground">
                        {[line.dose, line.frequency].join(', ')}
                      </span>
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-disabled={only || undefined}
                      aria-label={t('sets.manage.removeLine', { name: line.drugName })}
                      onClick={() => {
                        if (only) return;
                        setEditing({
                          ...editing,
                          lines: editing.lines.filter((_, at) => at !== index),
                        });
                      }}
                    >
                      {t('sets.manage.remove')}
                    </Button>
                  </li>
                );
              })}
            </ul>
            {editing?.lines.length === 1 && (
              <p className="text-xs text-muted-foreground">{t('sets.manage.lastLine')}</p>
            )}
          </fieldset>
          {refusal && (
            <p role="alert" className="text-sm text-destructive">
              {refusal}
            </p>
          )}
        </Form>
      </ConfirmDialog>
    </section>
  );
}
