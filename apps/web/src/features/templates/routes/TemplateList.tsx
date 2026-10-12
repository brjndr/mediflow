import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Can } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { useFormatters } from '@/tenancy';
import { useTemplates } from '../hooks/use-templates';
import { TEMPLATE_KINDS, type TemplateKind } from '../placeholders';
import type { Template } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';
const link =
  'inline-flex items-center rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

function Templates() {
  const { t } = useTranslation('templates');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const [kind, setKind] = useState<TemplateKind | ''>('');
  const [archived, setArchived] = useState(false);
  const templates = useTemplates({ kind, archived });

  const rows = useMemo(
    () => templates.data?.pages.flatMap((page) => page.items) ?? [],
    [templates.data],
  );
  const total = templates.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<Template>[]>(
    () => [
      {
        id: 'name',
        header: t('columns.name'),
        value: (row) => row.name,
        hideable: false,
        render: (row, text) => (
          <Link to={`/templates/${row.id}`} className={link}>
            {text}
          </Link>
        ),
      },
      { id: 'kind', header: t('columns.kind'), value: (row) => t(`kinds.${row.kind}`) },
      {
        id: 'version',
        header: t('columns.version'),
        value: (row) => t('versionNumber', { version: row.version }),
      },
      {
        id: 'savedAt',
        header: t('columns.savedAt'),
        value: (row) => format.dateTime(row.savedAt),
      },
    ],
    [t, format],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
        <Can permission="template:manage">
          <Link to="/templates/new" className={`${link} pt-2 text-sm underline`}>
            {t('add')}
          </Link>
        </Can>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('filters.kind')}
          <select
            value={kind}
            onChange={(event) =>
              setKind(TEMPLATE_KINDS.find((value) => value === event.target.value) ?? '')
            }
            className={control}
          >
            <option value="">{t('filters.allKinds')}</option>
            {TEMPLATE_KINDS.map((value) => (
              <option key={value} value={value}>
                {t(`kinds.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex h-9 items-center gap-2 text-sm font-medium pointer-coarse:h-11">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={archived}
            onChange={(event) => setArchived(event.target.checked)}
          />
          {t('filters.showArchived')}
        </label>
      </div>

      <p role="status" className="text-sm text-muted-foreground">
        {total === undefined ? '' : t(archived ? 'countArchived' : 'count', { count: total })}
      </p>

      <DataGrid
        label={t('gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.name}
        status={templates.isPending ? 'loading' : templates.isError ? 'error' : 'ready'}
        errorMessage={templates.isError ? tCommon(errorMessageKey(templates.error)) : undefined}
        onRetry={() => void templates.refetch()}
        emptyMessage={kind !== '' ? t('emptyKind') : archived ? t('emptyArchived') : t('empty')}
        hasNextPage={templates.hasNextPage}
        loadingMore={templates.isFetchingNextPage}
        onLoadMore={() => void templates.fetchNextPage()}
      />
    </div>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function TemplateList() {
  return (
    <DesktopOnly>
      <Templates />
    </DesktopOnly>
  );
}
