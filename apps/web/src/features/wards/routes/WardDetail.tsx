import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Can } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { Form, SubmitButton, useZodForm } from '@/shared/ui/form';
import { PageSkeleton } from '@/shared/ui/page-skeleton';
import { SystemPage } from '@/shared/ui/system-page';
import { refusalKey } from '../components/refusal';
import { Rooms } from '../components/Rooms';
import { WardFields } from '../components/WardFields';
import { useUpdateWard, useWard } from '../hooks/use-wards';
import { toWardFormValues, wardFormSchema, type WardField, type WardFormValues } from '../schemas';
import type { Ward } from '../types';

const link =
  'inline-flex items-center rounded-sm text-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

const FIELDS: WardField[] = ['name', 'floor', 'departmentId'];

const knownDepartment = (ward: Ward) =>
  ward.departmentId ? [{ id: ward.departmentId, name: ward.departmentName ?? '' }] : [];

/** A field of a ward as a person reads it. */
function useShown() {
  const { t } = useTranslation('wards');
  return (ward: Ward, field: WardField): string => {
    const value = field === 'departmentId' ? ward.departmentName : ward[field];
    return value === undefined || value === '' ? t('notGiven') : value;
  };
}

/** The edit form, working from the ward as it was when the form opened. */
function EditForm({
  from,
  latest,
  pending,
  saving,
  onSave,
  onCancel,
}: {
  from: Ward;
  /** The ward as it is saved now. Differs from `from` once someone else has changed it. */
  latest: Ward;
  /** No save can be started just now. */
  pending: boolean;
  /** A save is on its way, so the form is not left either. */
  saving: boolean;
  onSave: (values: WardFormValues, changed: WardField[]) => void | Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation('wards');
  const shown = useShown();
  const form = useZodForm(wardFormSchema, toWardFormValues(from));
  // Read while rendering, which is what keeps it up to date.
  const { dirtyFields } = form.formState;
  // What someone else saved meanwhile goes into the fields this person has not touched, so the
  // form never shows a value that is neither typed nor saved. What was typed stays.
  const { reset } = form;
  useEffect(() => {
    reset(toWardFormValues(latest), { keepDirtyValues: true });
  }, [reset, latest]);
  // Fields this person changed that someone else has changed too: saving puts this person's
  // value over theirs, so theirs is shown before that happens.
  const theirs = FIELDS.filter(
    (field) => dirtyFields[field] === true && shown(latest, field) !== shown(from, field),
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
      <WardFields known={[...knownDepartment(from), ...knownDepartment(latest)]} />
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
        <Button
          type="button"
          variant="outline"
          aria-disabled={saving || undefined}
          onClick={onCancel}
        >
          {t('form.cancel')}
        </Button>
      </div>
    </Form>
  );
}

/** The ward's details, with what a manager may do to them. */
function Details({ ward, refreshFailed }: { ward: Ward; refreshFailed: boolean }) {
  const { t } = useTranslation('wards');
  const { t: tCommon } = useTranslation();
  const shown = useShown();
  const update = useUpdateWard(ward.id);
  // The ward as it was when the form opened: a refresh in the background never changes what is
  // being typed over.
  const [editing, setEditing] = useState<Ward | null>(null);
  // The version a save is made from. After a conflict it moves to the newest one while the form
  // keeps what was typed, and only the fields the person changed are sent again.
  const [expected, setExpected] = useState(ward.version);
  const [conflict, setConflict] = useState<'none' | 'awaiting' | 'shown'>('none');
  // What was just done, said once in a status line.
  const [done, setDone] = useState<string | null>(null);

  if (conflict === 'awaiting' && ward.version !== expected) {
    setExpected(ward.version);
    setConflict('shown');
  } else if (conflict === 'awaiting' && refreshFailed) {
    // The ward could not be read again: stop waiting, so saving can be tried once more.
    setConflict('shown');
  }

  const start = (next: Ward | null) => {
    update.reset();
    setDone(null);
    setConflict('none');
    setExpected(ward.version);
    setEditing(next);
  };

  const save = async (values: WardFormValues, changed: WardField[]) => {
    setDone(null);
    // Nothing was changed: there is nothing to send.
    if (changed.length === 0) return start(null);
    // Empty text removes the floor or the department.
    const sent = Object.fromEntries(changed.map((field) => [field, values[field]]));
    try {
      await update.mutateAsync({ body: { ...sent, expectedVersion: expected } });
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
        onSuccess: ({ ward: saved }) =>
          setDone(
            t(archived ? 'detail.archivedDone' : 'detail.restoredDone', { name: saved.name }),
          ),
      },
    );
  };

  const conflicted = isApiError(update.error) && update.error.serverCode === 'conflict';
  const refused = refusalKey(update.error);

  return (
    <section aria-labelledby="ward-details" className="flex flex-col gap-3">
      <h2 id="ward-details" className="text-lg font-semibold">
        {t('detail.details')}
      </h2>
      {ward.archived && <p className="text-sm text-muted-foreground">{t('detail.archivedNote')}</p>}
      {(conflict !== 'none' || conflicted) && (
        <p role="alert" className="text-sm text-destructive">
          {t('detail.conflict')}
        </p>
      )}
      {update.isError && !conflicted && (
        <p role="alert" className="text-sm text-destructive">
          {refused ? t(refused) : tCommon(errorMessageKey(update.error))}
        </p>
      )}
      <p role="status" className="text-sm text-muted-foreground">
        {done ?? ''}
      </p>

      {editing ? (
        <EditForm
          from={editing}
          latest={ward}
          // Until the newest version is known after a conflict, a save would only conflict again.
          pending={update.isPending || conflict === 'awaiting'}
          saving={update.isPending}
          onSave={save}
          onCancel={() => start(null)}
        />
      ) : (
        <>
          <dl className="grid max-w-3xl grid-cols-3 gap-x-6 gap-y-3 text-sm">
            <div>
              <dt className="text-muted-foreground">{t('form.code')}</dt>
              <dd className="break-words">{ward.code}</dd>
            </div>
            {FIELDS.filter((field) => field !== 'name').map((field) => (
              <div key={field}>
                <dt className="text-muted-foreground">{t(`form.${field}`)}</dt>
                <dd className="break-words">{shown(ward, field)}</dd>
              </div>
            ))}
            <div>
              <dt className="text-muted-foreground">{t('columns.rooms')}</dt>
              <dd>{ward.roomCount}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('columns.beds')}</dt>
              <dd>{ward.bedCount}</dd>
            </div>
          </dl>
          <Can permission="ward:manage">
            <div className="flex flex-wrap gap-3">
              <Button
                variant="outline"
                aria-disabled={update.isPending || undefined}
                onClick={() => start(ward)}
              >
                {t('detail.edit')}
              </Button>
              <Button
                variant="outline"
                aria-disabled={update.isPending || undefined}
                onClick={() => setArchived(!ward.archived)}
              >
                {t(ward.archived ? 'detail.restore' : 'detail.archive')}
              </Button>
            </div>
          </Can>
        </>
      )}
    </section>
  );
}

function WardScreen() {
  const { t } = useTranslation('wards');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const { wardId = '' } = useParams();
  const ward = useWard(wardId);

  const back = (
    <Link to="/wards" className={link}>
      {t('backToList')}
    </Link>
  );

  if (ward.isPending) return <PageSkeleton label={t('detail.loading')} />;

  // Only when there is nothing to show: a failed background refresh leaves the ward on screen.
  if (ward.data === undefined) {
    // One answer for a ward that does not exist and one of another hospital.
    if (isApiError(ward.error) && ward.error.code === 'not_found') {
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
        description={tCommon(errorMessageKey(ward.error))}
        actions={
          isApiError(ward.error) && ward.error.code === 'forbidden' ? undefined : (
            <Button variant="outline" onClick={() => void ward.refetch()}>
              {tCommon('grid.retry')}
            </Button>
          )
        }
      />
    );
  }

  const record = ward.data.ward;
  const badge = 'ml-2 rounded-full border px-2 py-0.5 text-xs font-medium';

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6">
      <div className="space-y-1">
        {back}
        <h1 className="text-2xl font-semibold tracking-tight break-words">{record.name}</h1>
        <p className="text-muted-foreground">
          {record.code}
          {record.archived && <span className={badge}>{t('detail.archived')}</span>}
        </p>
      </div>
      <Details key={record.id} ward={record} refreshFailed={ward.isError && !ward.isFetching} />
      <Rooms key={`rooms-${record.id}`} detail={ward.data} />
    </div>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function WardDetail() {
  return (
    <DesktopOnly>
      <WardScreen />
    </DesktopOnly>
  );
}
