import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { RichTextView } from '@/shared/ui/rich-text';
import { useFormatters } from '@/tenancy';
import { useConsent } from '../hooks/use-consents';
import type { Consent } from '../types';
import { ConsentDocument, PrintRecordButton } from './PrintRecord';
import { SignatureView } from './SignaturePad';

/**
 * A signed consent as it was kept (MR-02, #190): the text, who signed and how, who recorded it.
 * Read only, for good: a signed consent has no edit and no delete, here or in the API. Shown in
 * place, with `data-panel-heading` for the panel's focus.
 */
export function ConsentView({ consent, onClose }: { consent: Consent; onClose: () => void }) {
  const { t } = useTranslation('consents');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const detail = useConsent(consent.id);
  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <h3 data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('view.heading', { procedure: consent.procedureName })}
      </h3>
      <p className="text-sm text-muted-foreground">{t('view.immutable')}</p>
      {detail.isPending && <p role="status">{t('view.loading')}</p>}
      {detail.isError && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(detail.error))}
        </p>
      )}
      {detail.data && (
        <>
          <RichTextView document={detail.data.body} className="break-words" />
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
            <dt className="font-medium">{t('view.signedBy')}</dt>
            <dd>
              {t('view.signer', {
                name: consent.signerName,
                role: t(`signer.${consent.signerRole}`),
              })}
            </dd>
            <dt className="font-medium">{t('view.signedAt')}</dt>
            <dd>{format.dateTime(consent.signedAt)}</dd>
            <dt className="font-medium">{t('view.recordedBy')}</dt>
            <dd>{consent.signedByName}</dd>
            <dt className="font-medium">{t('view.version')}</dt>
            <dd>{t('view.versionValue', { version: consent.templateVersion })}</dd>
          </dl>
          {detail.data.signature ? (
            <SignatureView
              path={detail.data.signature}
              label={t('view.signatureOf', { name: consent.signerName })}
            />
          ) : (
            <p className="text-sm">{t('view.typedSignature', { name: consent.signerName })}</p>
          )}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        {detail.data && (
          <PrintRecordButton>
            <ConsentDocument consent={consent} detail={detail.data} />
          </PrintRecordButton>
        )}
        <Button type="button" variant="outline" onClick={onClose}>
          {t('close')}
        </Button>
      </div>
    </div>
  );
}
