import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Can, usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { Form, SelectField, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { field } from '../components/field';
import { InventoryLinks } from '../components/InventoryLinks';
import { useArchiveLocation, useLocations, useSaveLocation } from '../hooks/use-inventory';
import {
  LOCATION_KINDS,
  LOCATION_NAME_MAX,
  locationFormSchema,
  type LocationFormValues,
} from '../schemas';
import type { StockLocation } from '../types';

const REFUSED: Record<string, string> = {
  location_name_taken: 'locations.refused.nameTaken',
  location_has_stock: 'locations.refused.hasStock',
  conflict: 'locations.refused.conflict',
  location_not_found: 'locations.refused.gone',
};

/**
 * The places that keep stock (`inventory/locations`, #102): a store, a pharmacy counter, a
 * ward's own stock. Read with `stock:read`; added, renamed, archived and restored with
 * `stockLocation:manage`. A place with stock is not archived (the API refuses it). Works at every
 * width.
 */
export default function StockLocations() {
  const { t } = useTranslation('inventory');
  const { t: tCommon } = useTranslation();
  const viewFieldId = useId();
  const [archived, setArchived] = useState(false);
  const [panel, setPanel] = useState<{ location: StockLocation | null } | null>(null);
  const locations = useLocations(archived);
  const rows = useMemo(
    () => locations.data?.pages.flatMap((page) => page.items) ?? [],
    [locations.data],
  );
  const total = locations.isPlaceholderData ? undefined : locations.data?.pages[0]?.total;
  const canManage = usePermission('stockLocation:manage');

  const box = useRef<HTMLDivElement>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  usePanelFocus(panel ? (panel.location?.id ?? 'new') : null, box, statusLine);
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(statusLine.current);
  }, [message]);

  const archive = useArchiveLocation();
  const refusal = (error: unknown) => {
    const key = isApiError(error) ? REFUSED[error.serverCode ?? ''] : undefined;
    return key ? t(key) : tCommon(errorMessageKey(error));
  };

  const columns = useMemo<GridColumn<StockLocation>[]>(
    () => [
      {
        id: 'name',
        header: t('locations.columns.name'),
        value: (row) => row.name,
        hideable: false,
      },
      { id: 'kind', header: t('locations.columns.kind'), value: (row) => t(`kind.${row.kind}`) },
    ],
    [t],
  );

  const actions: GridAction<StockLocation>[] = canManage
    ? [
        {
          id: 'rename',
          label: t('locations.edit'),
          requires: 'stockLocation:manage',
          onSelect: (row) => setPanel({ location: row }),
        },
        {
          id: archived ? 'restore' : 'archive',
          label: t(archived ? 'locations.restore' : 'locations.archive'),
          requires: 'stockLocation:manage',
          disabled: () => archive.isPending,
          onSelect: (row) => {
            if (archive.isPending) return;
            archive.mutate(
              { location: row, archived: !archived },
              {
                onSuccess: () =>
                  say(
                    t(archived ? 'locations.restored' : 'locations.archived', { name: row.name }),
                  ),
                onError: (error) => say(refusal(error)),
              },
            );
          },
        },
      ]
    : [];

  return (
    <div ref={box} className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('locations.heading')}</h1>
        <InventoryLinks />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-full flex-col gap-1.5 sm:w-56">
          <label htmlFor={viewFieldId} className="text-sm font-medium">
            {t('locations.view')}
          </label>
          <select
            id={viewFieldId}
            className={field}
            value={archived ? 'archived' : 'active'}
            onChange={(event) => setArchived(event.target.value === 'archived')}
          >
            <option value="active">{t('locations.active')}</option>
            <option value="archived">{t('locations.archivedView')}</option>
          </select>
        </div>
        <Can permission="stockLocation:manage">
          {!panel && (
            <Button type="button" onClick={() => setPanel({ location: null })}>
              {t('locations.add')}
            </Button>
          )}
        </Can>
      </div>
      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="text-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {[message.text, total === undefined ? '' : t('locations.count', { count: total })]
          .filter(Boolean)
          .join(' ')}
      </p>
      {panel && canManage && (
        <LocationPanel
          key={panel.location?.id ?? 'new'}
          location={panel.location}
          onClose={() => setPanel(null)}
          onSaved={(saved) => {
            setPanel(null);
            say(t(panel.location ? 'locations.saved' : 'locations.added', { name: saved.name }));
          }}
        />
      )}
      <DataGrid
        label={t('locations.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.name}
        actions={actions}
        status={locations.isPending ? 'loading' : locations.isError ? 'error' : 'ready'}
        errorMessage={locations.isError ? tCommon(errorMessageKey(locations.error)) : undefined}
        onRetry={() => void locations.refetch()}
        emptyMessage={t(archived ? 'locations.emptyArchived' : 'locations.empty')}
        hasNextPage={locations.hasNextPage && !locations.isPlaceholderData}
        total={total}
        loadingMore={locations.isFetchingNextPage}
        onLoadMore={() => void locations.fetchNextPage()}
      />
    </div>
  );
}

function LocationPanel({
  location,
  onClose,
  onSaved,
}: {
  location: StockLocation | null;
  onClose: () => void;
  onSaved: (location: StockLocation) => void;
}) {
  const { t } = useTranslation('inventory');
  const { t: tCommon } = useTranslation();
  const headingId = useId();
  const save = useSaveLocation();
  const form = useZodForm(locationFormSchema, {
    name: location?.name ?? '',
    kind: location?.kind ?? 'store',
  });
  const alert = useRef<HTMLParagraphElement>(null);
  const code = isApiError(save.error) ? save.error.serverCode : undefined;
  const failure = save.error
    ? code && REFUSED[code]
      ? t(REFUSED[code])
      : tCommon(errorMessageKey(save.error))
    : undefined;
  useLayoutEffect(() => {
    if (failure) focusIfLost(alert.current);
  }, [failure]);

  const submit = async (values: LocationFormValues) => {
    save.reset();
    try {
      onSaved(await save.mutateAsync({ location, values }));
    } catch {
      // Said from the mutation state.
    }
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h2 id={headingId} data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {location ? t('locations.editHeading', { name: location.name }) : t('locations.addHeading')}
      </h2>
      <Form form={form} onSubmit={submit}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <TextField<LocationFormValues>
            name="name"
            label={t('locations.name')}
            required
            maxLength={LOCATION_NAME_MAX}
            autoComplete="off"
          />
          <SelectField<LocationFormValues>
            name="kind"
            label={t('locations.kind')}
            required
            options={LOCATION_KINDS.map((each) => ({ value: each, label: t(`kind.${each}`) }))}
          />
        </div>
        {failure && (
          <p
            ref={alert}
            role="alert"
            tabIndex={-1}
            className="text-sm text-destructive outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {failure}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending={save.isPending}>{t('locations.save')}</SubmitButton>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </Form>
    </section>
  );
}
