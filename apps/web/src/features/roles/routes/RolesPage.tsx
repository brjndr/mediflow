import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Can } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { RoleForm } from '../components/RoleForm';
import { useDeleteRole, useRoles, useSaveRole } from '../hooks/use-roles';
import type { RoleFormValues } from '../schemas';
import type { RoleSummary } from '../types';

/** The form that is open: to add a role, or to rename one. */
type Panel = { mode: 'add' } | { mode: 'rename'; role: RoleSummary };

const MANAGE = 'role:manage';

const REFUSALS: Record<string, string> = {
  role_exists: 'errors.exists',
  built_in_role: 'errors.builtIn',
  role_in_use: 'errors.inUse',
  role_not_allowed: 'errors.notAllowed',
  role_not_found: 'errors.notFound',
};

/** What the server said, as a key of this feature's strings, when it has one. */
function refusal(error: unknown): string | null {
  return isApiError(error) && error.serverCode ? (REFUSALS[error.serverCode] ?? null) : null;
}

function Roles() {
  const { t } = useTranslation('roles');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [deleting, setDeleting] = useState<RoleSummary | null>(null);
  // What was just done, said once in a status line.
  const [done, setDone] = useState<string | null>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  const roles = useRoles();
  const save = useSaveRole();
  const remove = useDeleteRole();

  const rows = roles.data ?? [];

  const open = (next: Panel | null) => {
    save.reset();
    remove.reset();
    setDone(null);
    setPanel(next);
  };

  const onSave = async (values: RoleFormValues) => {
    const editing = panel?.mode === 'rename' ? panel.role : undefined;
    setDone(null);
    try {
      const saved = await save.mutateAsync({ editing, name: values.name });
      setPanel(null);
      setDone(t(editing ? 'saved.renamed' : 'saved.added', { name: saved.name }));
    } catch {
      // Shown in the form.
    }
  };

  const onDelete = async () => {
    if (!deleting) return;
    const role = deleting;
    try {
      await remove.mutateAsync(role);
      setDone(t('saved.deleted', { name: role.name }));
    } catch {
      // Shown above the list.
    }
    setDeleting(null);
  };

  const columns = useMemo<GridColumn<RoleSummary>[]>(
    () => [
      { id: 'name', header: t('columns.name'), value: (row) => row.name, hideable: false },
      {
        id: 'kind',
        header: t('columns.kind'),
        value: (row) => t(row.builtIn ? 'kind.builtIn' : 'kind.custom'),
      },
      {
        id: 'permissions',
        header: t('columns.permissions'),
        value: (row) => String(row.permissionCount),
      },
      { id: 'members', header: t('columns.members'), value: (row) => String(row.memberCount) },
    ],
    [t],
  );

  const actions = useMemo<GridAction<RoleSummary>[]>(() => {
    // One change at a time, and a built-in role is never renamed or deleted.
    const unavailable = (row: RoleSummary) => row.builtIn || save.isPending || remove.isPending;
    return [
      {
        id: 'rename',
        label: t('actions.rename'),
        requires: MANAGE,
        disabled: unavailable,
        onSelect: (row) => {
          save.reset();
          remove.reset();
          setDone(null);
          setPanel({ mode: 'rename', role: row });
        },
      },
      {
        id: 'delete',
        label: t('actions.delete'),
        requires: MANAGE,
        disabled: unavailable,
        onSelect: (row) => {
          save.reset();
          remove.reset();
          setDone(null);
          setPanel(null);
          setDeleting(row);
        },
      },
    ];
  }, [save, remove, t]);

  const saveRefusal = refusal(save.error);
  const formError = save.isError
    ? saveRefusal
      ? t(saveRefusal)
      : tCommon(errorMessageKey(save.error))
    : undefined;
  const deleteRefusal = refusal(remove.error);
  const listError = remove.isError
    ? deleteRefusal
      ? t(deleteRefusal)
      : tCommon(errorMessageKey(remove.error))
    : undefined;

  // The form closed or a row left the list: what had focus went with it, so the keyboard goes
  // to the line that says what happened.
  useEffect(() => {
    if (panel === null && deleting === null) focusIfLost(statusLine.current);
  }, [panel, deleting, done, listError]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>

      <Can permission={MANAGE}>
        {panel === null && (
          <div className="flex justify-end">
            <Button onClick={() => open({ mode: 'add' })}>{t('add')}</Button>
          </div>
        )}
      </Can>

      {panel && (
        <Can permission={MANAGE}>
          <RoleForm
            // A different role is a different form: nothing typed carries over.
            key={panel.mode === 'rename' ? panel.role.id : 'add'}
            editing={panel.mode === 'rename' ? panel.role : undefined}
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
        {done ?? (roles.data ? t('count', { count: roles.data.length }) : '')}
      </p>

      <DataGrid
        label={t('gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.name}
        actions={actions}
        status={roles.isPending ? 'loading' : roles.isError ? 'error' : 'ready'}
        errorMessage={roles.isError ? tCommon(errorMessageKey(roles.error)) : undefined}
        onRetry={() => void roles.refetch()}
        emptyMessage={t('empty')}
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={t('delete.title', { name: deleting?.name ?? '' })}
        description={t('delete.description')}
        cancelLabel={t('delete.cancel')}
        confirmLabel={t('delete.confirm')}
        destructive
        pending={remove.isPending}
        onConfirm={() => void onDelete()}
      />
    </div>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function RolesPage() {
  return (
    <DesktopOnly>
      <Roles />
    </DesktopOnly>
  );
}
