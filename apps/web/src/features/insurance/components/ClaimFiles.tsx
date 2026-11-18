import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { fetchFileUrl } from '../claims';
import { useAttachableDocuments, useChangeClaimFiles, useClaimFiles } from '../hooks/use-claims';

const control =
  'h-9 min-w-0 max-w-full rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';

/** The claim states in which files may still be added or taken out. */
const OPEN = ['draft', 'submitted', 'query'];

/**
 * The files of a claim packet (#976): documents from the patient's record, linked to the claim.
 * Shown only to someone who may read documents; adding and removing need `claim:manage`.
 */
export function ClaimFiles({
  claimId,
  patientId,
  claimStatus,
}: {
  claimId: string;
  patientId: string;
  claimStatus: string;
}) {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const canRead = usePermission('document:read');
  const canManage = usePermission('claim:manage') && OPEN.includes(claimStatus);
  const files = useClaimFiles(claimId, canRead);
  const choices = useAttachableDocuments(patientId, canRead && canManage);
  const change = useChangeClaimFiles(claimId);
  const [chosen, setChosen] = useState('');
  const [message, setMessage] = useState('');
  const status = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (message) focusIfLost(status.current);
  }, [message]);

  if (!canRead) return null;
  const attached = new Set((files.data ?? []).map((file) => file.documentId));
  const offered = (choices.data ?? []).filter((one) => !attached.has(one.id));
  const run = (documentId: string, attach: boolean) => {
    if (change.isPending) return;
    setMessage('');
    void change
      .mutateAsync({ documentId, attach })
      .then(() => {
        setChosen('');
        setMessage(t(attach ? 'claims.files.attached' : 'claims.files.removed'));
      })
      .catch(() => undefined);
  };
  const open = (documentId: string) => {
    void fetchFileUrl(documentId)
      .then((url) => window.open(url, '_blank', 'noopener,noreferrer'))
      .catch(() => setMessage(t('claims.files.openFailed')));
  };

  return (
    <section aria-labelledby="claim-files" className="flex flex-col gap-2">
      <h2 id="claim-files" className="text-lg font-semibold">
        {t('claims.files.heading')}
      </h2>
      {/* Always on the page, so a change is announced. */}
      <p ref={status} role="status" tabIndex={-1} className={message ? 'text-sm' : 'sr-only'}>
        {message}
      </p>
      {files.isPending ? (
        <p className="text-sm text-muted-foreground">{t('claims.files.loading')}</p>
      ) : files.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(files.error))}
        </p>
      ) : files.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('claims.files.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {files.data.map((file) => (
            <li
              key={file.documentId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2"
            >
              <span>
                <span className="font-medium">{file.title}</span>{' '}
                <span className="text-muted-foreground">
                  {file.fileName}
                  {file.retired ? ` (${t('claims.files.retired')})` : ''}
                </span>
              </span>
              <span className="flex gap-2">
                {file.status === 'clean' && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => open(file.documentId)}
                  >
                    {t('claims.files.open')}
                    <span className="sr-only"> {file.title}</span>
                  </Button>
                )}
                {canManage && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-disabled={change.isPending}
                    onClick={() => run(file.documentId, false)}
                  >
                    {t('claims.files.remove')}
                    <span className="sr-only"> {file.title}</span>
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {change.isError && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(change.error))}
        </p>
      )}
      {canManage && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t('claims.files.choose')}
            <select
              value={chosen}
              onChange={(event) => setChosen(event.target.value)}
              className={control}
            >
              <option value="">{t('claims.files.none')}</option>
              {offered.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.title}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            aria-disabled={chosen === '' || change.isPending}
            onClick={() => chosen !== '' && run(chosen, true)}
          >
            {t('claims.files.attach')}
          </Button>
        </div>
      )}
      <p className="text-sm text-muted-foreground">{t('claims.files.hint')}</p>
    </section>
  );
}
