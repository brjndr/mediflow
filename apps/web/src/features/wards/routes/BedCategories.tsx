import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { usePermission } from '@/access';
import { useServiceOptions } from '@/features/services';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { Form, SelectField, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { refusalKey } from '../components/refusal';
import { useBedCategories, useBedCategoryChange } from '../hooks/use-wards';
import { bedCategoryFormSchema, NAME_MAX, type BedCategoryFormValues } from '../schemas';
import type { BedCategory } from '../types';

const MANAGE = 'ward:manage';
const link =
  'inline-flex items-center rounded-sm text-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

/** A category's name and the bed-day service it is charged as, to add one or change one. */
function CategoryForm({
  category,
  pending,
  onSave,
  onCancel,
}: {
  category?: BedCategory;
  pending: boolean;
  onSave: (values: BedCategoryFormValues) => void | Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation('wards');
  const services = useServiceOptions('bed');
  const form = useZodForm(bedCategoryFormSchema, {
    name: category?.name ?? '',
    serviceId: category?.serviceId ?? '',
  });
  const offered = services.data ?? [];
  // The category's own service stays an option when it has been archived since.
  const options = [
    ...(category?.serviceId && !offered.some((service) => service.id === category.serviceId)
      ? [{ value: category.serviceId, label: category.serviceName ?? '' }]
      : []),
    ...offered.map((service) => ({
      value: service.id,
      label: `${service.name} (${service.code})`,
    })),
  ];
  return (
    <div className="flex max-w-xl flex-col gap-3 rounded-lg border p-4">
      <h2 className="text-base font-semibold">
        {category
          ? t('categories.editHeading', { name: category.name })
          : t('categories.addHeading')}
      </h2>
      <Form form={form} onSubmit={onSave}>
        <TextField
          name="name"
          label={t('categories.name')}
          hint={t('categories.nameHint')}
          required
          maxLength={NAME_MAX}
          autoComplete="off"
        />
        {services.available && !services.isError ? (
          <SelectField
            name="serviceId"
            label={t('categories.serviceId')}
            hint={t('categories.serviceHint')}
            placeholder={t('categories.noService')}
            options={options}
          />
        ) : (
          // Without the price catalog there is nothing to pick from: the link stays as it is.
          <div className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('categories.serviceId')}</span>
            <span>{category?.serviceName ?? t('categories.noService')}</span>
            <span className="text-xs text-muted-foreground">
              {t('categories.serviceUnavailable')}
            </span>
          </div>
        )}
        <div className="flex flex-wrap gap-3">
          <SubmitButton pending={pending}>
            {category ? t('categories.editSubmit') : t('categories.addSubmit')}
          </SubmitButton>
          <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
            {t('categories.cancel')}
          </Button>
        </div>
      </Form>
    </div>
  );
}

function Categories() {
  const { t } = useTranslation('wards');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const mayManage = usePermission(MANAGE);
  const [archived, setArchived] = useState(false);
  const categories = useBedCategories(archived);
  const change = useBedCategoryChange();
  // The form that is open: for a new category, or for the one with this id.
  const [form, setForm] = useState<'new' | string | null>(null);
  // What was just done, said once in a status line.
  const [done, setDone] = useState<string | null>(null);

  const rows = useMemo(() => categories.data ?? [], [categories.data]);
  const editing = form === 'new' ? undefined : rows.find((row) => row.id === form);

  const open = (next: 'new' | string | null) => {
    change.reset();
    setDone(null);
    setForm(next);
  };

  const save = async (values: BedCategoryFormValues) => {
    setDone(null);
    try {
      if (editing) {
        // Only what was changed is sent, from the version that is on screen now. Empty text
        // takes the service away.
        const body = {
          ...(values.name === editing.name ? {} : { name: values.name }),
          ...(values.serviceId === (editing.serviceId ?? '')
            ? {}
            : { serviceId: values.serviceId }),
          expectedVersion: editing.version,
        };
        await change.mutateAsync({ id: editing.id, body });
        setDone(t('categories.saved', { name: values.name }));
      } else {
        await change.mutateAsync({
          create: {
            name: values.name,
            ...(values.serviceId ? { serviceId: values.serviceId } : {}),
          },
        });
        setDone(t('categories.added', { name: values.name }));
      }
      setForm(null);
    } catch {
      // Shown from the mutation state below. The form stays, with what was typed.
    }
  };

  const setCategoryArchived = (row: BedCategory, next: boolean) => {
    open(null);
    change.mutate(
      { id: row.id, archived: next },
      {
        onSuccess: () =>
          setDone(
            t(next ? 'categories.archivedDone' : 'categories.restoredDone', { name: row.name }),
          ),
      },
    );
  };

  const columns = useMemo<GridColumn<BedCategory>[]>(
    () => [
      {
        id: 'name',
        header: t('categories.columns.name'),
        value: (row) => row.name,
        hideable: false,
      },
      {
        id: 'service',
        header: t('categories.columns.service'),
        // A category with no service is said, not left blank: its beds are not charged.
        value: (row) => row.serviceName ?? t('categories.notCharged'),
      },
      {
        id: 'beds',
        header: t('categories.columns.beds'),
        value: (row) => String(row.bedCount),
        align: 'end',
      },
    ],
    [t],
  );

  const actions: GridAction<BedCategory>[] = archived
    ? [
        {
          id: 'restore',
          label: t('categories.restore'),
          requires: MANAGE,
          disabled: () => change.isPending,
          onSelect: (row) => setCategoryArchived(row, false),
        },
      ]
    : [
        {
          id: 'edit',
          label: t('categories.edit'),
          requires: MANAGE,
          disabled: () => change.isPending,
          onSelect: (row) => open(row.id),
        },
        {
          id: 'archive',
          label: t('categories.archive'),
          requires: MANAGE,
          disabled: () => change.isPending,
          onSelect: (row) => setCategoryArchived(row, true),
        },
      ];

  const refused = refusalKey(change.error);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <Link to="/wards" className={link}>
          {t('categories.backToWards')}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{t('categories.heading')}</h1>
        <p className="text-muted-foreground">{t('categories.description')}</p>
      </div>

      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          className="h-4 w-4"
          checked={archived}
          onChange={(event) => {
            open(null);
            setArchived(event.target.checked);
          }}
        />
        {t('categories.showArchived')}
      </label>

      {change.isError && (
        <p role="alert" className="text-sm text-destructive">
          {refused ? t(refused) : tCommon(errorMessageKey(change.error))}
        </p>
      )}
      <p role="status" className="text-sm text-muted-foreground">
        {done ?? ''}
      </p>

      <DataGrid
        label={t('categories.gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.name}
        actions={actions}
        status={categories.isPending ? 'loading' : categories.isError ? 'error' : 'ready'}
        errorMessage={categories.isError ? t('categories.failed') : undefined}
        onRetry={() => void categories.refetch()}
        emptyMessage={archived ? t('categories.emptyArchived') : t('categories.empty')}
      />

      {mayManage &&
        !archived &&
        (form === null || (form !== 'new' && !editing) ? (
          <Button variant="outline" className="self-start" onClick={() => open('new')}>
            {t('categories.addHeading')}
          </Button>
        ) : (
          <CategoryForm
            // A form for each category: choosing another starts from that one.
            key={form}
            category={editing}
            pending={change.isPending}
            onSave={save}
            onCancel={() => open(null)}
          />
        ))}
    </div>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function BedCategories() {
  return (
    <DesktopOnly>
      <Categories />
    </DesktopOnly>
  );
}
