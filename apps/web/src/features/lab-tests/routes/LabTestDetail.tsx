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
import { LabTestFields, type KnownService } from '../components/LabTestFields';
import { Ranges } from '../components/Ranges';
import { useLabTest, useUpdateLabTest } from '../hooks/use-lab-tests';
import {
  labTestFormSchema,
  toFormValues,
  toRequest,
  type LabTestField,
  type LabTestFormValues,
} from '../schemas';
import type { LabTest } from '../types';

const link =
  'inline-flex items-center rounded-sm text-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

/** The fields a test of this kind has. A panel has no result of its own; a test no components. */
function fieldsOf(test: Pick<LabTest, 'kind' | 'resultType'>): LabTestField[] {
  const panel = test.kind === 'panel';
  return [
    'name',
    'department',
    ...(panel ? [] : (['resultType'] as const)),
    ...(!panel && test.resultType === 'numeric' ? (['unit'] as const) : []),
    'sampleType',
    'container',
    'turnaroundHours',
    'serviceId',
    ...(panel ? (['componentIds'] as const) : []),
  ];
}
/** Every field the edit form can change, whatever is on screen. */
const EDITABLE: LabTestField[] = [
  'name',
  'department',
  'resultType',
  'unit',
  'sampleType',
  'container',
  'turnaroundHours',
  'serviceId',
  'componentIds',
];

const knownService = (test: LabTest): KnownService[] =>
  test.serviceId ? [{ id: test.serviceId, name: test.serviceName ?? test.serviceId }] : [];

/** A field of a test as a person reads it. */
function useShown() {
  const { t } = useTranslation('lab_tests');
  return (test: LabTest, field: LabTestField): string => {
    if (field === 'department') return t(`departments.${test.department}`);
    if (field === 'kind') return t(`kinds.${test.kind}`);
    if (field === 'resultType') return t(`resultTypes.${test.resultType}`);
    if (field === 'sampleType') return t(`sampleTypes.${test.sampleType}`);
    if (field === 'turnaroundHours') return t('hours', { count: test.turnaroundHours });
    if (field === 'serviceId') {
      if (!test.serviceId) return t('detail.notGiven');
      return test.serviceName ?? t('detail.linked');
    }
    if (field === 'componentIds') {
      return test.components.map((component) => component.name).join(', ') || t('detail.notGiven');
    }
    const value = test[field];
    return value === undefined || value === '' ? t('detail.notGiven') : String(value);
  };
}

/** The edit form, working from the test as it was when the form opened. */
function EditForm({
  from,
  latest,
  pending,
  saving,
  onSave,
  onCancel,
}: {
  from: LabTest;
  /** The test as it is saved now. Differs from `from` once someone else has changed it. */
  latest: LabTest;
  /** No save can be started just now. */
  pending: boolean;
  /** A save is on its way, so the form is not left either. */
  saving: boolean;
  onSave: (values: LabTestFormValues, changed: LabTestField[]) => void | Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation('lab_tests');
  const shown = useShown();
  const form = useZodForm(labTestFormSchema, toFormValues(from));
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
  const theirs = EDITABLE.filter(
    (field) => dirtyFields[field] === true && shown(latest, field) !== shown(from, field),
  );
  return (
    <Form
      form={form}
      onSubmit={(values) =>
        onSave(
          values,
          EDITABLE.filter((field) => dirtyFields[field] === true),
        )
      }
      className="flex max-w-xl flex-col gap-4"
    >
      <LabTestFields
        components={[...from.components, ...latest.components]}
        services={[...knownService(from), ...knownService(latest)]}
      />
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

/** The test's details, with what a manager may do to them. */
function Details({ test, refreshFailed }: { test: LabTest; refreshFailed: boolean }) {
  const { t } = useTranslation('lab_tests');
  const { t: tCommon } = useTranslation();
  const shown = useShown();
  const update = useUpdateLabTest(test.id);
  // The test as it was when the form opened: a refresh in the background never changes what is
  // being typed over.
  const [editing, setEditing] = useState<LabTest | null>(null);
  // The version a save is made from. After a conflict it moves to the newest one while the form
  // keeps what was typed, and only the fields the person changed are sent again.
  const [expected, setExpected] = useState(test.version);
  const [conflict, setConflict] = useState<'none' | 'awaiting' | 'shown'>('none');
  // What was just done, said once in a status line.
  const [done, setDone] = useState<string | null>(null);

  if (conflict === 'awaiting' && test.version !== expected) {
    setExpected(test.version);
    setConflict('shown');
  } else if (conflict === 'awaiting' && refreshFailed) {
    // The test could not be read again: stop waiting, so saving can be tried once more.
    setConflict('shown');
  }

  const start = (next: LabTest | null) => {
    update.reset();
    setDone(null);
    setConflict('none');
    setExpected(test.version);
    setEditing(next);
  };

  const save = async (values: LabTestFormValues, changed: LabTestField[]) => {
    setDone(null);
    // Nothing was changed: there is nothing to send.
    if (changed.length === 0) return start(null);
    const request = toRequest(values);
    // A result that becomes text loses its unit, so the unit goes with the result type.
    const fields = changed.includes('resultType')
      ? [...new Set([...changed, 'unit' as const])]
      : changed;
    const sent = Object.fromEntries(fields.map((field) => [field, request[field]]));
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
            t(archived ? 'detail.archivedDone' : 'detail.restoredDone', { name: saved.name }),
          ),
      },
    );
  };

  const code = isApiError(update.error) ? update.error.serverCode : undefined;
  const conflicted = code === 'conflict';
  const refused =
    code === 'lab_test_has_ranges'
      ? t('detail.hasRanges')
      : code === 'lab_test_in_panel'
        ? t('detail.inPanel')
        : null;

  return (
    <section aria-labelledby="lab-test-details" className="flex flex-col gap-3">
      <h2 id="lab-test-details" className="text-lg font-semibold">
        {t('detail.details')}
      </h2>
      {test.archived && <p className="text-sm text-muted-foreground">{t('detail.archivedNote')}</p>}
      {(conflict !== 'none' || conflicted) && (
        <p role="alert" className="text-sm text-destructive">
          {t('detail.conflict')}
        </p>
      )}
      {update.isError && !conflicted && (
        <p role="alert" className="text-sm text-destructive">
          {refused ?? tCommon(errorMessageKey(update.error))}
        </p>
      )}
      <p role="status" className="text-sm text-muted-foreground">
        {done ?? ''}
      </p>

      {editing ? (
        <EditForm
          from={editing}
          latest={test}
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
              <dd className="break-words">{test.code}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('form.kind')}</dt>
              <dd>{shown(test, 'kind')}</dd>
            </div>
            {fieldsOf(test)
              .filter((field) => field !== 'name' && field !== 'componentIds')
              .map((field) => (
                <div key={field}>
                  <dt className="text-muted-foreground">{t(`form.${field}`)}</dt>
                  <dd className="break-words">{shown(test, field)}</dd>
                </div>
              ))}
          </dl>
          {test.kind === 'panel' && (
            <div className="text-sm">
              <h3 className="text-muted-foreground">{t('form.componentIds')}</h3>
              <ol aria-label={t('form.componentIds')} className="list-decimal pl-5">
                {test.components.map((component) => (
                  <li key={component.id}>
                    <Link to={`/lab-tests/${component.id}`} className={link}>
                      {component.name}
                    </Link>
                    <span className="text-muted-foreground"> · {component.code}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <Can permission="labTest:manage">
            <div className="flex flex-wrap gap-3">
              <Button
                variant="outline"
                aria-disabled={update.isPending || undefined}
                onClick={() => start(test)}
              >
                {t('detail.edit')}
              </Button>
              <Button
                variant="outline"
                aria-disabled={update.isPending || undefined}
                onClick={() => setArchived(!test.archived)}
              >
                {t(test.archived ? 'detail.restore' : 'detail.archive')}
              </Button>
            </div>
          </Can>
        </>
      )}
    </section>
  );
}

function LabTestScreen() {
  const { t } = useTranslation('lab_tests');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const { labTestId = '' } = useParams();
  const test = useLabTest(labTestId);

  const back = (
    <Link to="/lab-tests" className={link}>
      {t('backToList')}
    </Link>
  );

  if (test.isPending) return <PageSkeleton label={t('detail.loading')} />;

  // Only when there is nothing to show: a failed background refresh leaves the test on screen.
  if (test.data === undefined) {
    // One answer for a test that does not exist and one of another hospital.
    if (isApiError(test.error) && test.error.code === 'not_found') {
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
        description={tCommon(errorMessageKey(test.error))}
        actions={
          isApiError(test.error) && test.error.code === 'forbidden' ? undefined : (
            <Button variant="outline" onClick={() => void test.refetch()}>
              {tCommon('grid.retry')}
            </Button>
          )
        }
      />
    );
  }

  const record = test.data;
  const badge = 'ml-2 rounded-full border px-2 py-0.5 text-xs font-medium';

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6">
      <div className="space-y-1">
        {back}
        <h1 className="text-2xl font-semibold tracking-tight break-words">{record.name}</h1>
        <p className="text-muted-foreground">
          {[record.code, t(`departments.${record.department}`)].join(' · ')}
          {record.kind === 'panel' && <span className={badge}>{t('kinds.panel')}</span>}
          {record.archived && <span className={badge}>{t('detail.archived')}</span>}
        </p>
      </div>
      <Details key={record.id} test={record} refreshFailed={test.isError && !test.isFetching} />
      {record.kind === 'test' && record.resultType === 'numeric' && (
        <Ranges
          key={`ranges-${record.id}`}
          labTestId={record.id}
          unit={record.unit}
          archived={record.archived}
        />
      )}
    </div>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function LabTestDetail() {
  return (
    <DesktopOnly>
      <LabTestScreen />
    </DesktopOnly>
  );
}
