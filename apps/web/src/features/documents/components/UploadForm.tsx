import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Form, SelectField, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { UploadRefused } from '../api';
import { useUploadDocument } from '../hooks/use-documents';
import {
  DOCUMENT_CATEGORIES,
  DOCUMENT_TYPES,
  fileProblem,
  TITLE_MAX,
  uploadFormSchema,
  type UploadValues,
} from '../schemas';
import type { PatientDocument } from '../types';

/** What the API says about the request, in words of the person's own. */
const REFUSED: Record<string, string> = {
  file_type_not_allowed: 'upload.errors.type',
  file_too_large: 'upload.errors.size',
  patient_merged: 'upload.errors.merged',
};
const SENT_REFUSED: Record<number, string> = {
  413: 'upload.errors.size',
  415: 'upload.errors.type',
  400: 'upload.errors.rejected',
};

/**
 * Attaches a file to the patient's record (#189): a category, a title and one JPEG, PNG or PDF of
 * at most 25 MB. Type and size are checked here before anything is sent and again by the API,
 * which also checks the first bytes and holds the file until the malware scan clears it. Shown
 * in place, with `data-panel-heading` for the panel's focus.
 */
export function UploadForm({
  patientId,
  onClose,
  onUploaded,
}: {
  patientId: string;
  onClose: () => void;
  onUploaded: (document: PatientDocument) => void;
}) {
  const { t } = useTranslation('documents');
  const { t: tCommon } = useTranslation();
  const fileId = useId();
  const upload = useUploadDocument(patientId);
  const [file, setFile] = useState<File>();
  const [problem, setProblem] = useState<string>();
  const form = useZodForm(uploadFormSchema, { category: 'outside_report', title: '' });

  const choose = (chosen: File | undefined) => {
    upload.reset();
    setFile(chosen);
    setProblem(chosen ? fileProblem(chosen) : undefined);
    // The title is offered from the file's name, never over what was typed.
    if (chosen && form.getValues('title') === '') {
      form.setValue('title', chosen.name.replace(/\.[^.]+$/, '').slice(0, TITLE_MAX));
    }
  };

  const submit = async (values: UploadValues) => {
    if (!file) return setProblem('upload.errors.none');
    const found = fileProblem(file);
    if (found) return setProblem(found);
    setProblem(undefined);
    try {
      const document = await upload.mutateAsync({
        category: values.category,
        title: values.title,
        fileName: file.name,
        contentType: file.type,
        size: file.size,
        file,
      });
      onUploaded(document);
    } catch {
      // Said below, from the mutation state.
    }
  };

  const code = isApiError(upload.error) ? upload.error.serverCode : undefined;
  const failure = upload.error
    ? upload.error instanceof UploadRefused
      ? t(SENT_REFUSED[upload.error.status] ?? 'upload.errors.failed')
      : code !== undefined && REFUSED[code]
        ? t(REFUSED[code])
        : tCommon(errorMessageKey(upload.error))
    : undefined;

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <h3 data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('upload.heading')}
      </h3>
      <Form form={form} onSubmit={submit} className="max-w-xl">
        <div className="flex flex-col gap-1">
          <label htmlFor={fileId} className="text-sm font-medium">
            {t('upload.file')}
          </label>
          <input
            id={fileId}
            type="file"
            accept={DOCUMENT_TYPES.join(',')}
            disabled={upload.isPending}
            aria-describedby={`${fileId}-hint`}
            aria-invalid={problem ? true : undefined}
            onChange={(event) => choose(event.target.files?.[0])}
            className="text-base md:text-sm pointer-coarse:min-h-11"
          />
          <p id={`${fileId}-hint`} className="text-sm text-muted-foreground">
            {t('upload.fileHint')}
          </p>
          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {t(problem)}
            </p>
          )}
        </div>
        <SelectField<UploadValues>
          name="category"
          label={t('upload.category')}
          required
          options={DOCUMENT_CATEGORIES.map((value) => ({
            value,
            label: t(`category.${value}`),
          }))}
        />
        <TextField<UploadValues> name="title" label={t('upload.title')} required />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending={upload.isPending}>
            {upload.isPending ? t('upload.submitting') : t('upload.submit')}
          </SubmitButton>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </Form>
    </div>
  );
}
