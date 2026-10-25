import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAllowed, usePermission } from '@/access';
import { useSession } from '@/app/session';
import { fillPlaceholders, placeholdersIn, useTemplateChoices } from '@/features/templates';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { Form, SelectField, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import {
  EMPTY_DOCUMENT,
  isEmptyRichText,
  RichTextEditor,
  RichTextView,
  sanitizeRichText,
  type RichTextDocument,
} from '@/shared/ui/rich-text';
import { todayIn } from '@/shared/utils/timezone';
import { useFormatters, useTenant } from '@/tenancy';
import { useAddAddendum, useReport, useSaveReport, useSignReport } from '../hooks/use-radiology';
import {
  ADDENDUM_REASONS,
  addendumSchema,
  linkSchema,
  MAX_LINKS,
  type AddendumOutput,
  type AddendumValues,
  type LinkOutput,
  type LinkValues,
} from '../schemas';
import type { ImagingLink, ImagingReport, ImagingWorkItem } from '../types';

/** Refusals of saving and signing, by the server's code, in words of their own. */
const REFUSED: Record<string, string> = {
  conflict: 'report.refused.conflict',
  report_signed: 'report.refused.signed',
  invalid_transition: 'report.refused.notPerformed',
  order_not_found: 'report.refused.gone',
  report_not_found: 'report.refused.gone',
  invalid_link: 'report.refused.invalidLink',
  template_not_found: 'report.refused.template',
  report_incomplete: 'report.refused.incomplete',
  unfilled_placeholders: 'report.refused.placeholders',
  report_not_signed: 'report.refused.notSigned',
};

/** After these nothing more can be sent from this panel: it is closed and the worklist read again. */
const FINAL = new Set([
  'report_signed',
  'invalid_transition',
  'order_not_found',
  'report_not_found',
]);

const refusalOf = (error: unknown) =>
  isApiError(error) ? (error.serverCode ?? undefined) : undefined;

/** Full years, or months under a year, from a calendar date to today at the hospital. */
function ageOf(dob: string, today: string): { years: number; months: number } {
  const [y1 = 0, m1 = 0, d1 = 0] = dob.split('-').map(Number);
  const [y2 = 0, m2 = 0, d2 = 0] = today.split('-').map(Number);
  const months = (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
  return { years: Math.floor(months / 12), months: Math.max(months, 0) };
}

/**
 * The report of a performed study (#97), in place beside the worklist. While it is a draft, whoever
 * may write reports (`imagingReport:write`) writes its technique, findings and impression, fills the
 * findings from an imaging report template, adds links to images held elsewhere, and saves it on
 * the server; whoever may sign (`imagingReport:sign`) signs it, after a confirmation, which
 * completes the order. A signed report is shown as signed, never changed, with its addenda and a
 * form to add one. Shown with `data-panel-heading` for the panel's focus.
 */
export function ReportPanel({
  item,
  onClose,
  onSigned,
}: {
  item: ImagingWorkItem;
  onClose: () => void;
  onSigned: () => void;
}) {
  const { t } = useTranslation('radiology');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const report = useReport(item.orderId);
  const canWrite = usePermission('imagingReport:write');
  const headingId = useId();
  // Once the draft is on screen it stays there until it is signed here, so what is typed is never
  // swapped out by a read that finds it signed elsewhere: the draft says so instead.
  const [writing, setWriting] = useState(false);
  const draftable =
    report.isSuccess && report.data?.status !== 'signed' && canWrite && item.stage === 'performed';
  if (draftable && !writing) setWriting(true);
  const signed = report.data?.status === 'signed' && !writing;

  let body: ReactNode;
  if (report.isPending)
    body = <p className="text-sm text-muted-foreground">{t('report.loading')}</p>;
  else if (writing) {
    body = (
      <ReportDraft
        item={item}
        saved={report.data ?? null}
        onSigned={() => {
          setWriting(false);
          onSigned();
        }}
      />
    );
  } else if (report.isError) {
    body = (
      <div role="alert" className="flex flex-col items-start gap-2 text-sm">
        <p>{tCommon(errorMessageKey(report.error))}</p>
        <Button type="button" variant="outline" onClick={() => void report.refetch()}>
          {t('report.retry')}
        </Button>
      </div>
    );
  } else if (report.data?.status === 'signed') {
    body = <SignedReport report={report.data} />;
  } else if (report.data) {
    body = (
      <>
        <p className="text-sm font-medium">{t('report.draftNotice')}</p>
        <ReportText report={report.data} />
      </>
    );
  } else {
    body = <p className="text-sm text-muted-foreground">{t('report.none')}</p>;
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h2 id={headingId} data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t(signed ? 'report.headingSigned' : 'report.heading', { study: item.itemName })}
      </h2>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">{t('schedule.patient')}</dt>
          <dd>{item.patientName}</dd>
        </div>
        {item.patientDob && (
          <div>
            <dt className="text-muted-foreground">{t('schedule.dob')}</dt>
            <dd>{format.calendarDate(item.patientDob)}</dd>
          </div>
        )}
        <div>
          <dt className="text-muted-foreground">{t('schedule.modality')}</dt>
          <dd>{t(`modality.${item.modality}`)}</dd>
        </div>
        {item.study?.performedAt && (
          <div>
            <dt className="text-muted-foreground">{t('report.performed')}</dt>
            <dd>
              {t('list.study.performed', {
                time: format.dateTime(item.study.performedAt),
                name: item.study.performedByName ?? '',
              })}
            </dd>
          </div>
        )}
        {item.instructions && (
          <div className="sm:col-span-2">
            <dt className="text-muted-foreground">{t('schedule.instructions')}</dt>
            <dd className="break-words">{item.instructions}</dd>
          </div>
        )}
      </dl>
      {body}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          {t('close')}
        </Button>
      </div>
    </section>
  );
}

/** The parts of a report as written, read only: those with no text are left out. */
function ReportText({ report }: { report: ImagingReport }) {
  const { t } = useTranslation('radiology');
  const parts = [
    ['technique', report.technique],
    ['findings', report.findings],
    ['impression', report.impression],
  ] as const;
  return (
    <div className="flex flex-col gap-3">
      {parts.map(([part, document]) =>
        isEmptyRichText(sanitizeRichText(document)) ? null : (
          <div key={part} className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">{t(`report.parts.${part}`)}</h3>
            <RichTextView document={document} className="break-words" />
          </div>
        ),
      )}
      {report.links.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">{t('report.links.heading')}</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {report.links.map((link, index) => (
              <li key={`${link.url}:${index}`} className="break-all">
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2"
                >
                  {link.label}
                </a>{' '}
                <span className="text-muted-foreground">{t('report.links.opensElsewhere')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** What the placeholders of an imaging report template are filled with, for this study. */
function usePlaceholderValues(item: ImagingWorkItem): Record<string, string> {
  const { t } = useTranslation('radiology');
  const format = useFormatters();
  const tenant = useTenant();
  const userName = useSession()?.user.name;
  return useMemo(() => {
    const values: Record<string, string> = {
      'patient.name': item.patientName,
      'patient.mrn': item.patientMrn,
      'patient.sex': t(`sex.${item.patientSex}`, { defaultValue: '' }),
      'study.name': item.itemName,
      'study.modality': t(`modality.${item.modality}`),
      'date.today': format.date(new Date().toISOString()),
    };
    if (item.patientDob) {
      const age = ageOf(item.patientDob, todayIn(tenant?.timezone ?? 'UTC'));
      values['patient.age'] =
        age.years > 0
          ? t('report.age', { count: age.years })
          : t('report.ageMonths', { count: age.months });
    }
    if (tenant?.name) values['hospital.name'] = tenant.name;
    if (userName) values['doctor.name'] = userName;
    // A value that came out empty is left out, so its placeholder stays to be seen.
    return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ''));
  }, [item, t, format, tenant, userName]);
}

interface Texts {
  technique: RichTextDocument;
  findings: RichTextDocument;
  impression: RichTextDocument;
}

const textsOf = (report: ImagingReport | null | undefined): Texts => ({
  technique: report ? sanitizeRichText(report.technique) : EMPTY_DOCUMENT,
  findings: report ? sanitizeRichText(report.findings) : EMPTY_DOCUMENT,
  impression: report ? sanitizeRichText(report.impression) : EMPTY_DOCUMENT,
});

/**
 * The draft: three editors, the template, the links, Save draft and Sign. Works from a snapshot
 * of the report as the panel opened it; what is typed stays in memory until it is saved, and each
 * save sends the whole draft from the version held (409 `conflict` when someone saved meanwhile,
 * which asks whether to keep this text or take the saved one).
 */
function ReportDraft({
  item,
  saved,
  onSigned,
}: {
  item: ImagingWorkItem;
  saved: ImagingReport | null;
  onSigned: () => void;
}) {
  const { t } = useTranslation('radiology');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const canSign = usePermission('imagingReport:sign');
  const save = useSaveReport();
  const sign = useSignReport();
  const report = useReport(item.orderId);

  // What the editors started from, and a key that remounts them when that changes.
  const [start, setStart] = useState(() => ({ texts: textsOf(saved), key: 0 }));
  const texts = useRef<Texts>(start.texts);
  const [version, setVersion] = useState(saved?.version);
  const [links, setLinks] = useState<ImagingLink[]>(saved?.links ?? []);
  const [template, setTemplate] = useState(
    saved?.templateId && saved.templateVersion
      ? { id: saved.templateId, version: saved.templateVersion }
      : null,
  );
  const [dirty, setDirty] = useState(saved === null);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<{ text: string; code?: string } | null>(null);
  const [findingsEmpty, setFindingsEmpty] = useState(() => isEmptyRichText(start.texts.findings));
  const [line, setLine] = useState('');

  const status = useRef<HTMLParagraphElement>(null);
  const alert = useRef<HTMLDivElement>(null);
  const busy = save.isPending || sign.isPending;
  useLayoutEffect(() => {
    if (problem) focusIfLost(alert.current);
  }, [problem]);
  // Sign makes way for the confirmation, and Back for Sign again: focus follows.
  const confirmBox = useRef<HTMLDivElement>(null);
  const buttons = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (confirming) confirmBox.current?.querySelector('button')?.focus();
  }, [confirming]);
  const back = () => {
    setConfirming(false);
    requestAnimationFrame(() =>
      focusIfLost(buttons.current?.querySelector<HTMLElement>('button:last-of-type') ?? null),
    );
  };

  const edit = (part: keyof Texts, document: RichTextDocument) => {
    texts.current = { ...texts.current, [part]: document };
    if (part === 'findings') setFindingsEmpty(isEmptyRichText(document));
    setDirty(true);
  };

  /** Puts a report's text in the editors, as when the panel opened it. */
  const restart = (from: ImagingReport | null | undefined) => {
    const next = textsOf(from);
    texts.current = next;
    setFindingsEmpty(isEmptyRichText(next.findings));
    setStart((now) => ({ texts: next, key: now.key + 1 }));
    setLinks(from?.links ?? []);
    setTemplate(
      from?.templateId && from.templateVersion
        ? { id: from.templateId, version: from.templateVersion }
        : null,
    );
    setVersion(from?.version);
    setDirty(false);
  };

  const refused = (error: unknown) => {
    const code = refusalOf(error);
    setProblem({
      text: code && REFUSED[code] ? t(REFUSED[code]) : tCommon(errorMessageKey(error)),
      ...(code ? { code } : {}),
    });
  };

  /** Saves the whole draft from `from`, the version held unless said otherwise. */
  const send = async (from = version): Promise<ImagingReport | null> => {
    setProblem(null);
    try {
      const done = await save.mutateAsync({
        orderId: item.orderId,
        draft: {
          technique: texts.current.technique as unknown as Record<string, unknown>,
          findings: texts.current.findings as unknown as Record<string, unknown>,
          impression: texts.current.impression as unknown as Record<string, unknown>,
          links,
          ...(template ? { templateId: template.id, templateVersion: template.version } : {}),
          ...(from === undefined ? {} : { version: from }),
        },
      });
      setVersion(done.version);
      setDirty(false);
      setLine(t('report.saved', { time: format.time(done.updatedAt) }));
      return done;
    } catch (error) {
      refused(error);
      return null;
    }
  };

  /** What signing would be refused for, checked here first: the server checks again. */
  const unready = (): string | null => {
    const { technique, findings, impression } = texts.current;
    if (isEmptyRichText(findings) || isEmptyRichText(impression)) {
      return t('report.refused.incomplete');
    }
    if ([technique, findings, impression].some((part) => placeholdersIn(part).length > 0)) {
      return t('report.refused.placeholders');
    }
    return null;
  };

  const askToSign = () => {
    if (busy) return;
    const why = unready();
    if (why) {
      setProblem({ text: why });
      return;
    }
    setProblem(null);
    setConfirming(true);
  };

  const signNow = async () => {
    if (busy) return;
    const current = dirty || version === undefined ? await send() : { version };
    if (!current || current.version === undefined) {
      setConfirming(false);
      return;
    }
    try {
      await sign.mutateAsync({ orderId: item.orderId, version: current.version });
      setConfirming(false);
      onSigned();
    } catch (error) {
      setConfirming(false);
      refused(error);
    }
  };

  /** Someone saved meanwhile: this text over theirs, from the version now saved. */
  const keepMine = async () => {
    const latest = await report.refetch();
    if (latest.data) await send(latest.data.version);
  };
  const takeSaved = async () => {
    setProblem(null);
    const latest = await report.refetch();
    restart(latest.data);
    focusIfLost(status.current);
  };

  const signedElsewhere = report.data?.status === 'signed' && !sign.isPending && !sign.isSuccess;
  const final = signedElsewhere || (problem?.code !== undefined && FINAL.has(problem.code));
  const shown =
    problem ??
    (signedElsewhere ? { text: t('report.refused.signed'), code: 'report_signed' } : null);
  // The editors take no typing while a save or a sign is on its way, or once nothing can be sent.
  const editors = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (editors.current) editors.current.inert = busy || final;
  }, [busy, final]);

  return (
    <div className="flex flex-col gap-3">
      <TemplatePicker
        item={item}
        disabled={busy || final}
        replaces={!findingsEmpty}
        onFill={(findings, chosen) => {
          texts.current = { ...texts.current, findings };
          setFindingsEmpty(isEmptyRichText(findings));
          setStart((now) => ({
            texts: { ...texts.current },
            key: now.key + 1,
          }));
          setTemplate(chosen);
          setDirty(true);
          setLine(t('report.templateFilled'));
        }}
      />
      <div ref={editors} className="flex flex-col gap-3">
        <RichTextEditor
          key={`technique:${start.key}`}
          label={t('report.parts.technique')}
          initialValue={start.texts.technique}
          onChange={(document) => edit('technique', document)}
        />
        <RichTextEditor
          key={`findings:${start.key}`}
          label={t('report.parts.findings')}
          initialValue={start.texts.findings}
          onChange={(document) => edit('findings', document)}
        />
        <RichTextEditor
          key={`impression:${start.key}`}
          label={t('report.parts.impression')}
          initialValue={start.texts.impression}
          onChange={(document) => edit('impression', document)}
        />
      </div>
      <LinksEditor
        links={links}
        disabled={busy || final}
        onChange={(next) => {
          setLinks(next);
          setDirty(true);
        }}
      />
      <p
        ref={status}
        role="status"
        tabIndex={-1}
        className="text-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {line}
      </p>
      {shown && (
        <div
          ref={alert}
          role="alert"
          tabIndex={-1}
          className="flex flex-col items-start gap-2 text-sm text-destructive outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <p>{shown.text}</p>
          {shown.code === 'conflict' && (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (!busy) void keepMine();
                }}
              >
                {t('report.keepMine')}
              </Button>
              <Button
                type="button"
                variant="outline"
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (!busy) void takeSaved();
                }}
              >
                {t('report.useSaved')}
              </Button>
            </div>
          )}
        </div>
      )}
      {confirming ? (
        <div
          ref={confirmBox}
          className="flex flex-col gap-2 rounded-md border border-destructive/40 p-3"
        >
          <p className="text-sm font-medium">{t('report.confirmSign')}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" aria-disabled={busy || undefined} onClick={() => void signNow()}>
              {busy ? t('report.signing') : t('report.signNow')}
            </Button>
            <Button type="button" variant="outline" onClick={back}>
              {t('report.back')}
            </Button>
          </div>
        </div>
      ) : (
        !final && (
          <div ref={buttons} className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) void send();
              }}
            >
              {save.isPending ? t('report.saving') : t('report.saveDraft')}
            </Button>
            {canSign && (
              <Button type="button" aria-disabled={busy || undefined} onClick={askToSign}>
                {t('report.sign')}
              </Button>
            )}
          </div>
        )
      )}
    </div>
  );
}

/**
 * The hospital's imaging report templates, for whoever may read templates while the templates
 * module is on: the chosen one's newest text, filled in for this study, replaces the findings.
 */
function TemplatePicker({
  item,
  disabled,
  replaces,
  onFill,
}: {
  item: ImagingWorkItem;
  disabled: boolean;
  /** The findings have text, which filling replaces: the button says so. */
  replaces: boolean;
  onFill: (findings: RichTextDocument, template: { id: string; version: number }) => void;
}) {
  const { t } = useTranslation('radiology');
  const allowed = useAllowed({ requires: 'template:read', featureFlag: 'templates' });
  const { list, load } = useTemplateChoices('imaging_report', { enabled: allowed });
  const values = usePlaceholderValues(item);
  const fieldId = useId();
  const hintId = useId();
  const [chosen, setChosen] = useState('');
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  if (!allowed) return null;
  const templates = list.data?.items ?? [];
  if (list.isSuccess && templates.length === 0) return null;

  const fill = async () => {
    if (!chosen || loading || disabled) return;
    setFailed(false);
    setLoading(true);
    try {
      const detail = await load(chosen);
      onFill(fillPlaceholders(detail.body, values), {
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
        {t('report.template.label')}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <select
          id={fieldId}
          aria-describedby={hintId}
          className="h-9 w-full rounded-md border bg-background px-3 text-base sm:max-w-sm md:text-sm pointer-coarse:h-11 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          value={chosen}
          onChange={(event) => setChosen(event.target.value)}
        >
          <option value="">{t('report.template.choose')}</option>
          {templates.map((each) => (
            <option key={each.id} value={each.id}>
              {each.name}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="outline"
          aria-disabled={!chosen || loading || disabled || undefined}
          onClick={() => void fill()}
        >
          {t(replaces ? 'report.template.replace' : 'report.template.fill')}
        </Button>
      </div>
      <p id={hintId} className="text-sm text-muted-foreground">
        {t('report.template.hint')}
      </p>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {t('report.template.failed')}
        </p>
      )}
    </div>
  );
}

/** The links of a draft: each with Remove, and a form to add one, up to the API's limit. */
function LinksEditor({
  links,
  disabled,
  onChange,
}: {
  links: ImagingLink[];
  disabled: boolean;
  onChange: (links: ImagingLink[]) => void;
}) {
  const { t } = useTranslation('radiology');
  const form = useZodForm(linkSchema, { label: '', url: '' });
  const headingId = useId();
  const add = (values: LinkOutput) => {
    if (disabled || links.length >= MAX_LINKS) return;
    onChange([...links, { label: values.label, url: values.url }]);
    form.reset({ label: '', url: '' });
  };
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} tabIndex={-1} className="text-sm font-semibold outline-none">
        {t('report.links.heading')}
      </h3>
      <p className="text-sm text-muted-foreground">{t('report.links.hint')}</p>
      {links.length > 0 && (
        <ul className="flex flex-col gap-2">
          {links.map((link, index) => (
            <li key={`${link.url}:${index}`} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="min-w-0 break-all">
                {link.label} <span className="text-muted-foreground">{link.url}</span>
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-disabled={disabled || undefined}
                aria-label={t('report.links.remove', { label: link.label })}
                onClick={() => {
                  if (disabled) return;
                  onChange(links.filter((_, at) => at !== index));
                  focusIfLost(document.getElementById(headingId));
                }}
              >
                {t('report.links.removeShort')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {links.length < MAX_LINKS ? (
        <Form form={form} onSubmit={add}>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <TextField<LinkValues> name="label" label={t('report.links.label')} required />
            <TextField<LinkValues>
              name="url"
              type="url"
              inputMode="url"
              autoComplete="off"
              label={t('report.links.url')}
              required
            />
          </div>
          <div>
            <SubmitButton variant="outline" disabled={disabled}>
              {t('report.links.add')}
            </SubmitButton>
          </div>
        </Form>
      ) : (
        <p className="text-sm text-muted-foreground">{t('report.links.full')}</p>
      )}
    </section>
  );
}

/** A signed report: who signed it and when, its text, its addenda, and a form to add one. */
function SignedReport({ report }: { report: ImagingReport }) {
  const { t } = useTranslation('radiology');
  const format = useFormatters();
  const canSign = usePermission('imagingReport:sign');
  const [adding, setAdding] = useState(false);
  const [line, setLine] = useState('');
  const status = useRef<HTMLParagraphElement>(null);
  // Holds the Add addendum button, which focus goes back to when the form is cancelled.
  const addButton = useRef<HTMLDivElement>(null);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        {t('report.signedBy', {
          name: report.signedByName ?? '',
          time: report.signedAt ? format.dateTime(report.signedAt) : '',
        })}
      </p>
      <ReportText report={report} />
      {report.addenda.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{t('report.addenda.heading')}</h3>
          <ol className="flex flex-col gap-3">
            {report.addenda.map((addendum) => (
              <li key={addendum.id} className="flex flex-col gap-1 border-l-2 pl-3">
                <p className="text-sm text-muted-foreground">
                  {t('report.addenda.by', {
                    reason: t(`report.addenda.reasons.${addendum.reason}`),
                    name: addendum.signedByName,
                    time: format.dateTime(addendum.signedAt),
                  })}
                </p>
                <RichTextView document={addendum.body} className="break-words" />
              </li>
            ))}
          </ol>
        </div>
      )}
      <p
        ref={status}
        role="status"
        tabIndex={-1}
        className="text-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {line}
      </p>
      {canSign &&
        (adding ? (
          <AddendumForm
            report={report}
            onCancel={() => {
              setAdding(false);
              requestAnimationFrame(() => addButton.current?.querySelector('button')?.focus());
            }}
            onAdded={() => {
              setAdding(false);
              setLine(t('report.addenda.added'));
              requestAnimationFrame(() => focusIfLost(status.current));
            }}
          />
        ) : (
          <div ref={addButton}>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setLine('');
                setAdding(true);
              }}
            >
              {t('report.addenda.add')}
            </Button>
          </div>
        ))}
    </div>
  );
}

function AddendumForm({
  report,
  onCancel,
  onAdded,
}: {
  report: ImagingReport;
  onCancel: () => void;
  onAdded: () => void;
}) {
  const { t } = useTranslation('radiology');
  const { t: tCommon } = useTranslation();
  const add = useAddAddendum();
  const form = useZodForm(addendumSchema, { reason: '' as AddendumValues['reason'] });
  const body = useRef<RichTextDocument>(EMPTY_DOCUMENT);
  const [empty, setEmpty] = useState(false);
  const headingId = useId();
  const errorId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => heading.current?.focus(), []);

  // The text is not a kit field: it is checked as the button is pressed, with the reason, and
  // takes focus first, as it comes first in the form.
  const editorBox = useRef<HTMLDivElement>(null);
  const checkText = () => {
    const missing = isEmptyRichText(body.current);
    setEmpty(missing);
    if (missing) {
      requestAnimationFrame(() =>
        editorBox.current?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus(),
      );
    }
  };

  const submit = async (values: AddendumOutput) => {
    if (isEmptyRichText(body.current)) return;
    add.reset();
    try {
      await add.mutateAsync({ orderId: report.orderId, body: body.current, reason: values.reason });
      onAdded();
    } catch {
      // Said from the mutation state.
    }
  };

  const code = refusalOf(add.error);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h3 ref={heading} id={headingId} tabIndex={-1} className="font-semibold outline-none">
        {t('report.addenda.heading_new')}
      </h3>
      <p className="text-sm text-muted-foreground">{t('report.addenda.hint')}</p>
      <div ref={editorBox}>
        <RichTextEditor
          label={t('report.addenda.text')}
          invalid={empty}
          describedBy={empty ? errorId : undefined}
          onChange={(document) => {
            body.current = document;
            if (empty && !isEmptyRichText(document)) setEmpty(false);
          }}
        />
      </div>
      {empty && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {t('report.addenda.empty')}
        </p>
      )}
      <Form form={form} onSubmit={submit}>
        <SelectField<AddendumValues>
          name="reason"
          label={t('report.addenda.reason')}
          required
          placeholder={t('report.addenda.chooseReason')}
          options={ADDENDUM_REASONS.map((reason) => ({
            value: reason,
            label: t(`report.addenda.reasons.${reason}`),
          }))}
        />
        {add.error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {code && REFUSED[code] ? t(REFUSED[code]) : tCommon(errorMessageKey(add.error))}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending={add.isPending} onClick={checkText}>
            {add.isPending ? t('report.addenda.signing') : t('report.addenda.sign')}
          </SubmitButton>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('report.back')}
          </Button>
        </div>
      </Form>
    </section>
  );
}
