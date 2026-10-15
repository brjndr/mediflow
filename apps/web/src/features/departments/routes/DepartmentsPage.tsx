import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Can } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { DepartmentForm } from '../components/DepartmentForm';
import { useArchiveDepartment, useDepartments, useSaveDepartment } from '../hooks/use-departments';
import type { DepartmentFormValues } from '../schemas';
import type { Department } from '../types';

/** The form that is open: to add a department, or to change one. */
type Panel = { mode: 'add' } | { mode: 'edit'; department: Department };

const MANAGE = 'department:manage';

/** What the server said about a save, as a key of this feature's strings, when it has one. */
function refusal(error: unknown): 'errors.nameTaken' | 'errors.conflict' | null {
  if (!isApiError(error)) return null;
  if (error.serverCode === 'department_name_taken') return 'errors.nameTaken';
  if (error.serverCode === 'conflict') return 'errors.conflict';
  return null;
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function DepartmentsPage() {
  const { t } = useTranslation('departments');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const [archivedView, setArchivedView] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  // What was just done, said once in a status line.
  const [done, setDone] = useState<string | null>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  const departments = useDepartments({ archived: archivedView });
  const save = useSaveDepartment();
  const archive = useArchiveDepartment();

  const rows = useMemo(
    () => departments.data?.pages.flatMap((page) => page.items) ?? [],
    [departments.data],
  );
  const total = departments.data?.pages[0]?.total;

  const open = (next: Panel | null) => {
    save.reset();
    archive.reset();
    setDone(null);
    setPanel(next);
  };

  const onSave = async (values: DepartmentFormValues) => {
    const editing = panel?.mode === 'edit' ? panel.department : undefined;
    setDone(null);
    try {
      const saved = await save.mutateAsync({
        editing,
        values: { name: values.name, description: values.description },
      });
      setPanel(null);
      setDone(t(editing ? 'saved.changed' : 'saved.added', { name: saved.name }));
    } catch (error) {
      // The version on screen is out of date: the form closes and the fresh list shows why.
      if (refusal(error) === 'errors.conflict') setPanel(null);
    }
  };

  const columns = useMemo<GridColumn<Department>[]>(
    () => [
      { id: 'name', header: t('columns.name'), value: (row) => row.name, hideable: false },
      { id: 'description', header: t('columns.description'), value: (row) => row.description },
    ],
    [t],
  );

  const actions = useMemo<GridAction<Department>[]>(() => {
    const setArchived = (department: Department, archived: boolean) => {
      save.reset();
      setDone(null);
      setPanel(null);
      archive.mutate(
        { department, archived },
        {
          onSuccess: (saved) =>
            setDone(t(archived ? 'saved.archived' : 'saved.restored', { name: saved.name })),
        },
      );
    };
    // One change at a time: a save or an archive in flight is not overtaken by another action.
    const busy = () => archive.isPending || save.isPending;
    return archivedView
      ? [
          {
            id: 'restore',
            label: t('actions.restore'),
            requires: MANAGE,
            disabled: busy,
            onSelect: (row) => setArchived(row, false),
          },
        ]
      : [
          {
            id: 'edit',
            label: t('actions.edit'),
            requires: MANAGE,
            disabled: busy,
            onSelect: (row) => {
              save.reset();
              archive.reset();
              setDone(null);
              setPanel({ mode: 'edit', department: row });
            },
          },
          {
            id: 'archive',
            label: t('actions.archive'),
            requires: MANAGE,
            disabled: busy,
            onSelect: (row) => setArchived(row, true),
          },
        ];
  }, [archivedView, archive, save, t]);

  const saveRefusal = refusal(save.error);
  const formError =
    save.isError && saveRefusal !== 'errors.conflict'
      ? saveRefusal
        ? t(saveRefusal)
        : tCommon(errorMessageKey(save.error))
      : undefined;
  // Shown by the list: a conflict (the form has closed) and a failed archive or restore.
  const listError =
    save.isError && saveRefusal === 'errors.conflict'
      ? t('errors.conflict')
      : archive.isError
        ? tCommon(errorMessageKey(archive.error))
        : undefined;

  // The form closed, or a row was archived and left the list: what had focus went with it, so
  // the keyboard goes to the line that says what happened.
  useEffect(() => {
    if (panel === null) focusIfLost(statusLine.current);
  }, [panel, done, listError]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm font-medium pointer-coarse:min-h-11">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={archivedView}
            disabled={save.isPending || archive.isPending}
            onChange={(event) => {
              open(null);
              setArchivedView(event.target.checked);
            }}
          />
          {t('showArchived')}
        </label>
        <Can permission={MANAGE}>
          {panel === null && !archivedView && (
            <Button onClick={() => open({ mode: 'add' })}>{t('add')}</Button>
          )}
        </Can>
      </div>

      {panel && (
        <Can permission={MANAGE}>
          <DepartmentForm
            // A different department is a different form: nothing typed carries over.
            key={panel.mode === 'edit' ? panel.department.id : 'add'}
            editing={panel.mode === 'edit' ? panel.department : undefined}
            pending={save.isPending}
            error={formError}
            onSubmit={onSave}
            onCancel={() => open(null)}
          />
        </Can>
      )}

      {listError && (
        <p role="alert" className="text-sm text-destructive">
          {listError}
        </p>
      )}
      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {done ??
          (total === undefined
            ? ''
            : t(archivedView ? 'countArchived' : 'count', { count: total }))}
      </p>

      <DataGrid
        label={t('gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.name}
        actions={actions}
        status={departments.isPending ? 'loading' : departments.isError ? 'error' : 'ready'}
        errorMessage={departments.isError ? tCommon(errorMessageKey(departments.error)) : undefined}
        onRetry={() => void departments.refetch()}
        emptyMessage={archivedView ? t('emptyArchived') : t('empty')}
        hasNextPage={departments.hasNextPage}
        loadingMore={departments.isFetchingNextPage}
        onLoadMore={() => void departments.fetchNextPage()}
      />
    </div>
  );
}
