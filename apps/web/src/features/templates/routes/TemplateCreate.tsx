import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { errorMessageKey, isApiError } from '@/shared/api';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import {
  Form,
  SelectField,
  SubmitButton,
  TextField,
  useFieldValue,
  useZodForm,
} from '@/shared/ui/form';
import { EMPTY_DOCUMENT, isEmptyRichText, type RichTextDocument } from '@/shared/ui/rich-text';
import { TemplateEditor } from '../components/TemplateText';
import { useCreateTemplate } from '../hooks/use-templates';
import { TEMPLATE_KINDS, unknownPlaceholders } from '../placeholders';
import { NAME_MAX, templateCreateFormSchema, type TemplateCreateFormValues } from '../schemas';

const link =
  'inline-flex items-center rounded-sm text-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

/** The text of the new template, once its kind is known: the kind decides the placeholders. */
function Text({
  body,
  onChange,
  error,
}: {
  body: RichTextDocument;
  onChange: (body: RichTextDocument) => void;
  error?: string;
}) {
  const { t } = useTranslation('templates');
  const chosen = useFieldValue('kind');
  const kind = TEMPLATE_KINDS.find((value) => value === chosen);
  if (!kind) return <p className="text-sm text-muted-foreground">{t('create.kindFirst')}</p>;
  return <TemplateEditor kind={kind} body={body} onChange={onChange} error={error} />;
}

function NewTemplate() {
  const { t } = useTranslation('templates');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();
  const create = useCreateTemplate();
  const form = useZodForm(templateCreateFormSchema, { kind: '', name: '' });
  const [body, setBody] = useState<RichTextDocument>(EMPTY_DOCUMENT);
  // Said only once saving has been tried, not while the text is still being started.
  const [tried, setTried] = useState(false);
  // Leaving the screen while the answer is on its way does not bring the person back to it.
  const here = useRef(true);
  useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
    };
  }, []);

  const submit = async (values: TemplateCreateFormValues) => {
    setTried(true);
    if (isEmptyRichText(body) || unknownPlaceholders(values.kind, body).length > 0) return;
    try {
      const { template } = await create.mutateAsync({ ...values, body });
      if (!here.current) return;
      await navigate(`/templates/${template.id}`, { replace: true });
    } catch {
      // Shown from the mutation state below.
    }
  };

  const taken = isApiError(create.error) && create.error.serverCode === 'template_name_taken';

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('create.heading')}</h1>
        <p className="text-muted-foreground">{t('create.description')}</p>
      </div>

      {create.isError && (
        <p role="alert" className="text-sm text-destructive">
          {taken ? t('detail.nameTaken') : tCommon(errorMessageKey(create.error))}
        </p>
      )}

      <Form form={form} onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex max-w-xl flex-col gap-4">
          <SelectField
            name="kind"
            label={t('form.kind')}
            hint={t('form.kindHint')}
            required
            placeholder={t('form.chooseKind')}
            options={TEMPLATE_KINDS.map((value) => ({ value, label: t(`kinds.${value}`) }))}
          />
          <TextField
            name="name"
            label={t('form.name')}
            hint={t('form.nameHint')}
            required
            maxLength={NAME_MAX}
            autoComplete="off"
          />
        </div>
        <Text
          body={body}
          onChange={setBody}
          error={tried && isEmptyRichText(body) ? t('form.empty') : undefined}
        />
        <div className="flex flex-wrap gap-3">
          <SubmitButton pending={create.isPending}>{t('create.submit')}</SubmitButton>
          <Link to="/templates" className={link}>
            {t('form.cancel')}
          </Link>
        </div>
      </Form>
    </div>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function TemplateCreate() {
  return (
    <DesktopOnly>
      <NewTemplate />
    </DesktopOnly>
  );
}
