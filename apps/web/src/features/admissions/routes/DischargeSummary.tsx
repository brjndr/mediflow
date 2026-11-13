import { useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useAllowed, usePermission } from '@/access';
import { useSession } from '@/app/session';
import { fillPlaceholders, useTemplateChoices } from '@/features/templates';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Form, SubmitButton, TextAreaField, useZodForm } from '@/shared/ui/form';
import { PrintSheet } from '@/shared/ui/print-sheet';
import { richTextToPlainText } from '@/shared/ui/rich-text';
import { useFormatters, useTenant } from '@/tenancy';
import { SummaryDocument } from '../components/SummaryDocument';
import {
  useAddAddendum,
  useDischargeSummary,
  usePrintSummary,
  useSaveSummary,
  useSignSummary,
  useStay,
} from '../hooks/use-discharge-summary';
import {
  addendumSchema,
  missingForSigning,
  summaryDraftSchema,
  SUMMARY_TEXT_MAX,
  type AddendumValues,
  type SummaryDraftOutput,
  type SummaryDraftValues,
} from '../schemas';
import { SUMMARY_SECTIONS, type Admission, type DischargeSummary } from '../types';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The server's refusals of saving and signing, by code, in words of their own. */
const REFUSED: Record<string, string> = {
  conflict: 'summary.refused.conflict',
  summary_signed: 'summary.refused.signed',
  summary_incomplete: 'summary.refused.incomplete',
  summary_not_signed: 'summary.refused.notSigned',
  admission_not_found: 'summary.refused.gone',
};

function useRefusal() {
  const { t } = useTranslation('admissions');
  const { t: tCommon } = useTranslation();
  return (error: unknown): string => {
    const key = isApiError(error) ? REFUSED[error.serverCode ?? ''] : undefined;
    return key ? t(key) : tCommon(errorMessageKey(error));
  };
}

/**
 * The discharge summary of a stay (`admissions/:admissionId/summary`, DS-02, #165), for
 * `dischargeSummary:read`: a draft the doctor writes (a template can start the course), signs
 * once, and prints. A signed summary is never changed; a correction is an addendum. The address
 * holds the admission's id and nothing about the patient. Planned API: the real one has none
 * (#169), so there the screen reports it as unavailable.
 */
export default function DischargeSummaryPage() {
  const { t } = useTranslation('admissions');
  const { t: tCommon } = useTranslation();
  const raw = useParams().admissionId ?? '';
  const admissionId = ID.test(raw) ? raw : '';
  const stay = useStay(admissionId);
  const found = useDischargeSummary(admissionId);
  const unavailable = (query: { isError: boolean; error: unknown }) =>
    query.isError &&
    isApiError(query.error) &&
    [403, 404, 405].includes((query.error as { status?: number }).status ?? 0);
  const missing = admissionId === '' || unavailable(stay) || unavailable(found);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('summary.heading')}</h1>
      <Link
        to="/admissions"
        className="inline-flex w-fit items-center rounded-sm text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11"
      >
        {t('summary.back')}
      </Link>
      {missing ? (
        <p role="alert">{t('summary.unavailable')}</p>
      ) : stay.isPending || found.isPending ? (
        <p className="text-sm text-muted-foreground">{tCommon('app.loading')}</p>
      ) : stay.isError || found.isError || !stay.data ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert">{tCommon(errorMessageKey(stay.error ?? found.error))}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void stay.refetch();
              void found.refetch();
            }}
          >
            {tCommon('app.retry')}
          </Button>
        </div>
      ) : found.data?.status === 'signed' ? (
        <SignedView admission={stay.data} summary={found.data} />
      ) : (
        <DraftView admission={stay.data} summary={found.data ?? null} />
      )}
    </div>
  );
}

function SignedView({ admission, summary }: { admission: Admission; summary: DischargeSummary }) {
  const { t } = useTranslation('admissions');
  const canSign = usePermission('dischargeSummary:sign');
  const printing = usePrintSummary(admission.id);
  const refusal = useRefusal();
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          aria-disabled={printing.busy || undefined}
          onClick={printing.print}
        >
          {t('summary.print')}
        </Button>
        {printing.error && (
          <p role="alert" className="text-sm text-destructive">
            {refusal(printing.error)}
          </p>
        )}
      </div>
      <SummaryDocument admission={admission} summary={summary} />
      {canSign && <AddendumForm admissionId={admission.id} version={summary.version} />}
      {printing.sheet !== null && (
        <PrintSheet key={printing.sheet} onDone={printing.done}>
          <SummaryDocument admission={admission} summary={summary} print />
        </PrintSheet>
      )}
    </>
  );
}

function AddendumForm({ admissionId, version }: { admissionId: string; version: number }) {
  const { t } = useTranslation('admissions');
  const add = useAddAddendum(admissionId);
  const refusal = useRefusal();
  const form = useZodForm(addendumSchema, { body: '' });
  const [done, setDone] = useState('');
  return (
    <section className="flex flex-col gap-2 rounded-lg border p-4" aria-labelledby="addendum-h">
      <h2 id="addendum-h" className="font-semibold">
        {t('summary.addendumForm.heading')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('summary.addendumForm.hint')}</p>
      <Form
        form={form}
        onSubmit={async (values: AddendumValues) => {
          setDone('');
          try {
            await add.mutateAsync({ body: values.body.trim(), version });
            form.reset({ body: '' });
            setDone(t('summary.addendumForm.done'));
          } catch {
            // The error is shown below, from the mutation.
          }
        }}
      >
        <TextAreaField<AddendumValues>
          name="body"
          label={t('summary.addendumForm.label')}
          required
        />
        <div className="flex items-center gap-3">
          <SubmitButton pending={add.isPending}>{t('summary.addendumForm.submit')}</SubmitButton>
        </div>
      </Form>
      <p role="status" className="text-sm">
        {done}
      </p>
      {add.isError && (
        <p role="alert" className="text-sm text-destructive">
          {refusal(add.error)}
        </p>
      )}
    </section>
  );
}

const draftValues = (summary: DischargeSummary | null): SummaryDraftValues => ({
  diagnoses: summary?.diagnoses ?? '',
  procedures: summary?.procedures ?? '',
  course: summary?.course ?? '',
  results: summary?.results ?? '',
  medicines: summary?.medicines ?? '',
  followUp: summary?.followUp ?? '',
});

function DraftView({
  admission,
  summary,
}: {
  admission: Admission;
  summary: DischargeSummary | null;
}) {
  const { t } = useTranslation('admissions');
  const canWrite = usePermission('dischargeSummary:create');
  const canSign = usePermission('dischargeSummary:sign');
  const save = useSaveSummary(admission.id);
  const sign = useSignSummary(admission.id);
  const refusal = useRefusal();
  const form = useZodForm(summaryDraftSchema, draftValues(summary));
  const [template, setTemplate] = useState<{ id: string; version: number } | undefined>(
    summary?.template,
  );
  const [confirming, setConfirming] = useState(false);
  const [lacking, setLacking] = useState<string[]>([]);
  const [done, setDone] = useState('');
  const version = useRef(summary?.version);

  if (!canWrite) {
    return <p>{summary ? t('summary.draftElsewhere') : t('summary.none')}</p>;
  }

  const saveDraft = async (values: SummaryDraftOutput): Promise<DischargeSummary> => {
    const saved = await save.mutateAsync({
      ...values,
      ...(template ? { template } : {}),
      ...(version.current !== undefined ? { version: version.current } : {}),
    });
    version.current = saved.version;
    form.reset(draftValues(saved));
    return saved;
  };

  const onSave = async (values: SummaryDraftOutput) => {
    setDone('');
    try {
      await saveDraft(values);
      setDone(t('summary.saved'));
    } catch {
      // Shown below from the mutation.
    }
  };

  const askToSign = async () => {
    const valid = await form.trigger();
    if (!valid) return;
    const missing = missingForSigning(summaryDraftSchema.parse(form.getValues()));
    setLacking(missing.map((section) => t(`summary.sections.${section}`)));
    if (missing.length === 0) setConfirming(true);
  };

  const onSign = async () => {
    setDone('');
    try {
      const saved = await saveDraft(summaryDraftSchema.parse(form.getValues()));
      await sign.mutateAsync(saved.version);
      setConfirming(false);
    } catch {
      setConfirming(false);
    }
  };

  const failure = save.isError ? save.error : sign.isError ? sign.error : null;

  return (
    <>
      <p className="text-sm text-muted-foreground">
        {admission.patientName}: {t('summary.draftHint')}
      </p>
      <Form form={form} onSubmit={(values: SummaryDraftOutput) => void onSave(values)}>
        <TemplateStart
          admission={admission}
          replaces={form.watch('course').trim() !== ''}
          onFill={(text, chosen) => {
            form.setValue('course', text.slice(0, SUMMARY_TEXT_MAX), { shouldDirty: true });
            setTemplate(chosen);
          }}
        />
        {SUMMARY_SECTIONS.map((section) => (
          <TextAreaField<SummaryDraftValues>
            key={section}
            name={section}
            label={t(`summary.sections.${section}`)}
            hint={t(`summary.hints.${section}`)}
            required={section === 'diagnoses' || section === 'course'}
          />
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton pending={save.isPending}>{t('summary.save')}</SubmitButton>
          {canSign && (
            <Button
              type="button"
              variant="outline"
              aria-disabled={save.isPending || sign.isPending || undefined}
              onClick={() => void askToSign()}
            >
              {t('summary.sign')}
            </Button>
          )}
        </div>
      </Form>
      <p role="status" className="text-sm">
        {done}
      </p>
      {lacking.length > 0 && (
        <p role="alert" className="text-sm text-destructive">
          {t('summary.lacking', { sections: lacking.join(', ') })}
        </p>
      )}
      {failure !== null && (
        <p role="alert" className="text-sm text-destructive">
          {refusal(failure)}
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t('summary.confirm.title')}
        description={t('summary.confirm.description')}
        cancelLabel={t('summary.confirm.cancel')}
        confirmLabel={t('summary.confirm.sign')}
        pending={save.isPending || sign.isPending}
        onConfirm={() => void onSign()}
      />
    </>
  );
}

/** "Start the course from a template": the hospital's discharge summary templates, filled in. */
function TemplateStart({
  admission,
  replaces,
  onFill,
}: {
  admission: Admission;
  replaces: boolean;
  onFill: (text: string, template: { id: string; version: number }) => void;
}) {
  const { t } = useTranslation('admissions');
  const allowed = useAllowed({ requires: 'template:read', featureFlag: 'templates' });
  const { list, load } = useTemplateChoices('discharge_summary', { enabled: allowed });
  const format = useFormatters();
  const tenant = useTenant();
  const userName = useSession()?.user.name;
  const fieldId = useId();
  const [chosen, setChosen] = useState('');
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const values = useMemo(() => {
    const found: Record<string, string> = {
      'patient.name': admission.patientName,
      'patient.mrn': admission.patientMrn,
      'doctor.name': userName ?? '',
      'hospital.name': tenant?.name ?? '',
      'date.today': format.date(new Date().toISOString()),
      'admission.date': format.date(admission.admittedAt),
      ...(admission.dischargedAt ? { 'discharge.date': format.date(admission.dischargedAt) } : {}),
    };
    // An empty value is left out so its placeholder stays to be seen.
    return Object.fromEntries(Object.entries(found).filter(([, value]) => value !== ''));
  }, [admission, userName, tenant?.name, format]);
  if (!allowed) return null;
  const templates = list.data?.items ?? [];
  if (list.isSuccess && templates.length === 0) return null;

  const fill = async () => {
    if (!chosen || loading) return;
    setFailed(false);
    setLoading(true);
    try {
      const detail = await load(chosen);
      onFill(richTextToPlainText(fillPlaceholders(detail.body, values)), {
        id: detail.template.id,
        version: detail.template.version,
      });
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={fieldId} className="text-sm font-medium">
        {t('summary.template.label')}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <select
          id={fieldId}
          className="h-9 w-full rounded-md border bg-background px-3 text-base sm:max-w-sm md:text-sm pointer-coarse:h-11 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          value={chosen}
          onChange={(event) => setChosen(event.target.value)}
        >
          <option value="">{t('summary.template.choose')}</option>
          {templates.map((each) => (
            <option key={each.id} value={each.id}>
              {each.name}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="outline"
          aria-disabled={!chosen || loading || undefined}
          onClick={() => void fill()}
        >
          {t(replaces ? 'summary.template.replace' : 'summary.template.fill')}
        </Button>
      </div>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {t('summary.template.failed')}
        </p>
      )}
    </div>
  );
}
