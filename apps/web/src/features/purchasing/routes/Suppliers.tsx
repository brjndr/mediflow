import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Can, usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { Form, SubmitButton, TextAreaField, TextField, useZodForm } from '@/shared/ui/form';
import { maskPhone } from '@/shared/utils/mask';
import { field } from '../components/field';
import { PurchasingLinks } from '../components/PurchasingLinks';
import { useArchiveSupplier, useSaveSupplier, useSuppliers } from '../hooks/use-purchasing';
import {
  ADDRESS_MAX,
  DRUG_LICENCE_MAX,
  EMAIL_MAX,
  PHONE_MAX,
  SUPPLIER_NAME_MAX,
  supplierFormSchema,
  type SupplierFormInput,
  type SupplierFormValues,
} from '../schemas';
import type { Supplier } from '../types';

const REFUSED: Record<string, string> = {
  supplier_name_taken: 'suppliers.refused.nameTaken',
  supplier_has_open_orders: 'suppliers.refused.openOrders',
  conflict: 'suppliers.refused.conflict',
  supplier_not_found: 'suppliers.refused.gone',
};

/**
 * The hospital's suppliers (`purchasing/suppliers`, #103): their GST and drug licence numbers and
 * contacts. Read with `supplier:read`; added, edited, archived and restored with
 * `supplier:manage`. One with an order still open is not archived (the API refuses it). Works at
 * every width.
 */
export default function Suppliers() {
  const { t } = useTranslation('purchasing');
  const { t: tCommon } = useTranslation();
  const viewFieldId = useId();
  const [archived, setArchived] = useState(false);
  const [panel, setPanel] = useState<{ supplier: Supplier | null } | null>(null);
  const suppliers = useSuppliers(archived);
  const rows = useMemo(
    () => suppliers.data?.pages.flatMap((page) => page.items) ?? [],
    [suppliers.data],
  );
  const total = suppliers.isPlaceholderData ? undefined : suppliers.data?.pages[0]?.total;
  const canManage = usePermission('supplier:manage');

  const box = useRef<HTMLDivElement>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  usePanelFocus(panel ? (panel.supplier?.id ?? 'new') : null, box, statusLine);
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(statusLine.current);
  }, [message]);

  const archive = useArchiveSupplier();
  const refusal = (error: unknown) => {
    const key = isApiError(error) ? REFUSED[error.serverCode ?? ''] : undefined;
    return key ? t(key) : tCommon(errorMessageKey(error));
  };

  const columns = useMemo<GridColumn<Supplier>[]>(
    () => [
      {
        id: 'name',
        header: t('suppliers.columns.name'),
        value: (row) => row.name,
        hideable: false,
      },
      { id: 'gstin', header: t('suppliers.columns.gstin'), value: (row) => row.gstin ?? '' },
      {
        id: 'drugLicence',
        header: t('suppliers.columns.drugLicence'),
        value: (row) => row.drugLicence ?? '',
      },
      {
        id: 'phone',
        header: t('suppliers.columns.phone'),
        value: (row) => row.phone ?? '',
        mask: maskPhone,
      },
      { id: 'email', header: t('suppliers.columns.email'), value: (row) => row.email ?? '' },
    ],
    [t],
  );

  const actions: GridAction<Supplier>[] = canManage
    ? [
        {
          id: 'edit',
          label: t('suppliers.edit'),
          requires: 'supplier:manage',
          onSelect: (row) => setPanel({ supplier: row }),
        },
        {
          id: archived ? 'restore' : 'archive',
          label: t(archived ? 'suppliers.restore' : 'suppliers.archive'),
          requires: 'supplier:manage',
          disabled: () => archive.isPending,
          onSelect: (row) => {
            if (archive.isPending) return;
            archive.mutate(
              { supplier: row, archived: !archived },
              {
                onSuccess: () =>
                  say(
                    t(archived ? 'suppliers.restored' : 'suppliers.archived', { name: row.name }),
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
        <h1 className="text-2xl font-semibold tracking-tight">{t('suppliers.heading')}</h1>
        <PurchasingLinks />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-full flex-col gap-1.5 sm:w-56">
          <label htmlFor={viewFieldId} className="text-sm font-medium">
            {t('suppliers.view')}
          </label>
          <select
            id={viewFieldId}
            className={field}
            value={archived ? 'archived' : 'active'}
            onChange={(event) => setArchived(event.target.value === 'archived')}
          >
            <option value="active">{t('suppliers.active')}</option>
            <option value="archived">{t('suppliers.archivedView')}</option>
          </select>
        </div>
        <Can permission="supplier:manage">
          {!panel && (
            <Button type="button" onClick={() => setPanel({ supplier: null })}>
              {t('suppliers.add')}
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
        {[message.text, total === undefined ? '' : t('suppliers.count', { count: total })]
          .filter(Boolean)
          .join(' ')}
      </p>
      {panel && canManage && (
        <SupplierPanel
          key={panel.supplier?.id ?? 'new'}
          supplier={panel.supplier}
          latest={rows.find((row) => row.id === panel.supplier?.id) ?? panel.supplier}
          onClose={() => setPanel(null)}
          onSaved={(saved) => {
            setPanel(null);
            say(t(panel.supplier ? 'suppliers.saved' : 'suppliers.added', { name: saved.name }));
          }}
        />
      )}
      <DataGrid
        label={t('suppliers.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.name}
        actions={actions}
        status={suppliers.isPending ? 'loading' : suppliers.isError ? 'error' : 'ready'}
        errorMessage={suppliers.isError ? tCommon(errorMessageKey(suppliers.error)) : undefined}
        onRetry={() => void suppliers.refetch()}
        emptyMessage={t(archived ? 'suppliers.emptyArchived' : 'suppliers.empty')}
        hasNextPage={suppliers.hasNextPage && !suppliers.isPlaceholderData}
        total={total}
        loadingMore={suppliers.isFetchingNextPage}
        onLoadMore={() => void suppliers.fetchNextPage()}
      />
    </div>
  );
}

const FIELDS = ['name', 'gstin', 'drugLicence', 'phone', 'email', 'address'] as const;
type Field = (typeof FIELDS)[number];
const valuesOf = (supplier: Supplier | null): SupplierFormInput => ({
  name: supplier?.name ?? '',
  gstin: supplier?.gstin ?? '',
  drugLicence: supplier?.drugLicence ?? '',
  phone: supplier?.phone ?? '',
  email: supplier?.email ?? '',
  address: supplier?.address ?? '',
});

/** An optional field of an edit: null clears what it held, unchanged is not sent. */
const change = (typed: string, held: string | undefined) =>
  typed === (held ?? '') ? undefined : typed === '' ? null : typed;

/**
 * Adds a supplier or edits one. An edit is made from the supplier as it was when the panel opened
 * and sends only what changed. When someone else saved it meanwhile (409 `conflict`), the panel
 * moves to the newest version: a field this person did not touch takes what was saved, what they
 * typed stays, and the fields both changed are named.
 */
function SupplierPanel({
  supplier: opened,
  latest,
  onClose,
  onSaved,
}: {
  supplier: Supplier | null;
  /** The supplier as the list reads it now. */
  latest: Supplier | null;
  onClose: () => void;
  onSaved: (supplier: Supplier) => void;
}) {
  const { t } = useTranslation('purchasing');
  const { t: tCommon } = useTranslation();
  const headingId = useId();
  const save = useSaveSupplier();
  const [supplier, setSupplier] = useState(opened);
  const [awaiting, setAwaiting] = useState(false);
  const [theirs, setTheirs] = useState<Field[]>([]);
  const form = useZodForm<SupplierFormInput, SupplierFormValues>(
    supplierFormSchema,
    valuesOf(supplier),
  );
  const { getValues, setValue } = form;
  // What someone else saved, taken in once the newest version is read after a conflict: noticed
  // while rendering, as the drugs screen does, and written into the untouched fields after it.
  const [taken, setTaken] = useState<{ fields: Field[]; values: SupplierFormInput } | null>(null);
  if (awaiting && latest && supplier && latest.version !== supplier.version) {
    const before = valuesOf(supplier);
    const saved = valuesOf(latest);
    const now = getValues();
    const untouched = FIELDS.filter((field) => now[field].trim() === before[field]);
    setSupplier(latest);
    setTheirs(
      FIELDS.filter((field) => !untouched.includes(field) && saved[field] !== before[field]),
    );
    setTaken({ fields: untouched, values: saved });
    setAwaiting(false);
  }
  useEffect(() => {
    for (const field of taken?.fields ?? []) {
      if (taken) setValue(field, taken.values[field]);
    }
  }, [taken, setValue]);
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

  const submit = async (values: SupplierFormValues) => {
    save.reset();
    const optional = (value: string) => (value === '' ? undefined : value);
    try {
      onSaved(
        await save.mutateAsync({
          supplier,
          create: {
            name: values.name,
            gstin: optional(values.gstin),
            drugLicence: optional(values.drugLicence),
            phone: optional(values.phone),
            email: optional(values.email),
            address: optional(values.address),
          },
          update: {
            name: values.name === supplier?.name ? undefined : values.name,
            gstin: change(values.gstin, supplier?.gstin),
            drugLicence: change(values.drugLicence, supplier?.drugLicence),
            phone: change(values.phone, supplier?.phone),
            email: change(values.email, supplier?.email),
            address: change(values.address, supplier?.address),
          },
        }),
      );
    } catch (error) {
      // Said from the mutation state; after a conflict the newest version is read and taken in.
      if (isApiError(error) && error.serverCode === 'conflict') setAwaiting(true);
    }
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h2 id={headingId} data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {supplier ? t('suppliers.editHeading', { name: supplier.name }) : t('suppliers.addHeading')}
      </h2>
      <Form form={form} onSubmit={submit}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <TextField
            name="name"
            label={t('suppliers.name')}
            required
            maxLength={SUPPLIER_NAME_MAX}
            autoComplete="organization"
          />
          <TextField
            name="gstin"
            label={t('suppliers.gstin')}
            hint={t('suppliers.gstinHint')}
            maxLength={15}
            autoComplete="off"
          />
          <TextField
            name="drugLicence"
            label={t('suppliers.drugLicence')}
            maxLength={DRUG_LICENCE_MAX}
            autoComplete="off"
          />
          <TextField
            name="phone"
            type="tel"
            label={t('suppliers.phone')}
            maxLength={PHONE_MAX}
            autoComplete="tel"
          />
          <TextField
            name="email"
            type="email"
            label={t('suppliers.email')}
            maxLength={EMAIL_MAX}
            autoComplete="email"
          />
          <TextAreaField
            name="address"
            label={t('suppliers.address')}
            maxLength={ADDRESS_MAX}
            autoComplete="street-address"
          />
        </div>
        {theirs.length > 0 && (
          <div role="status" className="rounded-md border p-3 text-sm">
            <p className="font-medium">{t('suppliers.theySaved')}</p>
            <ul className="mt-1 list-disc pl-5">
              {theirs.map((field) => (
                <li key={field}>
                  {t(`suppliers.${field}`)}: {(latest ?? supplier)?.[field] ?? '–'}
                </li>
              ))}
            </ul>
          </div>
        )}
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
          {/* Until the newest version is taken in after a conflict, a save would only conflict again. */}
          <SubmitButton pending={save.isPending || awaiting}>{t('suppliers.save')}</SubmitButton>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </Form>
    </section>
  );
}
