import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { errorMessageKey } from '@/shared/api';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { Form, SelectField, SubmitButton, useZodForm } from '@/shared/ui/form';
import { link, useFieldName, useKindName } from '../components/common';
import { useImportKinds, useUploadBatch, type UploadProgress } from '../hooks/use-imports';
import { readCsvFile, type FileProblem, type ReadFile } from '../read-file';
import { guessMapping, isKnownKind, mappingSchema, type Mapping } from '../schemas';
import type { ImportColumn, ImportKind } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';

/** For each field of the kind, the column of the file it is read from. */
function Columns({
  kind,
  file,
  pending,
  progress,
  onSubmit,
}: {
  kind: ImportKind;
  file: ReadFile;
  pending: boolean;
  progress: UploadProgress | null;
  onSubmit: (mapping: Mapping) => void;
}) {
  const { t } = useTranslation('imports');
  const fieldName = useFieldName();
  const schema = useMemo(() => mappingSchema(kind.columns), [kind.columns]);
  const form = useZodForm(
    schema,
    guessMapping(kind.columns, file.headers, (field) => fieldName(kind.kind, field)),
  );
  const options = file.headers.map((title, index) => ({
    value: String(index),
    label: title.trim()
      ? t('new.column', { index: index + 1, title: title.trim() })
      : t('new.untitled', { index: index + 1 }),
  }));
  const hint = (column: ImportColumn) =>
    t(`values.${column.type}`, { values: (column.values ?? []).join(', ') });

  return (
    <section aria-labelledby="import-mapping" className="flex max-w-xl flex-col gap-3">
      <h2 id="import-mapping" className="text-lg font-semibold">
        {t('new.mappingHeading')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('new.mappingHint')}</p>
      <Form form={form} onSubmit={onSubmit} className="flex flex-col gap-4">
        {kind.columns.map((column) => (
          <SelectField
            key={column.field}
            name={column.field}
            label={fieldName(kind.kind, column.field)}
            hint={hint(column)}
            required={column.required}
            placeholder={t('new.notInFile')}
            options={options}
          />
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton pending={pending}>{t('new.upload')}</SubmitButton>
          <p role="status" className="text-sm text-muted-foreground">
            {progress ? t('new.sending', { sent: progress.sent, total: progress.total }) : ''}
          </p>
        </div>
      </Form>
    </section>
  );
}

function NewImport() {
  const { t } = useTranslation('imports');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const kindName = useKindName();
  const navigate = useNavigate();
  const kindId = useId();
  const fileId = useId();
  const kinds = useImportKinds();
  const upload = useUploadBatch();
  const [kindChosen, setKindChosen] = useState('');
  const [file, setFile] = useState<ReadFile | null>(null);
  const [fileProblem, setFileProblem] = useState<FileProblem | null>(null);
  const [reading, setReading] = useState(false);
  // Each file read is a new mapping form: what was matched for another file does not carry over.
  const [reads, setReads] = useState(0);

  const offered = (kinds.data ?? []).filter((kind) => isKnownKind(kind.kind));
  const kind = offered.find((item) => item.kind === kindChosen);

  const choose = async (chosen: File | undefined) => {
    setFile(null);
    setFileProblem(null);
    upload.reset();
    if (!chosen) return;
    setReading(true);
    try {
      const result = await readCsvFile(chosen);
      if ('problem' in result) setFileProblem(result.problem);
      else {
        setFile(result);
        setReads((count) => count + 1);
      }
    } finally {
      setReading(false);
    }
  };

  const send = (mapping: Mapping) => {
    if (!kind || !file) return;
    upload.mutate(
      { kind: kind.kind, file, mapping },
      { onSuccess: (batch) => navigate(`/imports/${batch.id}`) },
    );
  };

  // Leaving the screen while sending stops it; that is not an error to show.
  const failed =
    upload.isError && !(upload.error instanceof Error && upload.error.message === 'left');

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
      <div className="space-y-1">
        <Link to="/imports" className={`${link} text-sm underline`}>
          {t('backToList')}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{t('new.heading')}</h1>
      </div>

      {kinds.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {tCommon('app.loading')}
        </p>
      ) : kinds.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(kinds.error))}
        </p>
      ) : offered.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('new.noKinds')}</p>
      ) : (
        <div className="flex max-w-xl flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor={kindId} className="text-sm font-medium">
              {t('new.kind')}
            </label>
            <select
              id={kindId}
              value={kindChosen}
              disabled={upload.isPending}
              onChange={(event) => {
                setKindChosen(event.target.value);
                setReads((count) => count + 1);
                upload.reset();
              }}
              className={control}
            >
              <option value="">{t('new.chooseKind')}</option>
              {offered.map((item) => (
                <option key={item.kind} value={item.kind}>
                  {kindName(item.kind)}
                </option>
              ))}
            </select>
          </div>
          {kindChosen === 'patients' && (
            <p className="rounded-md border p-3 text-sm">{t('new.patientsNotice')}</p>
          )}
          <div className="flex flex-col gap-1">
            <label htmlFor={fileId} className="text-sm font-medium">
              {t('new.file')}
            </label>
            <input
              id={fileId}
              type="file"
              accept=".csv,text/csv,text/plain"
              disabled={upload.isPending}
              aria-describedby={`${fileId}-hint`}
              onChange={(event) => void choose(event.target.files?.[0])}
              className="text-base md:text-sm pointer-coarse:min-h-11"
            />
            <p id={`${fileId}-hint`} className="text-sm text-muted-foreground">
              {t('new.fileHint')}
            </p>
          </div>
          <div role="status" className="text-sm">
            {reading ? t('new.reading') : file ? t('new.read', { count: file.rows.length }) : ''}
          </div>
          {fileProblem && (
            <p role="alert" className="text-sm text-destructive">
              {t(fileProblem)}
            </p>
          )}
        </div>
      )}

      {kind && file && (
        <Columns
          key={`${kind.kind}-${reads}`}
          kind={kind}
          file={file}
          pending={upload.isPending}
          progress={upload.progress}
          onSubmit={send}
        />
      )}
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(upload.error))}
        </p>
      )}
    </div>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function ImportNew() {
  return (
    <DesktopOnly>
      <NewImport />
    </DesktopOnly>
  );
}
