import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { PermissionScope } from '@/shared/types';
import type { Grants } from '../matrix';
import type { PermissionCatalog } from '../types';

export type Reason = 'notHeld' | 'ownAccess';

interface PermissionMatrixProps {
  catalog: PermissionCatalog['items'];
  grants: Grants;
  /** The whole matrix is only shown: the person may not change it, or the role is above theirs. */
  readOnly: boolean;
  /** Why one permission cannot be switched, when it cannot. */
  blocked: (permission: string) => Reason | null;
  /** The scopes the person may give a permission: never wider than their own. */
  allowedScopes: (permission: string, scopes: readonly PermissionScope[]) => PermissionScope[];
  /** What was saved by someone else meanwhile, for a permission both changed. */
  saved: ReadonlyMap<string, PermissionScope | null>;
  onToggle: (permission: string, on: boolean, scopes: readonly PermissionScope[]) => void;
  onScope: (permission: string, scope: PermissionScope) => void;
}

/** A module id as a heading: `lab-tests` is "Lab tests". */
function humanize(id: string): string {
  const text = id.replace(/[-_]/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Permissions grouped by module, each a checkbox (Space toggles it) with, where the catalog allows
 * more than `all`, a scope list beside it. Plain controls in the tab order: nothing is dragged.
 */
export function PermissionMatrix({
  catalog,
  grants,
  readOnly,
  blocked,
  allowedScopes,
  saved,
  onToggle,
  onScope,
}: PermissionMatrixProps) {
  const { t } = useTranslation('roles');
  const prefix = useId();
  const groups = new Map<string, PermissionCatalog['items']>();
  for (const item of catalog) groups.set(item.feature, [...(groups.get(item.feature) ?? []), item]);

  return (
    <div className="flex flex-col gap-4">
      {[...groups].map(([feature, items]) => {
        const held = items.filter((item) => grants.has(item.permission)).length;
        return (
          <fieldset key={feature} className="rounded-lg border p-4">
            <legend className="px-1 text-base font-semibold">
              {humanize(feature)}{' '}
              <span className="text-sm font-normal text-muted-foreground">
                {t('matrix.heldOf', { held, total: items.length })}
              </span>
            </legend>
            <ul className="flex flex-col gap-1">
              {items.map((item) => {
                const id = `${prefix}-${item.permission}`;
                const checked = grants.has(item.permission);
                const reason = readOnly ? null : blocked(item.permission);
                const locked = readOnly || reason !== null;
                const scopes = allowedScopes(item.permission, item.scopes);
                const scope = grants.get(item.permission) ?? 'all';
                const theirs = saved.get(item.permission);
                return (
                  <li
                    key={item.permission}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 py-1 pointer-coarse:min-h-11"
                  >
                    <input
                      id={id}
                      type="checkbox"
                      checked={checked}
                      aria-disabled={locked || undefined}
                      aria-describedby={`${id}-info`}
                      className="size-4 shrink-0 accent-primary pointer-coarse:size-6"
                      onChange={(event) => {
                        if (locked) return;
                        onToggle(item.permission, event.target.checked, scopes);
                      }}
                    />
                    <label htmlFor={id} className="min-w-0 flex-1 text-sm">
                      <span className="font-medium">{item.description}</span>{' '}
                      <code className="text-xs text-muted-foreground">{item.permission}</code>
                    </label>
                    {scopes.length > 1 && checked && (
                      <select
                        aria-label={t('matrix.scopeOf', { permission: item.permission })}
                        aria-disabled={locked || undefined}
                        value={scope}
                        className="h-8 rounded-md border bg-background px-2 text-sm pointer-coarse:h-11"
                        onChange={(event) => {
                          if (!locked) {
                            onScope(item.permission, event.target.value as PermissionScope);
                          }
                        }}
                      >
                        {scopes.map((option) => (
                          <option key={option} value={option}>
                            {t(`matrix.scope.${option}`)}
                          </option>
                        ))}
                      </select>
                    )}
                    <span id={`${id}-info`} className="w-full pl-7 text-xs text-muted-foreground">
                      {reason && t(`matrix.reason.${reason}`)}
                      {theirs !== undefined && (
                        <span className="ml-2 font-medium text-foreground">
                          {t('matrix.theySaved', {
                            value:
                              theirs === null
                                ? t('matrix.notGranted')
                                : t(`matrix.scope.${theirs}`),
                          })}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        );
      })}
    </div>
  );
}
