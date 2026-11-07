import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccessPolicy } from '@/access';
import { useRegistry } from '@/registry';
import type { Grants } from '../matrix';
import { previewPolicy, previewRole } from '../preview';

interface RolePreviewProps {
  roleName: string;
  /** The role as saved. */
  saved: Grants;
  /** The role with the edits not yet saved. */
  unsaved: Grants;
  /** Permission texts from the catalog, by permission. */
  descriptions: ReadonlyMap<string, string>;
}

/**
 * "View as this role": the navigation, pages and actions the role would get, drawn as plain
 * lists. Nothing here renders a real screen, calls the server or touches the session, so it
 * shows no patient data and cannot change anything.
 */
export function RolePreview({ roleName, saved, unsaved, descriptions }: RolePreviewProps) {
  const { t } = useTranslation('roles');
  const { t: tCommon } = useTranslation();
  const registry = useRegistry();
  const real = useAccessPolicy();
  const [source, setSource] = useState<'saved' | 'unsaved'>('unsaved');
  const id = useId();
  const grants = source === 'saved' ? saved : unsaved;

  const preview = useMemo(
    () => (real ? previewRole(registry, previewPolicy(real, grants)) : null),
    [registry, real, grants],
  );
  if (!preview) return null;
  const withActions = preview.actions
    .map((feature) => ({
      ...feature,
      actions: feature.actions.filter((action) => action.scope !== null),
    }))
    .filter((feature) => feature.actions.length > 0);

  return (
    <section aria-labelledby={`${id}-h`} className="rounded-lg border p-4">
      <h2 id={`${id}-h`} className="text-lg font-semibold">
        {t('preview.heading', { name: roleName })}
      </h2>
      <p className="text-sm text-muted-foreground">{t('preview.description')}</p>
      <fieldset className="my-3 flex flex-wrap gap-x-6 gap-y-1">
        <legend className="sr-only">{t('preview.source')}</legend>
        {(['unsaved', 'saved'] as const).map((option) => (
          <label key={option} className="flex items-center gap-2 text-sm pointer-coarse:min-h-11">
            <input
              type="radio"
              name={id}
              checked={source === option}
              className="size-4 accent-primary pointer-coarse:size-6"
              onChange={() => setSource(option)}
            />
            {t(`preview.${option}`)}
          </label>
        ))}
      </fieldset>

      <div className="grid gap-6 [overflow-wrap:anywhere] lg:grid-cols-3 [&>*]:min-w-0">
        <div>
          <h3 className="mb-1 text-sm font-semibold">{t('preview.nav')}</h3>
          {preview.nav.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('preview.noNav')}</p>
          ) : (
            <ul aria-label={t('preview.nav')} className="list-disc pl-5 text-sm">
              {preview.nav.map((item) => (
                <li key={item.featureId}>{tCommon(item.titleKey)}</li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="mb-1 text-sm font-semibold">{t('preview.pages')}</h3>
          {preview.pages.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('preview.noPages')}</p>
          ) : (
            <ul aria-label={t('preview.pages')} className="list-disc pl-5 text-sm">
              {preview.pages.map((page) => (
                <li key={page.path}>
                  {tCommon(page.titleKey)}{' '}
                  <code className="text-xs text-muted-foreground">/{page.path}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="mb-1 text-sm font-semibold">{t('preview.actions')}</h3>
          {withActions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('preview.noActions')}</p>
          ) : (
            <ul aria-label={t('preview.actions')} className="text-sm">
              {withActions.map((feature) => (
                <li key={feature.featureId}>
                  <span className="font-medium">{tCommon(feature.titleKey)}</span>
                  <ul className="list-disc pl-5">
                    {feature.actions.map((action) => (
                      <li key={action.permission}>
                        {descriptions.get(action.permission) ?? action.permission}
                        {action.scope && action.scope !== 'all' && (
                          <span className="text-muted-foreground">
                            {' '}
                            ({t(`matrix.scope.${action.scope}`)})
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
