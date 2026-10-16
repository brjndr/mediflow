import { useId, useMemo } from 'react';
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
export function TemplatePreview({
  kind,
  body,
  headingLevel = 3,
}: {
  kind: TemplateKind;
  body: RichTextDocument;
  /** Its heading's level: one below the heading of the part of the page it is in. */
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const { t } = useTranslation('templates');
  const values = useSampleValues();
  const known = new Set<string>(placeholdersFor(kind));
  const allowed = Object.fromEntries(Object.entries(values).filter(([name]) => known.has(name)));
  const filled = useMemo(() => fillPlaceholders(body, allowed), [body, allowed]);
  return (
    <section aria-labelledby="template-preview" className="flex flex-col gap-2">
      <Heading id="template-preview" className="text-base font-semibold">
        {t('preview.heading')}
      </Heading>
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
  headingLevel,
}: {
  kind: TemplateKind;
  /** Read once: the editor owns the text while it is open. */
  initialBody?: RichTextDocument;
  /** The text as it is now, for the preview and the checks. */
  body: RichTextDocument;
  onChange: (body: RichTextDocument) => void;
  /** Already translated: why the text cannot be saved as it is. */
  error?: string;
  /** The level of the preview's heading (see TemplatePreview). */
  headingLevel?: 2 | 3;
}) {
  const { t } = useTranslation('templates');
  const unknown = unknownPlaceholders(kind, body);
  const hintId = useId();
  const errorId = useId();
  const unknownId = useId();
  // The hint and whatever is wrong describe the text, so a screen reader says them with it.
  const describedBy = [hintId, error ? errorId : null, unknown.length > 0 ? unknownId : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">{t('form.body')}</span>
        <p id={hintId} className="text-xs text-muted-foreground">
          {t('form.bodyHint')}
        </p>
        <RichTextEditor
          label={t('form.body')}
          describedBy={describedBy}
          invalid={Boolean(error) || unknown.length > 0}
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
          <p id={errorId} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {unknown.length > 0 && (
          <p id={unknownId} role="alert" className="text-sm text-destructive">
            {t('form.unknown', { names: unknown.map(token).join(', ') })}
          </p>
        )}
      </div>
      <TemplatePreview kind={kind} body={body} headingLevel={headingLevel} />
    </div>
  );
}
