import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useAccessPolicy, usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import type { PermissionScope } from '@/shared/types';
import { Button } from '@/shared/ui/button';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { PageSkeleton } from '@/shared/ui/page-skeleton';
import { SystemPage } from '@/shared/ui/system-page';
import { PermissionMatrix, type Reason } from '../components/PermissionMatrix';
import {
  differences,
  OWN_ACCESS,
  rebase,
  toGrants,
  toList,
  withinHeld,
  type Grants,
} from '../matrix';
import { useLatestRole, usePermissionCatalog, useRole, useSaveGrants } from '../hooks/use-roles';
import type { PermissionCatalog, RoleDetail } from '../types';

const REFUSALS: Record<string, string> = {
  last_admin: 'matrix.errors.lastAdmin',
  cannot_remove_own_access: 'matrix.errors.ownAccess',
  role_not_allowed: 'errors.notAllowed',
  role_not_found: 'errors.notFound',
  unknown_permission: 'matrix.errors.unknown',
};

const link =
  'inline-flex items-center rounded-sm text-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

function Editor({ role, catalog }: { role: RoleDetail; catalog: PermissionCatalog['items'] }) {
  const { t } = useTranslation('roles');
  const { t: tCommon } = useTranslation();
  const policy = useAccessPolicy();
  const canManage = usePermission('role:manage');
  const save = useSaveGrants(role.id);
  const latestRole = useLatestRole(role.id);

  // The role as it was when the editor opened, and the edit made over it. A read in the
  // background never changes what is being edited.
  const [base, setBase] = useState<Grants>(() => toGrants(role.permissions));
  const [draft, setDraft] = useState<Grants>(base);
  const [done, setDone] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // After a conflict: what the other person saved for permissions this person changed too.
  const [theirs, setTheirs] = useState<ReadonlyMap<string, PermissionScope | null>>(new Map());
  const [conflicted, setConflicted] = useState(false);

  const held = new Map<string, PermissionScope>(
    (policy?.permissions ?? []).map((g) => [g.permission, g.scope ?? 'all']),
  );
  const isOwnRole = policy?.roleId === role.id;
  // A role that holds more than the caller does is not theirs to change (the server says 403).
  const above = [...base].some(([permission, scope]) => !withinHeld(held.get(permission), scope));
  const readOnly = !canManage || above;

  const changed = differences(base, draft);
  const busy = save.isPending || checking;

  const blocked = (permission: string): Reason | null => {
    if (permission === OWN_ACCESS && isOwnRole) return 'ownAccess';
    // A permission the caller lacks cannot be given, and one already held can stay as it is.
    if (!held.has(permission) && !base.has(permission)) return 'notHeld';
    return null;
  };

  const allowedScopes = (permission: string, scopes: readonly PermissionScope[]) => {
    const own = held.get(permission);
    return scopes.filter((scope) => withinHeld(own, scope));
  };

  const change = (next: Grants) => {
    setDone(null);
    setConflicted(false);
    save.reset();
    setDraft(next);
  };

  const onToggle = (permission: string, on: boolean, scopes: readonly PermissionScope[]) => {
    const next = new Map(draft);
    if (!on) next.delete(permission);
    else next.set(permission, scopes.includes('all') ? 'all' : (scopes[0] ?? 'all'));
    change(next);
  };

  const onScope = (permission: string, scope: PermissionScope) =>
    change(new Map(draft).set(permission, scope));

  const onSave = async () => {
    if (busy || changed.length === 0) return;
    setDone(null);
    save.reset();
    setChecking(true);
    try {
      // The API takes no version of a role: the grants are read again, and when someone has
      // changed them since the editor opened, their change is shown and nothing is sent.
      const latest = toGrants((await latestRole()).permissions);
      if (differences(latest, base).length > 0) {
        const seen = new Map<string, PermissionScope | null>();
        for (const permission of changed) {
          if (latest.get(permission) !== base.get(permission)) {
            seen.set(permission, latest.get(permission) ?? null);
          }
        }
        setTheirs(seen);
        setBase(latest);
        setDraft(rebase(latest, draft, changed));
        setConflicted(true);
        return;
      }
    } catch {
      // The read failed; the save below reports it if the server is unreachable.
    } finally {
      setChecking(false);
    }
    try {
      const saved = await save.mutateAsync(toList(draft));
      const next = toGrants(saved.permissions);
      setBase(next);
      setDraft(next);
      setTheirs(new Map());
      setConflicted(false);
      setDone(t('matrix.saved', { name: saved.name }));
    } catch {
      // Shown above the matrix.
    }
  };

  const discard = () => {
    setDraft(base);
    setTheirs(new Map());
    setConflicted(false);
    setDone(null);
    save.reset();
  };

  const refusal =
    isApiError(save.error) && save.error.serverCode
      ? (REFUSALS[save.error.serverCode] ?? null)
      : null;
  const errorText = save.isError
    ? refusal
      ? t(refusal)
      : tCommon(errorMessageKey(save.error))
    : null;

  const status = conflicted
    ? t('matrix.conflict', { count: theirs.size })
    : (done ??
      (changed.length > 0
        ? t('matrix.unsaved', { count: changed.length })
        : t('matrix.noChanges')));

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6">
      <Link to="/roles" className={link}>
        {t('matrix.back')}
      </Link>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t('matrix.heading', { name: role.name })}
        </h1>
        <p className="text-muted-foreground">{t('matrix.description')}</p>
      </div>

      {!canManage && <p className="text-sm">{t('matrix.viewOnly')}</p>}
      {canManage && above && <p className="text-sm">{t('matrix.above')}</p>}
      {canManage && isOwnRole && <p className="text-sm">{t('matrix.ownRole')}</p>}
      {errorText && (
        <p role="alert" className="text-sm text-destructive">
          {errorText}
        </p>
      )}
      <p role="status" className="text-sm text-muted-foreground">
        {status}
      </p>

      <PermissionMatrix
        catalog={catalog}
        grants={draft}
        readOnly={readOnly}
        blocked={blocked}
        allowedScopes={allowedScopes}
        saved={theirs}
        onToggle={onToggle}
        onScope={onScope}
      />

      {!readOnly && (
        <div className="sticky bottom-0 flex flex-wrap gap-3 border-t bg-background py-3">
          <Button
            aria-disabled={busy || changed.length === 0 || undefined}
            onClick={() => void onSave()}
          >
            {t('matrix.save')}
          </Button>
          <Button
            variant="outline"
            aria-disabled={busy || changed.length === 0 || undefined}
            onClick={discard}
          >
            {t('matrix.discard')}
          </Button>
        </div>
      )}
    </div>
  );
}

function Matrix() {
  const { t } = useTranslation('roles');
  const { t: tCommon } = useTranslation();
  const { roleId = '' } = useParams();
  const role = useRole(roleId);
  const catalog = usePermissionCatalog();

  if (role.isPending || catalog.isPending) return <PageSkeleton label={t('matrix.loading')} />;
  if (role.isError || catalog.isError || !role.data || !catalog.data) {
    const error = role.error ?? catalog.error;
    const missing = isApiError(error) && error.serverCode === 'role_not_found';
    return (
      <SystemPage
        alert={!missing}
        title={missing ? t('matrix.missingTitle') : t('matrix.errorTitle')}
        description={missing ? t('errors.notFound') : tCommon(errorMessageKey(error))}
        actions={
          <Link to="/roles" className={link}>
            {t('matrix.back')}
          </Link>
        }
      />
    );
  }
  return <Editor key={role.data.id} role={role.data} catalog={catalog.data.items} />;
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function RoleMatrixPage() {
  return (
    <DesktopOnly>
      <Matrix />
    </DesktopOnly>
  );
}
