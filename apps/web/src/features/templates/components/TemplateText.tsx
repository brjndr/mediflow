import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { RichTextEditor, RichTextView, type RichTextDocument } from '@/shared/ui/rich-text';
import { useFormatters, useTenant } from '@/tenancy';
import {
  fillPlaceholders,
  placeholdersFor,
  token,
  unknownPlaceholders,
  type Placeholder,
  type TemplateKind,
} from '../placeholders';

const box = 'rounded-md border p-4 text-sm leading-relaxed';

/** Made-up values for a preview. Nothing here is, or looks up, a real patient. */
function useSampleValues(): Record<Placeholder, string> {
  const { t } = useTranslation('templates');
  const format = useFormatters();
  const hospital = useTenant()?.name;
  return useMemo(() => {
    const today = format.date(new Date().toISOString());
    return {
      'patient.name': t('sample.patientName'),
      'patient.mrn': t('sample.patientMrn'),
      'patient.age': t('sample.patientAge'),
      'patient.sex': t('sample.patientSex'),
      'doctor.name': t('sample.doctorName'),
      'hospital.name': hospital ?? t('sample.hospitalName'),
      'date.today': today,
      'procedure.name': t('sample.procedureName'),
      'admission.date': today,
      'discharge.date': today,
    };
  }, [t, format, hospital]);
}

/**
 * A template as a document made from it would read: every placeholder filled with a made-up
 * value. A placeholder the kind of template does not know is left as it is written, and named.
 */
export function TemplatePreview({ kind, body }: { kind: TemplateKind; body: RichTextDocument }) {
  const { t } = useTranslation('templates');
  const values = useSampleValues();
  const known = new Set<string>(placeholdersFor(kind));
  const allowed = Object.fromEntries(Object.entries(values).filter(([name]) => known.has(name)));
  const filled = useMemo(() => fillPlaceholders(body, allowed), [body, allowed]);
  return (
    <section aria-labelledby="template-preview" className="flex flex-col gap-2">
      <h3 id="template-preview" className="text-base font-semibold">
        {t('preview.heading')}
      </h3>
      <p className="text-xs text-muted-foreground">{t('preview.description')}</p>
      <RichTextView document={filled} className={box} />
    </section>
  );
}

/** A template's text as it is saved, placeholders and all. */
export function TemplateBody({ body }: { body: RichTextDocument }) {
  return <RichTextView document={body} className={box} />;
}

/**
 * The editor of a template's text, with the placeholders of its kind to put in from a list, a
 * warning for any it does not know, and the preview beside what is typed.
 */
export function TemplateEditor({
  kind,
  initialBody,
  body,
  onChange,
  error,
}: {
  kind: TemplateKind;
  /** Read once: the editor owns the text while it is open. */
  initialBody?: RichTextDocument;
  /** The text as it is now, for the preview and the checks. */
  body: RichTextDocument;
  onChange: (body: RichTextDocument) => void;
  /** Already translated: why the text cannot be saved as it is. */
  error?: string;
}) {
  const { t } = useTranslation('templates');
  const unknown = unknownPlaceholders(kind, body);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">{t('form.body')}</span>
        <p className="text-xs text-muted-foreground">{t('form.bodyHint')}</p>
        <RichTextEditor
          label={t('form.body')}
          initialValue={initialBody}
          onChange={onChange}
          insertable={{
            label: t('form.insert'),
            options: placeholdersFor(kind).map((name) => ({
              value: token(name),
              label: t(`placeholders.${name}`),
            })),
          }}
        />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {unknown.length > 0 && (
          <p role="alert" className="text-sm text-destructive">
            {t('form.unknown', { names: unknown.map(token).join(', ') })}
          </p>
        )}
      </div>
      <TemplatePreview kind={kind} body={body} />
    </div>
  );
}
