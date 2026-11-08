import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Form, SubmitButton, TextAreaField, useZodForm } from '@/shared/ui/form';
import { PageSkeleton } from '@/shared/ui/page-skeleton';
import { SystemPage } from '@/shared/ui/system-page';
import { useFormatters } from '@/tenancy';
import { PatientSearch } from '../components/PatientSearch';
import { useMergePatients, useMergePreview } from '../hooks/use-merge';
import { usePatient } from '../hooks/use-patient';
import { mergeFormSchema, type MergeFormValues } from '../schemas';
import type { PatientMerge, PatientRecord } from '../types';

const REFUSED: Record<string, string> = {
  conflict: 'merge.errors.conflict',
  patient_merged: 'merge.errors.merged',
  same_patient: 'merge.errors.same',
};

function RecordCard({ title, record }: { title: string; record: PatientRecord }) {
  const { t } = useTranslation('patients');
  const format = useFormatters();
  return (
    <section
      aria-label={title}
      className="flex min-w-0 flex-col gap-1 rounded-md border p-3 text-sm"
    >
      <h2 className="font-semibold">{title}</h2>
      <p className="break-words text-base font-medium">
        {record.firstName} {record.lastName}
      </p>
      <dl className="flex flex-col gap-0.5">
        <div className="flex gap-2">
          <dt className="text-muted-foreground">{t('columns.mrn')}</dt>
          <dd>{record.mrn}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">{t('columns.dob')}</dt>
          <dd>{format.calendarDate(record.dob)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">{t('columns.gender')}</dt>
          <dd>{t(`gender.${record.gender}`)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">{t('columns.phone')}</dt>
          <dd>{record.phone}</dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * Merges a duplicate record into this one (#558). This record stays; the one chosen is marked as
 * merged, keeps its MRN, leaves search and can no longer be changed, and every module moves its
 * rows over. There is no unmerge, so the reason is asked for and the person confirms.
 */
export default function PatientMerge() {
  const { t } = useTranslation('patients');
  const { t: tCommon } = useTranslation();
  const { id = '' } = useParams();
  const target = usePatient(id);
  const [done, setDone] = useState<PatientMerge>();

  if (target.isPending) return <PageSkeleton label={t('detail.loading')} />;
  if (target.data === undefined) {
    const missing = isApiError(target.error) && target.error.code === 'not_found';
    return (
      <SystemPage
        alert={!missing}
        title={missing ? t('detail.notFoundTitle') : t('detail.errorTitle')}
        description={missing ? t('detail.notFoundBody') : tCommon(errorMessageKey(target.error))}
      />
    );
  }
  const record = target.data;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <Link
        to={`/patients/${record.id}`}
        className="inline-flex items-center self-start rounded-sm text-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11"
      >
        {t('merge.back')}
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">{t('merge.heading')}</h1>
      {record.mergedInto !== undefined ? (
        <p role="alert">{t('merge.errors.targetMerged')}</p>
      ) : done ? (
        <MergeDone merge={done} id={record.id} />
      ) : (
        <MergeForm key={record.id} target={record} onDone={setDone} />
      )}
    </div>
  );
}

function MergeDone({ merge, id }: { merge: PatientMerge; id: string }) {
  const { t } = useTranslation('patients');
  return (
    <section className="flex flex-col gap-2">
      <p role="status" className="font-medium">
        {t('merge.done')}
      </p>
      <ul className="list-disc pl-5 text-sm">
        {Object.entries(merge.moved).map(([module, count]) => (
          <li key={module}>
            {t(`merge.modules.${module}`, { defaultValue: module })}: {count}
          </li>
        ))}
      </ul>
      <Link to={`/patients/${id}`} className="font-medium underline">
        {t('merge.toRecord')}
      </Link>
    </section>
  );
}

function MergeForm({
  target,
  onDone,
}: {
  target: PatientRecord;
  onDone: (merge: PatientMerge) => void;
}) {
  const { t } = useTranslation('patients');
  const { t: tCommon } = useTranslation();
  const noteId = useId();
  const [sourceId, setSourceId] = useState('');
  const [asking, setAsking] = useState(false);
  const source = usePatient(sourceId === target.id ? '' : sourceId);
  const merge = useMergePatients(target);
  const preview = useMergePreview(target.id, sourceId);
  const form = useZodForm(mergeFormSchema, { reason: '' });
  const sameChoice = sourceId === target.id;

  const submit = async () => {
    if (!source.data) return;
    merge.reset();
    try {
      onDone(
        await merge.mutateAsync({ source: source.data, reason: form.getValues('reason').trim() }),
      );
    } catch {
      // Said below, from the mutation state.
      setAsking(false);
    }
  };

  const code = isApiError(merge.error) ? merge.error.serverCode : undefined;
  const failure = merge.error
    ? code !== undefined && REFUSED[code]
      ? t(REFUSED[code])
      : tCommon(errorMessageKey(merge.error))
    : undefined;
  const chosen = sourceId !== '' && !sameChoice ? source.data : undefined;

  return (
    <div className="flex flex-col gap-4">
      <p id={noteId} className="text-sm text-muted-foreground">
        {t('merge.note')}
      </p>
      <PatientSearch
        label={t('merge.pick')}
        describedBy={noteId}
        onSelect={(patient) => {
          merge.reset();
          setSourceId(patient.id);
        }}
        required
      />
      {sameChoice && (
        <p role="alert" className="text-sm text-destructive">
          {t('merge.errors.same')}
        </p>
      )}
      {sourceId !== '' && !sameChoice && source.isPending && (
        <p role="status" className="text-sm">
          {t('detail.loading')}
        </p>
      )}
      {sourceId !== '' && !sameChoice && source.isError && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(source.error))}
        </p>
      )}
      {chosen && chosen.mergedInto !== undefined && (
        <p role="alert" className="text-sm text-destructive">
          {t('merge.errors.merged')}
        </p>
      )}
      {chosen && chosen.mergedInto === undefined && (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <RecordCard title={t('merge.keeps')} record={target} />
            <RecordCard title={t('merge.merged')} record={chosen} />
          </div>
          <section aria-label={t('merge.moves')} className="text-sm">
            <h2 className="font-semibold">{t('merge.moves')}</h2>
            {preview.isPending && (
              <p role="status" className="text-muted-foreground">
                {t('merge.movesLoading')}
              </p>
            )}
            {preview.isError && (
              <p role="alert" className="text-destructive">
                {tCommon(errorMessageKey(preview.error))}
              </p>
            )}
            {preview.data &&
              (Object.keys(preview.data.moves).length === 0 ? (
                <p>{t('merge.movesNothing')}</p>
              ) : (
                <ul className="list-disc pl-5">
                  {Object.entries(preview.data.moves).map(([module, count]) => (
                    <li key={module}>
                      {t(`merge.modules.${module}`, { defaultValue: module })}: {count}
                    </li>
                  ))}
                </ul>
              ))}
            <p className="mt-1 text-muted-foreground">{t('merge.permanent')}</p>
          </section>
          <Form
            form={form}
            onSubmit={() => setAsking(true)}
            id="patient-merge-form"
            className="max-w-xl"
          >
            <TextAreaField<MergeFormValues> name="reason" label={t('merge.reason')} required />
            {failure && (
              <p role="alert" className="text-sm text-destructive">
                {failure}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <SubmitButton pending={merge.isPending}>{t('merge.submit')}</SubmitButton>
              <Button type="button" variant="outline" onClick={() => setSourceId('')}>
                {t('merge.change')}
              </Button>
            </div>
          </Form>
          <ConfirmDialog
            open={asking}
            onClose={() => setAsking(false)}
            title={t('merge.confirmTitle')}
            description={t('merge.confirmBody', {
              source: `${chosen.firstName} ${chosen.lastName} (${chosen.mrn})`,
              target: `${target.firstName} ${target.lastName} (${target.mrn})`,
            })}
            cancelLabel={t('merge.cancel')}
            confirmLabel={merge.isPending ? t('merge.submitting') : t('merge.confirm')}
            destructive
            pending={merge.isPending}
            onConfirm={() => void submit()}
          />
        </>
      )}
    </div>
  );
}
