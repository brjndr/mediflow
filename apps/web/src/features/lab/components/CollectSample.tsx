import { useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { useFormatters } from '@/tenancy';
import { useCollectSample } from '../hooks/use-lab';
import type { LabSample, LabWorkItem } from '../types';

/** Refusals the person can do nothing about here, in words of their own. */
const REFUSED: Record<string, string> = {
  already_collected: 'collect.refused.alreadyCollected',
  invalid_transition: 'collect.refused.notActive',
  order_not_found: 'collect.refused.gone',
};

/**
 * Collecting the sample of a lab order (#90): who it is from, to be checked against the patient
 * (name, MRN and date of birth), the test, the sample and its container, the doctor's
 * instructions, and why the last sample was rejected. One press collects one sample; the server
 * gives its accession id, and the label can be printed straight away. Shown in place, with
 * `data-panel-heading` for the panel's focus.
 */
export function CollectSample({
  item,
  onClose,
  onPrint,
  printing,
}: {
  item: LabWorkItem;
  onClose: () => void;
  onPrint: (sample: LabSample) => void;
  printing: boolean;
}) {
  const { t } = useTranslation('lab');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const collect = useCollectSample();
  const [collected, setCollected] = useState<LabSample>();
  const rejected = item.sample?.status === 'rejected' ? item.sample : undefined;

  const code = isApiError(collect.error) ? collect.error.serverCode : undefined;
  const failure = collect.error
    ? code !== undefined && REFUSED[code]
      ? t(REFUSED[code])
      : tCommon(errorMessageKey(collect.error))
    : undefined;
  // A refusal that says the order cannot be collected now leaves nothing more to send: the
  // button goes, and focus goes to what it says.
  const refused = code !== undefined && REFUSED[code] !== undefined;
  const alert = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (refused) focusIfLost(alert.current);
  }, [refused]);
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h2 id={headingId} data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('collect.heading', { test: item.itemName })}
      </h2>
      <p className="text-sm">{t('collect.check')}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="font-medium">{t('collect.patient')}</dt>
        <dd>{item.patientName}</dd>
        <dt className="font-medium">{t('collect.mrn')}</dt>
        <dd>{item.patientMrn}</dd>
        {item.patientDob && (
          <>
            <dt className="font-medium">{t('collect.dob')}</dt>
            <dd>{format.calendarDate(item.patientDob)}</dd>
          </>
        )}
        <dt className="font-medium">{t('collect.sample')}</dt>
        <dd>
          {item.container
            ? t('collect.sampleIn', {
                sample: t(`sampleType.${item.sampleType}`),
                container: item.container,
              })
            : t(`sampleType.${item.sampleType}`)}
        </dd>
        <dt className="font-medium">{t('collect.priority')}</dt>
        <dd>{t(`priority.${item.priority}`)}</dd>
        {item.instructions && (
          <>
            <dt className="font-medium">{t('collect.instructions')}</dt>
            <dd>{item.instructions}</dd>
          </>
        )}
      </dl>
      {rejected?.rejectReason && (
        <p className="text-sm">
          {t('collect.recollect', {
            id: rejected.accessionId,
            reason: t(`rejectReason.${rejected.rejectReason}`),
          })}
          {rejected.rejectNote ? ` ${rejected.rejectNote}` : ''}
        </p>
      )}
      {failure && (
        <p
          ref={alert}
          role="alert"
          tabIndex={-1}
          className="text-sm text-destructive outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {failure}
        </p>
      )}
      <p role="status" className="min-h-5 text-sm font-medium">
        {collected ? t('collect.done', { id: collected.accessionId }) : ''}
      </p>
      <div className="flex flex-wrap gap-2">
        {/* One button that becomes "Print label" once collected, so focus stays on it. */}
        {!refused && (
          <Button
            key="action"
            type="button"
            aria-disabled={(collected ? printing : collect.isPending) || undefined}
            onClick={() => {
              if (collected) {
                if (!printing) onPrint(collected);
              } else if (!collect.isPending) {
                collect.mutate(item, { onSuccess: setCollected });
              }
            }}
          >
            {collected
              ? t('label.print')
              : collect.isPending
                ? t('collect.submitting')
                : t('collect.submit')}
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onClose}>
          {t('close')}
        </Button>
      </div>
    </section>
  );
}
