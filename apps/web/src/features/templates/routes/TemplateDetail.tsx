import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Can } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { PageSkeleton } from '@/shared/ui/page-skeleton';
import { isEmptyRichText, type RichTextDocument } from '@/shared/ui/rich-text';
import { SystemPage } from '@/shared/ui/system-page';
import { useFormatters } from '@/tenancy';
import { TemplateBody, TemplateEditor, TemplatePreview } from '../components/TemplateText';
import { useSaveTemplate, useTemplate, useTemplateVersion } from '../hooks/use-templates';
import { unknownPlaceholders } from '../placeholders';
import { NAME_MAX, templateFormSchema, type TemplateFormValues } from '../schemas';
import type { TemplateDetail as Detail, TemplateVersionInfo } from '../types';

const link =
  'inline-flex items-center rounded-sm text-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

const same = (a: RichTextDocument, b: RichTextDocument) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The form that saves a new version. It works from the template as it was when the form opened:
 * the text cannot be merged with someone else's, and does not have to be, because their version
 * stays in the history whatever is saved after it.
 */
function EditForm({
  from,
  latestVersion,
  pending,
  onSave,
  onCancel,
}: {
  from: Detail;
  /** The newest version there is now. */
  latestVersion: number;
  pending: boolean;
  /** Answers whether the save met a conflict. */
  onSave: (
    change: { name?: string; body?: RichTextDocument; expectedVersion: number } | null,
  ) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { t } = useTranslation('templates');
  const form = useZodForm(templateFormSchema, { name: from.template.name });
  const [body, setBody] = useState<RichTextDocument>(from.body);
  const [tried, setTried] = useState(false);
  // The version a save is made from. After a conflict it moves to the newest one once that has
  // arrived, so saving again is a decision made knowing theirs exists.
  const [expected, setExpected] = useState(from.template.version);
  const [conflicted, setConflicted] = useState(false);
  if (conflicted && latestVersion !== expected) {
    setExpected(latestVersion);
    setConflicted(false);
  }

  const submit = async (values: TemplateFormValues) => {
    setTried(true);
    if (isEmptyRichText(body) || unknownPlaceholders(from.template.kind, body).length > 0) return;
    const change = {
      ...(values.name === from.template.name ? {} : { name: values.name }),
      ...(same(body, from.body) ? {} : { body }),
    };
    // Nothing was changed: there is no version to make.
    if (Object.keys(change).length === 0) return void (await onSave(null));
    if (await onSave({ ...change, expectedVersion: expected })) setConflicted(true);
  };

  return (
    <Form form={form} onSubmit={submit} className="flex flex-col gap-4">
      <div className="max-w-xl">
        <TextField
          name="name"
          label={t('form.name')}
          hint={t('form.nameHint')}
          required
          maxLength={NAME_MAX}
          autoComplete="off"
        />
      </div>
      <TemplateEditor
        kind={from.template.kind}
        initialBody={from.body}
        body={body}
        onChange={setBody}
        error={tried && isEmptyRichText(body) ? t('form.empty') : undefined}
      />
      <div className="flex flex-wrap gap-3">
        <SubmitButton pending={pending}>{t('form.save')}</SubmitButton>
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
          {t('form.cancel')}
        </Button>
      </div>
    </Form>
  );
}

/** Every version of the template, and one of them shown as it was saved. */
function Versions({ detail }: { detail: Detail }) {
  const { t } = useTranslation('templates');
  const format = useFormatters();
  const [viewing, setViewing] = useState<number | null>(null);
  const version = useTemplateVersion(detail.template.id, viewing);

  const columns = useMemo<GridColumn<TemplateVersionInfo>[]>(
    () => [
      {
        id: 'version',
        header: t('versions.columns.version'),
        value: (row) => t('versionNumber', { version: row.version }),
        hideable: false,
      },
      {
        id: 'savedAt',
        header: t('versions.columns.savedAt'),
        value: (row) => format.dateTime(row.savedAt),
      },
      { id: 'savedBy', header: t('versions.columns.savedBy'), value: (row) => row.savedByName },
    ],
    [t, format],
  );
  const actions: GridAction<TemplateVersionInfo>[] = [
    { id: 'view', label: t('versions.view'), onSelect: (row) => setViewing(row.version) },
  ];

  return (
    <section aria-labelledby="template-versions" className="flex flex-col gap-3">
      <div className="space-y-1">
        <h2 id="template-versions" className="text-lg font-semibold">
          {t('versions.heading')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('versions.description')}</p>
      </div>
      <DataGrid
        label={t('versions.gridLabel')}
        columns={columns}
        rows={detail.versions}
        rowId={(row) => String(row.version)}
        rowLabel={(row) => t('versionNumber', { version: row.version })}
        actions={actions}
        status="ready"
        emptyMessage=""
      />
      {viewing !== null && (
        <section
          aria-labelledby="template-version-shown"
          className="flex flex-col gap-3 rounded-lg border p-4"
        >
          <h3 id="template-version-shown" className="text-base font-semibold">
            {t('versions.viewing', { version: t('versionNumber', { version: viewing }) })}
          </h3>
          {version.data ? (
            <>
              <p className="text-sm text-muted-foreground">{version.data.name}</p>
              <TemplateBody body={version.data.body} />
            </>
          ) : version.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {t('versions.failed')}
            </p>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {t('versions.loading')}
            </p>
          )}
          <Button variant="outline" className="self-start" onClick={() => setViewing(null)}>
            {t('versions.close')}
          </Button>
        </section>
      )}
    </section>
  );
}

function Loaded({ detail }: { detail: Detail }) {
  const { t } = useTranslation('templates');
  const { t: tCommon } = useTranslation();
  const { template } = detail;
  const save = useSaveTemplate(template.id);
  // The template as it was when the form opened.
  const [editing, setEditing] = useState<Detail | null>(null);
  // What was just done, said once in a status line.
  const [done, setDone] = useState<string | null>(null);

  const start = (next: Detail | null) => {
    save.reset();
    setDone(null);
    setEditing(next);
  };

  const onSave = async (
    change: { name?: string; body?: RichTextDocument; expectedVersion: number } | null,
  ): Promise<boolean> => {
    setDone(null);
    if (!change) {
      setEditing(null);
      setDone(t('detail.unchanged'));
      return false;
    }
    try {
      const saved = await save.mutateAsync({ save: change });
      setEditing(null);
      setDone(t('detail.saved', { version: saved.template.version }));
      return false;
    } catch (error) {
      // Shown from the mutation state below. The form stays, with what was typed.
      return isApiError(error) && error.serverCode === 'conflict';
    }
  };

  const setArchived = (archived: boolean) => {
    setDone(null);
    save.mutate(
      { archived },
      {
        onSuccess: (saved) =>
          setDone(
            t(archived ? 'detail.archivedDone' : 'detail.restoredDone', {
              name: saved.template.name,
            }),
          ),
      },
    );
  };

  const code = isApiError(save.error) ? save.error.serverCode : undefined;
  const badge = 'ml-2 rounded-full border px-2 py-0.5 text-xs font-medium';

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6">
      <div className="space-y-1">
        <Link to="/templates" className={link}>
          {t('backToList')}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight break-words">{template.name}</h1>
        <p className="text-muted-foreground">
          {[t(`kinds.${template.kind}`), t('versionNumber', { version: template.version })].join(
            ' · ',
          )}
          {template.archived && <span className={badge}>{t('detail.archived')}</span>}
        </p>
      </div>

      {template.archived && (
        <p className="text-sm text-muted-foreground">{t('detail.archivedNote')}</p>
      )}
      {save.isError && (
        <p role="alert" className="text-sm text-destructive">
          {code === 'conflict'
            ? t('detail.conflict', { version: template.version })
            : code === 'template_name_taken'
              ? t('detail.nameTaken')
              : tCommon(errorMessageKey(save.error))}
        </p>
      )}
      <p role="status" className="text-sm text-muted-foreground">
        {done ?? ''}
      </p>

      {editing ? (
        <EditForm
          from={editing}
          latestVersion={template.version}
          pending={save.isPending}
          onSave={onSave}
          onCancel={() => start(null)}
        />
      ) : (
        <>
          <section aria-labelledby="template-text" className="flex flex-col gap-3">
            <h2 id="template-text" className="text-lg font-semibold">
              {t('detail.text')}
            </h2>
            <TemplateBody body={detail.body} />
            <TemplatePreview kind={template.kind} body={detail.body} />
            <Can permission="template:manage">
              <div className="flex flex-wrap gap-3">
                {!template.archived && (
                  <Button variant="outline" disabled={save.isPending} onClick={() => start(detail)}>
                    {t('detail.edit')}
                  </Button>
                )}
                <Button
                  variant="outline"
                  disabled={save.isPending}
                  onClick={() => setArchived(!template.archived)}
                >
                  {t(template.archived ? 'detail.restore' : 'detail.archive')}
                </Button>
              </div>
            </Can>
          </section>
          <Versions detail={detail} />
        </>
      )}
    </div>
  );
}

function TemplateScreen() {
  const { t } = useTranslation('templates');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const { templateId = '' } = useParams();
  const template = useTemplate(templateId);

  if (template.isPending) return <PageSkeleton label={t('detail.loading')} />;

  // Only when there is nothing to show: a failed background refresh leaves it on screen.
  if (template.data === undefined) {
    // One answer for a template that does not exist and one of another hospital.
    if (isApiError(template.error) && template.error.code === 'not_found') {
      return (
        <SystemPage
          title={t('detail.notFoundTitle')}
          description={t('detail.notFoundBody')}
          actions={
            <Link to="/templates" className={link}>
              {t('backToList')}
            </Link>
          }
        />
      );
    }
    return (
      <SystemPage
        alert
        title={t('detail.errorTitle')}
        description={tCommon(errorMessageKey(template.error))}
        actions={
          isApiError(template.error) && template.error.code === 'forbidden' ? undefined : (
            <Button variant="outline" onClick={() => void template.refetch()}>
              {tCommon('grid.retry')}
            </Button>
          )
        }
      />
    );
  }

  return <Loaded key={template.data.template.id} detail={template.data} />;
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function TemplateDetail() {
  return (
    <DesktopOnly>
      <TemplateScreen />
    </DesktopOnly>
  );
}
