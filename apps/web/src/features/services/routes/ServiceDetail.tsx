import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Can } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { Form, SubmitButton, useZodForm } from '@/shared/ui/form';
import { PageSkeleton } from '@/shared/ui/page-skeleton';
import { SystemPage } from '@/shared/ui/system-page';
import { Prices } from '../components/Prices';
import { ServiceFields } from '../components/ServiceFields';
import { useService, useUpdateService } from '../hooks/use-services';
import { serviceFormSchema, type ServiceField, type ServiceFormValues } from '../schemas';
import type { Service } from '../types';

const link =
  'inline-flex items-center rounded-sm text-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

/** The edit form, working from the service as it was when the form opened. */
function EditForm({
  from,
  latest,
  pending,
  saving,
  onSave,
  onCancel,
}: {
  from: Service;
  /** The service as it is saved now. Differs from `from` once someone else has changed it. */
  latest: Service;
  /** No save can be started just now. */
  pending: boolean;
  /** A save is on its way, so the form is not left either. */
  saving: boolean;
  onSave: (values: ServiceFormValues, changed: ServiceField[]) => void | Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation('services');
  const form = useZodForm(serviceFormSchema, {
    name: from.name,
    category: from.category,
    taxClass: from.taxClass,
    description: from.description ?? '',
  });
  // Read while rendering, which is what keeps it up to date.
  const { dirtyFields } = form.formState;
  const FIELDS: ServiceField[] = ['name', 'category', 'taxClass', 'description'];
  const shown = (service: Service, field: ServiceField) =>
    field === 'category'
      ? t(`categories.${service.category}`)
      : field === 'taxClass'
        ? t(`taxClasses.${service.taxClass}`)
        : (service[field] ?? '') || t('detail.notGiven');
  // Fields this person changed that someone else has changed too: saving puts this person's
  // value over theirs, so theirs is shown before that happens.
  const theirs = FIELDS.filter(
    (field) => dirtyFields[field] === true && (latest[field] ?? '') !== (from[field] ?? ''),
  );
  return (
    <Form
      form={form}
      onSubmit={(values) =>
        onSave(
          values,
          FIELDS.filter((field) => dirtyFields[field] === true),
        )
      }
      className="flex max-w-xl flex-col gap-4"
    >
      <ServiceFields />
      {theirs.length > 0 && (
        <div role="status" className="rounded-md border p-3 text-sm">
          <p className="font-medium">{t('detail.theySaved')}</p>
          <ul className="mt-1 list-disc pl-5">
            {theirs.map((field) => (
              <li key={field}>
                {t(`form.${field}`)}: {shown(latest, field)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <SubmitButton pending={pending}>{t('form.save')}</SubmitButton>
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
          {t('form.cancel')}
        </Button>
      </div>
    </Form>
  );
}

/** The service's own details, with what a manager may do to them. */
function Details({ service }: { service: Service }) {
  const { t } = useTranslation('services');
  const { t: tCommon } = useTranslation();
  const update = useUpdateService(service.id);
  // The service as it was when the form opened: a refresh in the background never changes what
  // is being typed over.
  const [editing, setEditing] = useState<Service | null>(null);
  // The version a save is made from. After a conflict it moves to the newest one while the form
  // keeps what was typed, and only the fields the person changed are sent again.
  const [expected, setExpected] = useState(service.version);
  const [conflict, setConflict] = useState<'none' | 'awaiting' | 'shown'>('none');
  // What was just done, said once in a status line.
  const [done, setDone] = useState<string | null>(null);

  if (conflict === 'awaiting' && service.version !== expected) {
    setExpected(service.version);
    setConflict('shown');
  }

  const start = (next: Service | null) => {
    update.reset();
    setDone(null);
    setConflict('none');
    setExpected(service.version);
    setEditing(next);
  };

  const save = async (values: ServiceFormValues, changed: ServiceField[]) => {
    setDone(null);
    // Nothing was changed: there is nothing to send.
    if (changed.length === 0) return start(null);
    try {
      await update.mutateAsync({
        body: {
          ...Object.fromEntries(changed.map((field) => [field, values[field]])),
          expectedVersion: expected,
        },
      });
      setEditing(null);
      setConflict('none');
      setDone(t('detail.saved'));
    } catch (error) {
      if (isApiError(error) && error.serverCode === 'conflict') setConflict('awaiting');
    }
  };

  const setArchived = (archived: boolean) => {
    setDone(null);
    update.mutate(
      { archived },
      {
        onSuccess: (saved) =>
          setDone(
            t(archived ? 'detail.archivedDone' : 'detail.restoredDone', { name: saved.name }),
          ),
      },
    );
  };

  const conflicted = isApiError(update.error) && update.error.serverCode === 'conflict';

  return (
    <section aria-labelledby="service-details" className="flex flex-col gap-3">
      <h2 id="service-details" className="text-lg font-semibold">
        {t('detail.details')}
      </h2>
      {service.archived && (
        <p className="text-sm text-muted-foreground">{t('detail.archivedNote')}</p>
      )}
      {(conflict !== 'none' || conflicted) && (
        <p role="alert" className="text-sm text-destructive">
          {t('detail.conflict')}
        </p>
      )}
      {update.isError && !conflicted && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(update.error))}
        </p>
      )}
      <p role="status" className="text-sm text-muted-foreground">
        {done ?? ''}
      </p>

      {editing ? (
        <EditForm
          from={editing}
          latest={service}
          saving={update.isPending}
          // Until the newest version is known after a conflict, a save would only conflict again.
          pending={update.isPending || conflict === 'awaiting'}
          onSave={save}
          onCancel={() => start(null)}
        />
      ) : (
        <>
          <dl className="grid max-w-2xl grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <div>
              <dt className="text-muted-foreground">{t('columns.code')}</dt>
              <dd className="break-words">{service.code}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('columns.category')}</dt>
              <dd>{t(`categories.${service.category}`)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('columns.taxClass')}</dt>
              <dd>{t(`taxClasses.${service.taxClass}`)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('form.description')}</dt>
              <dd className="break-words">{service.description || t('detail.notGiven')}</dd>
            </div>
          </dl>
          <Can permission="service:manage">
            <div className="flex flex-wrap gap-3">
              <Button variant="outline" disabled={update.isPending} onClick={() => start(service)}>
                {t('detail.edit')}
              </Button>
              <Button
                variant="outline"
                disabled={update.isPending}
                onClick={() => setArchived(!service.archived)}
              >
                {t(service.archived ? 'detail.restore' : 'detail.archive')}
              </Button>
            </div>
          </Can>
        </>
      )}
    </section>
  );
}

function ServiceScreen() {
  const { t } = useTranslation('services');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const { serviceId = '' } = useParams();
  const service = useService(serviceId);

  const back = (
    <Link to="/services" className={link}>
      {t('backToList')}
    </Link>
  );

  if (service.isPending) return <PageSkeleton label={t('detail.loading')} />;

  // Only when there is nothing to show: a failed background refresh leaves the service on screen.
  if (service.data === undefined) {
    // One answer for a service that does not exist and one of another hospital.
    if (isApiError(service.error) && service.error.code === 'not_found') {
      return (
        <SystemPage
          title={t('detail.notFoundTitle')}
          description={t('detail.notFoundBody')}
          actions={back}
        />
      );
    }
    return (
      <SystemPage
        alert
        title={t('detail.errorTitle')}
        description={tCommon(errorMessageKey(service.error))}
        actions={
          isApiError(service.error) && service.error.code === 'forbidden' ? undefined : (
            <Button variant="outline" onClick={() => void service.refetch()}>
              {tCommon('grid.retry')}
            </Button>
          )
        }
      />
    );
  }

  const record = service.data;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6">
      <div className="space-y-1">
        {back}
        <h1 className="text-2xl font-semibold tracking-tight break-words">{record.name}</h1>
        <p className="text-muted-foreground">
          {record.code}
          {record.archived && (
            <span className="ml-2 rounded-full border px-2 py-0.5 text-xs font-medium">
              {t('detail.archived')}
            </span>
          )}
        </p>
      </div>
      <Details key={record.id} service={record} />
      <Prices key={`prices-${record.id}`} serviceId={record.id} archived={record.archived} />
    </div>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function ServiceDetail() {
  return (
    <DesktopOnly>
      <ServiceScreen />
    </DesktopOnly>
  );
}
