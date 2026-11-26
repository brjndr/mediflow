import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DOCUMENT_TYPES,
  fileProblem,
  UploadRefused,
  useUploadDocument,
} from '@/features/documents';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import type { PaperSubject } from '../api';
import { usePaperVisit } from '../hooks/use-paper-visit';
import { REASON_MAX, reasonSchema, type ReasonValues } from '../schemas';
import type { PaperVisit } from '../types';

/** Refusals the person can act on, by the server's code. Anything else is the common message. */
const REFUSED: Record<string, string> = {
  token_without_doctor: 'paper.errors.noDoctor',
  unknown_doctor: 'paper.errors.noDoctor',
  token_not_found: 'paper.errors.tokenGone',
  token_cancelled: 'paper.errors.tokenGone',
  already_open: 'paper.errors.alreadyOpen',
  not_opd_visit: 'paper.errors.notOpd',
  opd_sheet_required: 'paper.errors.sheetRequired',
  unsigned_notes: 'paper.errors.unsignedNotes',
  has_records: 'paper.errors.hasRecords',
  managed_by_admission: 'paper.errors.managed',
  managed_by_emergency: 'paper.errors.managed',
  conflict: 'paper.errors.conflict',
  invalid_transition: 'paper.errors.conflict',
  already_retired: 'paper.errors.conflict',
  file_type_not_allowed: 'paper.errors.type',
  file_too_large: 'paper.errors.size',
  patient_merged: 'paper.errors.merged',
};

/** What the file's own address answers, by status. */
const SENT_REFUSED: Record<number, string> = {
  413: 'paper.errors.size',
  415: 'paper.errors.type',
  400: 'paper.errors.rejected',
};

function useFailureText() {
  const { t } = useTranslation('clinical');
  const { t: tCommon } = useTranslation();
  return (error: unknown) => {
    if (!error) return '';
    if (error instanceof UploadRefused) {
      return t(SENT_REFUSED[error.status] ?? 'paper.errors.failed');
    }
    const code = isApiError(error) ? error.serverCode : undefined;
    const key = code === undefined ? undefined : REFUSED[code];
    return key ? t(key) : tCommon(errorMessageKey(error));
  };
}

/**
 * The dialog's content: who the paper must be for, the file, the caller's own sheets with a way
 * to retire a wrong one, and closing the visit. The file stays in memory until it is sent.
 */
export function PaperSheetPanel({
  subject,
  onBusy,
}: {
  subject: PaperSubject;
  onBusy: (busy: boolean) => void;
}) {
  const { t } = useTranslation('clinical');
  const paper = usePaperVisit(subject);
  const failureText = useFailureText();
  if (paper.query.isPending) return <p role="status">{t('paper.loading')}</p>;
  if (!paper.query.data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {failureText(paper.query.error)}
      </p>
    );
  }
  return <Visit subject={subject} visit={paper.query.data} paper={paper} onBusy={onBusy} />;
}

function Visit({
  subject,
  visit,
  paper,
  onBusy,
}: {
  subject: PaperSubject;
  visit: PaperVisit;
  paper: ReturnType<typeof usePaperVisit>;
  onBusy: (busy: boolean) => void;
}) {
  const { t } = useTranslation('clinical');
  const failureText = useFailureText();
  const upload = useUploadDocument(visit.patientId);
  const cameraId = useId();
  const fileId = useId();
  const form = useRef<HTMLFormElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const [file, setFile] = useState<File>();
  const [problem, setProblem] = useState('');
  const [retiring, setRetiring] = useState<PaperVisit['sheets'][number]>();
  const [done, setDone] = useState({ text: '', count: 0 });
  const say = (text: string) => setDone((now) => ({ text, count: now.count + 1 }));
  const busy =
    paper.open.isPending || upload.isPending || paper.close.isPending || paper.retire.isPending;
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  // What had focus may be gone (a retired row, the close button): it goes to what was done. The
  // dialog takes focus itself when that happens, which counts as lost.
  useLayoutEffect(() => {
    if (done.count === 0) return;
    if (document.activeElement?.getAttribute('role') === 'dialog') status.current?.focus();
    else focusIfLost(status.current);
  }, [done, visit]);
  // "Keep it" goes back to the button that asked.
  const [keptId, setKeptId] = useState('');
  const sheetList = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    if (!keptId) return;
    sheetList.current?.querySelector<HTMLElement>(`[data-sheet="${keptId}"]`)?.focus();
    setKeptId('');
  }, [keptId]);
  // A token for no doctor opens no visit: said before a file is chosen.
  const noDoctor = 'tokenId' in subject && !visit.encounter && !visit.doctorName;

  const encounter = visit.encounter;
  const failure = problem || failureText(paper.open.error ?? upload.error ?? paper.close.error);
  const number = visit.tokenNumber;

  const reset = () => {
    setProblem('');
    paper.open.reset();
    upload.reset();
    paper.close.reset();
  };
  const choose = (input: HTMLInputElement) => {
    reset();
    const chosen = input.files?.[0];
    // One file at a time, from either control.
    for (const other of form.current?.querySelectorAll('input[type=file]') ?? []) {
      if (other !== input) (other as HTMLInputElement).value = '';
    }
    setFile(chosen);
    const found = chosen ? fileProblem(chosen) : undefined;
    setProblem(found ? t(`paper.${found.replace('upload.', '')}`) : '');
  };

  const attach = async () => {
    if (busy) return;
    reset();
    if (!file) return setProblem(t('paper.errors.none'));
    const found = fileProblem(file);
    if (found) return setProblem(t(`paper.${found.replace('upload.', '')}`));
    try {
      // The visit is opened only now, once the person has seen whom it is for.
      const encounterId =
        encounter?.id ??
        ('tokenId' in subject
          ? (await paper.open.mutateAsync(subject.tokenId)).encounter?.id
          : undefined);
      if (!encounterId) return;
      await upload.mutateAsync({
        category: 'opd_sheet',
        title:
          number === undefined
            ? t('paper.documentTitleNoToken')
            : t('paper.documentTitle', { number }),
        fileName: file.name,
        contentType: file.type,
        size: file.size,
        encounterId,
        file,
      });
      setFile(undefined);
      form.current?.reset();
      say(t('paper.attached'));
    } catch {
      // Said below, from the mutation state.
    } finally {
      await paper.refresh();
    }
  };

  const input = (id: string, label: string, accept: string, capture?: 'environment') => (
    <div className={capture ? 'hidden flex-col gap-1 pointer-coarse:flex' : 'flex flex-col gap-1'}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        type="file"
        accept={accept}
        capture={capture}
        disabled={busy}
        aria-describedby={`${fileId}-hint`}
        onChange={(event) => choose(event.target)}
        className="text-base md:text-sm pointer-coarse:min-h-11"
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">{t('paper.patient')}</dt>
        <dd className="font-semibold">
          {t('detail.patient', { name: visit.patientName, mrn: visit.patientMrn })}
        </dd>
        {number !== undefined && (
          <>
            <dt className="text-muted-foreground">{t('paper.token')}</dt>
            <dd className="font-semibold">{number}</dd>
          </>
        )}
        {visit.doctorName && (
          <>
            <dt className="text-muted-foreground">{t('paper.doctor')}</dt>
            <dd>{visit.doctorName}</dd>
          </>
        )}
      </dl>
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 empty:sr-only"
      >
        {done.text}
      </p>
      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
      {noDoctor && <p>{t('paper.errors.noDoctor')}</p>}
      {noDoctor ? null : encounter?.status === 'cancelled' ? (
        <p>{t('paper.isCancelled')}</p>
      ) : (
        <form
          ref={form}
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void attach();
          }}
        >
          <p className="text-sm">{t('paper.check')}</p>
          {input(cameraId, t('paper.camera'), 'image/jpeg,image/png', 'environment')}
          {input(fileId, t('paper.file'), DOCUMENT_TYPES.join(','))}
          <p id={`${fileId}-hint`} className="text-sm text-muted-foreground">
            {t('paper.fileHint')}
          </p>
          {file && <p className="text-sm break-all">{t('paper.chosen', { name: file.name })}</p>}
          {/* The name and token are on the button: pressing it confirms them. */}
          <Button
            type="submit"
            aria-disabled={busy || undefined}
            className="h-auto min-h-10 self-start whitespace-normal pointer-coarse:h-auto pointer-coarse:min-h-11"
          >
            {paper.open.isPending || upload.isPending
              ? t('paper.submitting')
              : number === undefined
                ? t('paper.submitNoToken', { name: visit.patientName })
                : t('paper.submit', { name: visit.patientName, number })}
          </Button>
        </form>
      )}
      {encounter && visit.sheets.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="font-semibold">{t('paper.sheets')}</h3>
          <ul ref={sheetList} className="flex flex-col gap-2">
            {visit.sheets.map((sheet) => (
              <li key={sheet.id} className="flex flex-col gap-2 rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm break-all">
                    {sheet.fileName}
                    {' · '}
                    {t(`paper.state.${sheet.status}`)}
                  </span>
                  {retiring?.id !== sheet.id && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-sheet={sheet.id}
                      aria-label={t('paper.retireNamed', { name: sheet.fileName })}
                      aria-disabled={busy || undefined}
                      onClick={() => {
                        if (busy) return;
                        paper.retire.reset();
                        setRetiring(sheet);
                      }}
                    >
                      {t('paper.retire')}
                    </Button>
                  )}
                </div>
                {retiring?.id === sheet.id && (
                  <RetireSheet
                    name={sheet.fileName}
                    pending={paper.retire.isPending}
                    failure={failureText(paper.retire.error)}
                    onKeep={() => {
                      setRetiring(undefined);
                      setKeptId(sheet.id);
                    }}
                    onRetire={(reason) =>
                      paper.retire.mutate(
                        {
                          encounterId: encounter.id,
                          id: sheet.id,
                          version: sheet.version,
                          reason,
                        },
                        {
                          onSuccess: () => {
                            setRetiring(undefined);
                            say(t('paper.retired'));
                          },
                          // Retired or changed elsewhere: the row may be gone, so say it above.
                          onError: (error) => {
                            const code = isApiError(error) ? error.serverCode : undefined;
                            if (code !== 'already_retired' && code !== 'document_not_found') {
                              return;
                            }
                            setRetiring(undefined);
                            say(t('paper.errors.conflict'));
                          },
                        },
                      )
                    }
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {encounter?.status === 'closed' && <p className="text-sm">{t('paper.isClosed')}</p>}
      {encounter?.status === 'open' && visit.hasSheet && (
        <Button
          type="button"
          className="self-start"
          aria-disabled={busy || undefined}
          onClick={() => {
            if (busy) return;
            reset();
            paper.close.mutate(
              { id: encounter.id, version: encounter.version },
              { onSuccess: () => say(t('paper.closed')) },
            );
          }}
        >
          {paper.close.isPending ? t('paper.closing') : t('paper.closeVisit')}
        </Button>
      )}
    </div>
  );
}

function RetireSheet({
  name,
  pending,
  failure,
  onKeep,
  onRetire,
}: {
  name: string;
  pending: boolean;
  failure: string;
  onKeep: () => void;
  onRetire: (reason: string) => void;
}) {
  const { t } = useTranslation('clinical');
  const form = useZodForm(reasonSchema, { reason: '' });
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <div className="flex flex-col gap-2">
      <h4 ref={heading} tabIndex={-1} className="font-medium break-all outline-none">
        {t('paper.retireHeading', { name })}
      </h4>
      <p className="text-sm text-muted-foreground">{t('paper.retireHint')}</p>
      <Form form={form} onSubmit={(values: ReasonValues) => onRetire(values.reason)}>
        <TextField<ReasonValues>
          name="reason"
          label={t('paper.retireReason')}
          required
          maxLength={REASON_MAX}
          autoComplete="off"
        />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending={pending} variant="destructive">
            {t('paper.retireSubmit')}
          </SubmitButton>
          <Button type="button" variant="outline" onClick={onKeep}>
            {t('paper.keep')}
          </Button>
        </div>
      </Form>
    </div>
  );
}
