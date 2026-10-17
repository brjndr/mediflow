import { useEffect, useMemo, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { usePermission } from '@/access';
import { useServiceOptions } from '@/features/services';
import { errorMessageKey, isApiError } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { Form, SelectField, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { refusalKey } from '../components/refusal';
import { useExpectedVersion } from '../components/use-expected';
import { useBedCategories, useBedCategoryChange } from '../hooks/use-wards';
import { bedCategoryFormSchema, NAME_MAX, type BedCategoryFormValues } from '../schemas';
import type { BedCategory, BedCategoryCreate, BedCategoryUpdate } from '../types';

const MANAGE = 'ward:manage';
const link =
  'inline-flex items-center rounded-sm text-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

const categoryValues = (category?: BedCategory): BedCategoryFormValues => ({
  name: category?.name ?? '',
  serviceId: category?.serviceId ?? '',
});

/** What saving the form asks for: a new category, or the changed fields of one. */
type Saved = { create: BedCategoryCreate } | { body: BedCategoryUpdate };

/**
 * A category's name and the bed-day service it is charged as, to add one or change one. A change
 * works from the category as it was when the form opened.
 */
function CategoryForm({
  from,
  latest,
  pending,
  onSave,
  onCancel,
}: {
  /** The category as it was when the form opened. Absent for a new one. */
  from?: BedCategory;
  /** The category as it is saved now. Differs from `from` once someone else has changed it. */
  latest?: BedCategory;
  pending: boolean;
  /** Answers whether the save met a conflict. */
  onSave: (change: Saved, name: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { t } = useTranslation('wards');
  const services = useServiceOptions('bed');
  const form = useZodForm(bedCategoryFormSchema, categoryValues(from));
  // Read while rendering, which is what keeps it up to date.
  const { dirtyFields } = form.formState;
  const version = useExpectedVersion(from?.version ?? 0, latest?.version);
  // What someone else saved meanwhile goes into the fields this person has not touched. What was
  // typed stays, and is all that is sent.
  const { reset } = form;
  useEffect(() => {
    if (latest) reset(categoryValues(latest), { keepDirtyValues: true });
  }, [reset, latest]);

  const category = latest ?? from;
  const offered = services.data ?? [];
  // The category's own service stays an option when it has been archived since.
  const own = [from, latest].flatMap((one) =>
    one?.serviceId && !offered.some((service) => service.id === one.serviceId)
      ? [{ value: one.serviceId, label: one.serviceName ?? '' }]
      : [],
  );
  const options = [
    ...own.filter((option, index) => own.findIndex((o) => o.value === option.value) === index),
    ...offered.map((service) => ({
      value: service.id,
      label: `${service.name} (${service.code})`,
    })),
  ];

  const submit = async (values: BedCategoryFormValues) => {
    if (!from) {
      const create = {
        name: values.name,
        ...(values.serviceId ? { serviceId: values.serviceId } : {}),
      };
      await onSave({ create }, values.name);
      return;
    }
    // Empty text takes the service away.
    const body = {
      ...(dirtyFields.name ? { name: values.name } : {}),
      ...(dirtyFields.serviceId ? { serviceId: values.serviceId } : {}),
      expectedVersion: version.expected,
    };
    if (await onSave({ body }, values.name)) version.conflict();
  };
  return (
    <div className="flex max-w-xl flex-col gap-3 rounded-lg border p-4">
      <h2
        data-panel-heading
        tabIndex={-1}
        className="rounded-sm text-base font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {category
          ? t('categories.editHeading', { name: category.name })
          : t('categories.addHeading')}
      </h2>
      <Form form={form} onSubmit={submit}>
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
          <Button
            type="button"
            variant="outline"
            aria-disabled={pending || undefined}
            onClick={onCancel}
          >
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
  // The form that is open: for a new category, or for one as it was when the form opened.
  const [form, setForm] = useState<'new' | BedCategory | null>(null);
  // What was just done, said once in a status line.
  const [done, setDone] = useState<string | null>(null);

  const rows = useMemo(() => categories.data ?? [], [categories.data]);
  // The category being changed as it is now. When it is no longer in the list (archived
  // elsewhere), its form is no longer open.
  const latest =
    form === null || form === 'new' ? undefined : rows.find((row) => row.id === form.id);
  const shown = form === 'new' || latest ? form : null;
  // The form opens above the list, from Add or a row's Change: the keyboard goes to its heading,
  // and back to the button when it closes, or to the line that says what was done.
  const box = useRef<HTMLDivElement>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  usePanelFocus(shown, box, statusLine);

  const open = (next: 'new' | BedCategory | null) => {
    change.reset();
    // A form that is opened, or left, starts a new attempt: what is added from it is not taken
    // for a repeat of something added from a form before it.
    change.newAttempt();
    setDone(null);
    setForm(next);
  };

  const save = async (saved: Saved, name: string): Promise<boolean> => {
    setDone(null);
    try {
      if ('create' in saved) await change.mutateAsync(saved);
      else if (shown && shown !== 'new') await change.mutateAsync({ id: shown.id, ...saved });
      setDone(t('create' in saved ? 'categories.added' : 'categories.saved', { name }));
      setForm(null);
      return false;
    } catch (error) {
      // Shown from the mutation state below. The form stays, with what was typed.
      return isApiError(error) && error.serverCode === 'conflict';
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
          disabled: () => change.isPending || shown !== null,
          onSelect: (row) => open(row),
        },
        {
          id: 'archive',
          label: t('categories.archive'),
          requires: MANAGE,
          disabled: () => change.isPending || shown !== null,
          onSelect: (row) => setCategoryArchived(row, true),
        },
      ];

  const refused = refusalKey(change.error);

  return (
    <div ref={box} className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6">
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
          // Not while a change is on its way: its answer has to be seen.
          disabled={change.isPending}
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
      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
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
        (shown === null ? (
          <Button
            variant="outline"
            className="self-start"
            aria-disabled={change.isPending || undefined}
            onClick={() => open('new')}
          >
            {t('categories.addHeading')}
          </Button>
        ) : (
          <CategoryForm
            // A form for each category: choosing another starts from that one.
            key={shown === 'new' ? 'new' : shown.id}
            from={shown === 'new' ? undefined : shown}
            latest={latest}
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
