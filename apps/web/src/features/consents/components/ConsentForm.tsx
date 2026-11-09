import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAllowed } from '@/access';
import { useSession } from '@/app/session';
import { usePatientAgeSex, usePatientName } from '@/features/patients';
import { fillPlaceholders, placeholdersIn, useTemplateChoices } from '@/features/templates';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Form, SelectField, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { RichTextView, type RichTextDocument } from '@/shared/ui/rich-text';
import { useFormatters, useTenant } from '@/tenancy';
import { useSignConsent } from '../hooks/use-consents';
import { consentFormSchema, SIGNATURES, SIGNERS, type ConsentValues } from '../schemas';
import type { ConsentDetail, ConsentSignature } from '../types';
import { SignaturePad } from './SignaturePad';

const REFUSED: Record<string, string> = {
  patient_merged: 'consent.errors.merged',
  template_not_found: 'consent.errors.template',
};

interface Loaded {
  id: string;
  version: number;
  body: RichTextDocument;
}

/**
 * Records a consent (MR-02, #190): the hospital's text for the kind `consent`, filled in for this
 * patient and procedure, shown as it will be kept, then signed by drawing on the pad or, for
 * someone who cannot draw, by typing the name and confirming. Signed once: there is no way to
 * change it afterwards, so the form says so before the button. A text with a placeholder that
 * could not be filled (the patient's age, say) is not signed, since what is signed is what is
 * seen. Shown in place, with `data-panel-heading` for the panel's focus.
 */
export function ConsentForm({
  patientId,
  onClose,
  onSigned,
}: {
  patientId: string;
  onClose: () => void;
  onSigned: (detail: ConsentDetail) => void;
}) {
  const { t } = useTranslation('consents');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const tenant = useTenant();
  const doctorName = useSession()?.user.name;
  const patient = usePatientName(patientId).data;
  const ageSex = usePatientAgeSex(patientId).data;
  const allowed = useAllowed({ requires: 'template:read', featureFlag: 'templates' });
  const { list, load } = useTemplateChoices('consent', { enabled: allowed });
  const sign = useSignConsent(patientId);
  const form = useZodForm(consentFormSchema, {
    templateId: '',
    procedureName: '',
    signerName: '',
    signerRole: 'patient',
  });
  const templateId = form.watch('templateId');
  const procedureName = form.watch('procedureName');
  // What was read, with the template it was read for: another choice shows nothing until read.
  const [read, setRead] = useState<{ forId: string; loaded?: Loaded }>();
  const [method, setMethod] = useState<ConsentSignature>('drawn');
  const [path, setPath] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [signatureProblem, setSignatureProblem] = useState(false);
  const methodId = useId();
  const typedId = useId();

  // The newest text of the chosen template, read when it is chosen.
  useEffect(() => {
    if (!templateId) return;
    let current = true;
    load(templateId).then(
      (detail) => {
        if (current) {
          setRead({
            forId: templateId,
            loaded: { id: detail.template.id, version: detail.template.version, body: detail.body },
          });
        }
      },
      () => {
        if (current) setRead({ forId: templateId });
      },
    );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load is stable for a hospital.
  }, [templateId]);
  const reading = templateId !== '' && read?.forId === templateId ? read : undefined;
  const loaded = reading?.loaded;
  const loadFailed = reading !== undefined && reading.loaded === undefined;

  const filled = useMemo(() => {
    if (!loaded) return undefined;
    const values: Record<string, string> = {
      'patient.name': patient ? `${patient.firstName} ${patient.lastName}` : '',
      'patient.mrn': patient?.mrn ?? '',
      'patient.sex': ageSex ? t(`consent.sex.${ageSex.sex}`) : '',
      'patient.age': ageSex
        ? ageSex.age.years > 0
          ? t('consent.age', { count: ageSex.age.years })
          : t('consent.ageMonths', { count: ageSex.age.months })
        : '',
      'hospital.name': tenant?.name ?? '',
      'doctor.name': doctorName ?? '',
      'date.today': format.date(new Date().toISOString()),
      'procedure.name': procedureName.trim(),
    };
    // A value that came out empty is left out, so its placeholder stays to be seen.
    return fillPlaceholders(
      loaded.body,
      Object.fromEntries(Object.entries(values).filter(([, value]) => value !== '')),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- format is rebuilt with the tenant.
  }, [loaded, patient, ageSex, t, tenant, doctorName, procedureName]);
  const unfilled = filled ? placeholdersIn(filled) : [];

  const submit = async (values: ConsentValues) => {
    if (!loaded || !filled || unfilled.length > 0) return;
    const hasSignature = method === 'drawn' ? path !== '' : agreed;
    setSignatureProblem(!hasSignature);
    if (!hasSignature) return;
    try {
      const detail = await sign.mutateAsync({
        templateId: loaded.id,
        templateVersion: loaded.version,
        procedureName: values.procedureName,
        body: filled,
        signerName: values.signerName,
        signerRole: values.signerRole,
        signatureMethod: method,
        ...(method === 'drawn' ? { signature: path } : {}),
      });
      onSigned(detail);
    } catch {
      // Said below, from the mutation state.
    }
  };

  const code = isApiError(sign.error) ? sign.error.serverCode : undefined;
  const failure = sign.error
    ? code !== undefined && REFUSED[code]
      ? t(REFUSED[code])
      : tCommon(errorMessageKey(sign.error))
    : undefined;
  const templates = list.data?.items ?? [];

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <h3 data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('consent.heading')}
      </h3>
      {!allowed ? (
        <p role="alert" className="text-sm">
          {t('consent.noTemplates.access')}
        </p>
      ) : list.isSuccess && templates.length === 0 ? (
        <p role="alert" className="text-sm">
          {t('consent.noTemplates.none')}
        </p>
      ) : null}
      <Form form={form} onSubmit={submit} className="max-w-xl">
        <SelectField<ConsentValues>
          name="templateId"
          label={t('consent.template')}
          required
          placeholder={t('consent.chooseTemplate')}
          options={templates.map((template) => ({ value: template.id, label: template.name }))}
        />
        <TextField<ConsentValues>
          name="procedureName"
          label={t('consent.procedure')}
          hint={t('consent.procedureHint')}
          required
        />
        {loadFailed && (
          <p role="alert" className="text-sm text-destructive">
            {t('consent.errors.load')}
          </p>
        )}
        {filled && (
          <section
            aria-label={t('consent.text')}
            className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3"
          >
            <h4 className="text-sm font-semibold">{t('consent.text')}</h4>
            <RichTextView document={filled} className="break-words" />
            {unfilled.length > 0 && (
              <p role="alert" className="text-sm text-destructive">
                {t('consent.unfilled', { names: unfilled.join(', ') })}
              </p>
            )}
          </section>
        )}
        <TextField<ConsentValues> name="signerName" label={t('consent.signerName')} required />
        <SelectField<ConsentValues>
          name="signerRole"
          label={t('consent.signerRole')}
          required
          options={SIGNERS.map((value) => ({ value, label: t(`signer.${value}`) }))}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{t('signature.legend')}</legend>
          <div className="flex flex-wrap gap-4">
            {SIGNATURES.map((value) => (
              <label
                key={value}
                className="flex items-center gap-2 text-sm pointer-coarse:min-h-11"
              >
                <input
                  type="radio"
                  name={methodId}
                  value={value}
                  checked={method === value}
                  onChange={() => {
                    setMethod(value);
                    setSignatureProblem(false);
                  }}
                  className="size-4"
                />
                {t(`signature.method.${value}`)}
              </label>
            ))}
          </div>
          {method === 'drawn' ? (
            <>
              <SignaturePad path={path} onChange={setPath} disabled={sign.isPending} />
              <div>
                <Button type="button" variant="outline" onClick={() => setPath('')}>
                  {t('signature.clear')}
                </Button>
              </div>
            </>
          ) : (
            <label
              htmlFor={typedId}
              className="flex items-start gap-2 text-sm pointer-coarse:min-h-11"
            >
              <input
                id={typedId}
                type="checkbox"
                checked={agreed}
                onChange={(event) => {
                  setAgreed(event.target.checked);
                  setSignatureProblem(false);
                }}
                className="mt-0.5 size-4"
              />
              {t('signature.typedConfirm')}
            </label>
          )}
          {signatureProblem && (
            <p role="alert" className="text-sm text-destructive">
              {t(method === 'drawn' ? 'signature.errors.drawn' : 'signature.errors.typed')}
            </p>
          )}
        </fieldset>
        <p className="text-sm text-muted-foreground">{t('consent.final')}</p>
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending={sign.isPending} disabled={unfilled.length > 0}>
            {sign.isPending ? t('consent.submitting') : t('consent.submit')}
          </SubmitButton>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </Form>
    </div>
  );
}
