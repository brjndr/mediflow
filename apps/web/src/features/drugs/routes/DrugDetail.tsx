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
import { DrugFields } from '../components/DrugFields';
import { useDrug, useUpdateDrug } from '../hooks/use-drugs';
import {
  drugFormSchema,
  toFormValues,
  toRequest,
  type DrugField,
  type DrugFormValues,
} from '../schemas';
import type { Drug } from '../types';

const link =
  'inline-flex items-center rounded-sm text-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

const FIELDS: DrugField[] = [
  'type',
  'genericName',
  'brandName',
  'form',
  'strength',
  'unit',
  'schedule',
  'controlled',
  'taxClass',
  'reorderLevel',
];

/** A field of an item as a person reads it. */
function useShown() {
  const { t } = useTranslation('drugs');
  return (drug: Drug, field: DrugField): string => {
    if (field === 'type') return t(`types.${drug.type}`);
    if (field === 'form') return t(`forms.${drug.form}`);
    if (field === 'schedule') return t(`schedules.${drug.schedule}`);
    if (field === 'taxClass') return t(`taxClasses.${drug.taxClass}`);
    if (field === 'controlled') return t(drug.controlled ? 'yes' : 'no');
    const value = drug[field];
    return value === undefined || value === '' ? t('detail.notGiven') : String(value);
  };
}

/** The edit form, working from the item as it was when the form opened. */
function EditForm({
  from,
  latest,
  pending,
  saving,
  onSave,
  onCancel,
}: {
  from: Drug;
  /** The item as it is saved now. Differs from `from` once someone else has changed it. */
  latest: Drug;
  /** No save can be started just now. */
  pending: boolean;
  /** A save is on its way, so the form is not left either. */
  saving: boolean;
  onSave: (values: DrugFormValues, changed: DrugField[]) => void | Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation('drugs');
  const shown = useShown();
  const form = useZodForm(drugFormSchema, toFormValues(from));
  // Read while rendering, which is what keeps it up to date.
  const { dirtyFields } = form.formState;
  // What someone else saved meanwhile goes into the fields this person has not touched, so the
  // form never shows a value that is neither typed nor saved. What was typed stays.
  const { reset } = form;
  useEffect(() => {
    reset(toFormValues(latest), { keepDirtyValues: true });
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
      <DrugFields />
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

/** The item's details, with what a manager may do to them. */
function Details({ drug, refreshFailed }: { drug: Drug; refreshFailed: boolean }) {
  const { t } = useTranslation('drugs');
  const { t: tCommon } = useTranslation();
  const shown = useShown();
  const update = useUpdateDrug(drug.id);
  // The item as it was when the form opened: a refresh in the background never changes what is
  // being typed over.
  const [editing, setEditing] = useState<Drug | null>(null);
  // The version a save is made from. After a conflict it moves to the newest one while the form
  // keeps what was typed, and only the fields the person changed are sent again.
  const [expected, setExpected] = useState(drug.version);
  const [conflict, setConflict] = useState<'none' | 'awaiting' | 'shown'>('none');
  // What was just done, said once in a status line.
  const [done, setDone] = useState<string | null>(null);

  if (conflict === 'awaiting' && drug.version !== expected) {
    setExpected(drug.version);
    setConflict('shown');
  } else if (conflict === 'awaiting' && refreshFailed) {
    // The item could not be read again: stop waiting, so saving can be tried once more.
    setConflict('shown');
  }

  const start = (next: Drug | null) => {
    update.reset();
    setDone(null);
    setConflict('none');
    setExpected(drug.version);
    setEditing(next);
  };

  const save = async (values: DrugFormValues, changed: DrugField[]) => {
    setDone(null);
    // Nothing was changed: there is nothing to send.
    if (changed.length === 0) return start(null);
    const request = toRequest(values);
    // A reorder level that was cleared is sent as null, which removes it; the others as they
    // are, where empty text removes a brand, a strength or a unit.
    const fields = changed.includes('schedule')
      ? [...new Set([...changed, 'controlled' as const])]
      : changed;
    const sent = Object.fromEntries(
      fields.map((field) => [
        field,
        field === 'reorderLevel' && values.reorderLevel === '' ? null : request[field],
      ]),
    );
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
        onSuccess: (saved) =>
          setDone(
            t(archived ? 'detail.archivedDone' : 'detail.restoredDone', {
              name: saved.genericName,
            }),
          ),
      },
    );
  };

  const code = isApiError(update.error) ? update.error.serverCode : undefined;
  const conflicted = code === 'conflict';

  return (
    <section aria-labelledby="drug-details" className="flex flex-col gap-3">
      <h2 id="drug-details" className="text-lg font-semibold">
        {t('detail.details')}
      </h2>
      {drug.archived && <p className="text-sm text-muted-foreground">{t('detail.archivedNote')}</p>}
      {(conflict !== 'none' || conflicted) && (
        <p role="alert" className="text-sm text-destructive">
          {t('detail.conflict')}
        </p>
      )}
      {update.isError && !conflicted && (
        <p role="alert" className="text-sm text-destructive">
          {code === 'drug_exists' ? t('detail.exists') : tCommon(errorMessageKey(update.error))}
        </p>
      )}
      <p role="status" className="text-sm text-muted-foreground">
        {done ?? ''}
      </p>

      {editing ? (
        <EditForm
          from={editing}
          latest={drug}
          // Until the newest version is known after a conflict, a save would only conflict again.
          pending={update.isPending || conflict === 'awaiting'}
          saving={update.isPending}
          onSave={save}
          onCancel={() => start(null)}
        />
      ) : (
        <>
          <dl className="grid max-w-3xl grid-cols-3 gap-x-6 gap-y-3 text-sm">
            {FIELDS.map((field) => (
              <div key={field}>
                <dt className="text-muted-foreground">{t(`form.${field}`)}</dt>
                <dd className="break-words">{shown(drug, field)}</dd>
              </div>
            ))}
          </dl>
          <Can permission="drug:manage">
            <div className="flex flex-wrap gap-3">
              <Button
                variant="outline"
                aria-disabled={update.isPending || undefined}
                onClick={() => start(drug)}
              >
                {t('detail.edit')}
              </Button>
              <Button
                variant="outline"
                aria-disabled={update.isPending || undefined}
                onClick={() => setArchived(!drug.archived)}
              >
                {t(drug.archived ? 'detail.restore' : 'detail.archive')}
              </Button>
            </div>
          </Can>
        </>
      )}
    </section>
  );
}

function DrugScreen() {
  const { t } = useTranslation('drugs');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const { drugId = '' } = useParams();
  const drug = useDrug(drugId);

  const back = (
    <Link to="/drugs" className={link}>
      {t('backToList')}
    </Link>
  );

  if (drug.isPending) return <PageSkeleton label={t('detail.loading')} />;

  // Only when there is nothing to show: a failed background refresh leaves the item on screen.
  if (drug.data === undefined) {
    // One answer for an item that does not exist and one of another hospital.
    if (isApiError(drug.error) && drug.error.code === 'not_found') {
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
        description={tCommon(errorMessageKey(drug.error))}
        actions={
          isApiError(drug.error) && drug.error.code === 'forbidden' ? undefined : (
            <Button variant="outline" onClick={() => void drug.refetch()}>
              {tCommon('grid.retry')}
            </Button>
          )
        }
      />
    );
  }

  const record = drug.data;
  const badge = 'ml-2 rounded-full border px-2 py-0.5 text-xs font-medium';

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6">
      <div className="space-y-1">
        {back}
        <h1 className="text-2xl font-semibold tracking-tight break-words">{record.genericName}</h1>
        <p className="text-muted-foreground">
          {[record.brandName, t(`forms.${record.form}`), record.strength]
            .filter(Boolean)
            .join(' · ')}
          {record.controlled && <span className={badge}>{t('detail.controlled')}</span>}
          {record.archived && <span className={badge}>{t('detail.archived')}</span>}
        </p>
      </div>
      <Details key={record.id} drug={record} refreshFailed={drug.isError && !drug.isFetching} />
    </div>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function DrugDetail() {
  return (
    <DesktopOnly>
      <DrugScreen />
    </DesktopOnly>
  );
}
