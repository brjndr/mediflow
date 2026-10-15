import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Can } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { Form, SelectField, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { PageSkeleton } from '@/shared/ui/page-skeleton';
import { isEmptyRichText, type RichTextDocument } from '@/shared/ui/rich-text';
import { SystemPage } from '@/shared/ui/system-page';
import { useFormatters } from '@/tenancy';
import { TemplateBody, TemplateEditor, TemplatePreview } from '../components/TemplateText';
import { useSaveTemplate, useTemplate, useTemplateVersion } from '../hooks/use-templates';
import { unknownPlaceholders } from '../placeholders';
import {
  NAME_MAX,
  redactFormSchema,
  templateFormSchema,
  type RedactFormValues,
  type TemplateFormValues,
} from '../schemas';
import {
  REDACTION_REASONS,
  type RedactionReason,
  type TemplateDetail as Detail,
  type TemplateVersionInfo,
} from '../types';

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
        <Button
          type="button"
          variant="outline"
          aria-disabled={pending || undefined}
          onClick={onCancel}
        >
          {t('form.cancel')}
        </Button>
      </div>
    </Form>
  );
}

/**
 * The heading of a panel that opens below the list of versions, which can be long. Focus moves
 * to it when it opens, so the panel is brought into view and announced.
 */
function PanelHeading({ id, children }: { id: string; children: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
    heading.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  return (
    <h3 id={id} ref={heading} tabIndex={-1} className="text-base font-semibold outline-none">
      {children}
    </h3>
  );
}

/**
 * Asks why, and says what it does, before the name and the text of a version are removed. A
 * reason is chosen from a list: free text here could repeat what is being removed.
 */
function RedactForm({
  version,
  pending,
  onRedact,
  onCancel,
}: {
  version: number;
  pending: boolean;
  onRedact: (reason: RedactionReason) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('templates');
  const form = useZodForm(redactFormSchema, { reason: '' as RedactFormValues['reason'] });
  return (
    <section
      aria-labelledby="template-version-redact"
      className="flex flex-col gap-3 rounded-lg border border-destructive/50 p-4"
    >
      <PanelHeading id="template-version-redact">
        {t('versions.redactHeading', { version: t('versionNumber', { version }) })}
      </PanelHeading>
      <p className="text-sm text-muted-foreground">{t('versions.redactWarning')}</p>
      <Form
        form={form}
        onSubmit={(values: RedactFormValues) => onRedact(values.reason)}
        className="flex flex-col gap-4"
      >
        <div className="max-w-sm">
          <SelectField
            name="reason"
            label={t('versions.redactReason')}
            required
            placeholder={t('versions.redactReasonPlaceholder')}
            options={REDACTION_REASONS.map((reason) => ({
              value: reason,
              label: t(`versions.reasons.${reason}`),
            }))}
          />
        </div>
        <div className="flex flex-wrap gap-3">
          <SubmitButton pending={pending}>{t('versions.redactConfirm')}</SubmitButton>
          <Button
            type="button"
            variant="outline"
            aria-disabled={pending || undefined}
            onClick={onCancel}
          >
            {t('versions.redactCancel')}
          </Button>
        </div>
      </Form>
    </section>
  );
}

/** Every version of the template, and one of them shown as it was saved. */
function Versions({
  detail,
  pending,
  onRedact,
  onReset,
}: {
  detail: Detail;
  pending: boolean;
  /** Answers whether the version was redacted. */
  onRedact: (version: number, reason: RedactionReason) => Promise<boolean>;
  /** Clears what the last change said: a panel opened or closed starts afresh. */
  onReset: () => void;
}) {
  const { t } = useTranslation('templates');
  const format = useFormatters();
  const [viewing, setViewing] = useState<number | null>(null);
  const [redacting, setRedacting] = useState<number | null>(null);
  // What the list says of the version shown: once it says redacted, what was read before is not shown.
  const viewedRedactedAt =
    detail.versions.find((row) => row.version === viewing)?.redactedAt ?? null;
  const version = useTemplateVersion(detail.template.id, viewing, viewedRedactedAt);
  // Where focus goes back to when a panel closes: its own button may be gone or disabled.
  const heading = useRef<HTMLHeadingElement>(null);
  const close = () => {
    onReset();
    setViewing(null);
    setRedacting(null);
    heading.current?.focus();
  };

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
      {
        id: 'state',
        header: t('versions.columns.state'),
        value: (row) => (row.redactedAt ? t('versions.redacted') : ''),
      },
    ],
    [t, format],
  );
  const actions: GridAction<TemplateVersionInfo>[] = [
    {
      id: 'view',
      label: t('versions.view'),
      onSelect: (row) => {
        onReset();
        setRedacting(null);
        setViewing(row.version);
      },
    },
    {
      id: 'redact',
      label: t('versions.redact'),
      requires: 'template:redact',
      // The newest version is the template as it is used, and a version is redacted once.
      disabled: (row) => row.version === detail.template.version || Boolean(row.redactedAt),
      onSelect: (row) => {
        onReset();
        setViewing(null);
        setRedacting(row.version);
      },
    },
  ];

  return (
    <section aria-labelledby="template-versions" className="flex flex-col gap-3">
      <div className="space-y-1">
        <h2
          id="template-versions"
          ref={heading}
          tabIndex={-1}
          className="text-lg font-semibold outline-none"
        >
          {t('versions.heading')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('versions.description')}</p>
        <Can permission="template:redact">
          <p className="text-sm text-muted-foreground">{t('versions.redactHint')}</p>
        </Can>
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
      {redacting !== null && (
        <RedactForm
          key={redacting}
          version={redacting}
          pending={pending}
          onRedact={(reason) =>
            void onRedact(redacting, reason).then((done) => {
              if (!done) return;
              setRedacting(null);
              heading.current?.focus();
            })
          }
          onCancel={close}
        />
      )}
      {viewing !== null && (
        <section
          aria-labelledby="template-version-shown"
          className="flex flex-col gap-3 rounded-lg border p-4"
        >
          <PanelHeading key={viewing} id="template-version-shown">
            {t('versions.viewing', { version: t('versionNumber', { version: viewing }) })}
          </PanelHeading>
          {version.data?.redactedAt ? (
            <p className="text-sm text-muted-foreground">
              {t(
                version.data.redactedByName
                  ? 'versions.redactedNote'
                  : 'versions.redactedNoteNoName',
                {
                  date: format.dateTime(version.data.redactedAt),
                  name: version.data.redactedByName ?? '',
                  reason: t(`versions.reasons.${version.data.redactionReason ?? 'other'}`),
                },
              )}
            </p>
          ) : version.data ? (
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
          <Button variant="outline" className="self-start" onClick={close}>
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
      // The server tidies a name: one that differs only in its spaces is the same name.
      setDone(
        saved.template.version === change.expectedVersion
          ? t('detail.unchanged')
          : t('detail.saved', { version: saved.template.version }),
      );
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

  const onRedact = async (version: number, reason: RedactionReason): Promise<boolean> => {
    setDone(null);
    try {
      await save.mutateAsync({ redact: { version, reason } });
      setDone(t('versions.redactDone', { version: t('versionNumber', { version }) }));
      return true;
    } catch {
      // Shown from the mutation state below.
      return false;
    }
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
              : code === 'template_archived'
                ? t('detail.archivedMeanwhile')
                : code === 'template_version_current'
                  ? t('versions.redactCurrent')
                  : code === 'template_version_limit'
                    ? t('detail.versionLimit')
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
                  <Button
                    variant="outline"
                    aria-disabled={save.isPending || undefined}
                    onClick={() => start(detail)}
                  >
                    {t('detail.edit')}
                  </Button>
                )}
                <Button
                  variant="outline"
                  aria-disabled={save.isPending || undefined}
                  onClick={() => setArchived(!template.archived)}
                >
                  {t(template.archived ? 'detail.restore' : 'detail.archive')}
                </Button>
              </div>
            </Can>
          </section>
          <Versions
            detail={detail}
            pending={save.isPending}
            onRedact={onRedact}
            onReset={() => {
              save.reset();
              setDone(null);
            }}
          />
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
