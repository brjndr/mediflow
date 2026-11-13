import { useMemo } from 'react';
import type { Path } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import {
  Form,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
  useZodForm,
} from '@/shared/ui/form';
import { todayIn } from '@/shared/utils/timezone';
import { useTenant } from '@/tenancy';
import { useCertificateFormats, useIssueCertificate } from '../hooks/use-consents';
import { fieldLabel, optionLabel } from '../labels';
import { certificateFormSchema, emptyCertificate, type CertificateValues } from '../schemas';
import type { Certificate, CertificateField, CertificateKind } from '../types';

const REFUSED: Record<string, string> = {
  patient_merged: 'certificate.errors.merged',
};

/**
 * Enters the data of a certificate of one kind (MR-02, #190): the fields are those of the kind,
 * in the order the printed form has them, and the server numbers it. Issued once; there is no way
 * to change it afterwards. The form is made for one kind: the screen draws a new one (keyed) when
 * the kind is changed.
 */
export function CertificateForm({
  patientId,
  kind,
  onClose,
  onIssued,
}: {
  patientId: string;
  kind: CertificateKind;
  onClose: () => void;
  onIssued: (certificate: Certificate) => void;
}) {
  const { t } = useTranslation('consents');
  const { t: tCommon } = useTranslation();
  const formats = useCertificateFormats();
  // The fields are the hospital's (#567): the form is made once they are known.
  const fields = formats.data?.find((one) => one.kind === kind)?.fields;
  if (!fields) {
    return (
      <div className="flex flex-col gap-3 rounded-md border p-3">
        <h3 data-panel-heading tabIndex={-1} className="font-semibold outline-none">
          {t('certificate.heading', { kind: t(`certificate.kind.${kind}`) })}
        </h3>
        {formats.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(formats.error))}
          </p>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {tCommon('app.loading')}
          </p>
        )}
        <div>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <FormBody
      patientId={patientId}
      kind={kind}
      fields={fields}
      onClose={onClose}
      onIssued={onIssued}
    />
  );
}

function FormBody({
  patientId,
  kind,
  fields,
  onClose,
  onIssued,
}: {
  patientId: string;
  kind: CertificateKind;
  fields: readonly CertificateField[];
  onClose: () => void;
  onIssued: (certificate: Certificate) => void;
}) {
  const { t } = useTranslation('consents');
  const { t: tCommon } = useTranslation();
  const timezone = useTenant()?.timezone ?? 'UTC';
  const issue = useIssueCertificate(patientId);
  const schema = useMemo(() => certificateFormSchema(fields), [fields]);
  const form = useZodForm(schema, emptyCertificate(fields, todayIn(timezone)));

  const submit = async (values: CertificateValues) => {
    try {
      const certificate = await issue.mutateAsync({
        kind,
        issuedOn: values.issuedOn,
        // Only what was filled in: an empty optional field is not sent.
        fields: Object.fromEntries(
          Object.entries(values.fields).filter(([, value]) => value.trim() !== ''),
        ),
      });
      onIssued(certificate);
    } catch {
      // Said below, from the mutation state.
    }
  };

  const code = isApiError(issue.error) ? issue.error.serverCode : undefined;
  const failure = issue.error
    ? code !== undefined && REFUSED[code]
      ? t(REFUSED[code])
      : tCommon(errorMessageKey(issue.error))
    : undefined;

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <h3 data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('certificate.heading', { kind: t(`certificate.kind.${kind}`) })}
      </h3>
      <Form form={form} onSubmit={submit} className="max-w-xl">
        <TextField<CertificateValues>
          name="issuedOn"
          type="date"
          label={t('certificate.issuedOn')}
          required
        />
        {fields.map((field) => {
          const name = `fields.${field.name}` as Path<CertificateValues>;
          const label = fieldLabel(t, kind, field);
          if (field.type === 'lines') {
            return (
              <TextAreaField<CertificateValues>
                key={field.name}
                name={name}
                label={label}
                required={field.required}
              />
            );
          }
          if (field.type === 'select') {
            return (
              <SelectField<CertificateValues>
                key={field.name}
                name={name}
                label={label}
                required={field.required}
                placeholder={t('certificate.choose')}
                options={(field.options ?? []).map((value) => ({
                  value,
                  label: optionLabel(t, field, value),
                }))}
              />
            );
          }
          return (
            <TextField<CertificateValues>
              key={field.name}
              name={name}
              type={field.type === 'text' ? 'text' : field.type}
              label={label}
              required={field.required}
            />
          );
        })}
        <p className="text-sm text-muted-foreground">{t('certificate.final')}</p>
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending={issue.isPending}>
            {issue.isPending ? t('certificate.submitting') : t('certificate.submit')}
          </SubmitButton>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </Form>
    </div>
  );
}
