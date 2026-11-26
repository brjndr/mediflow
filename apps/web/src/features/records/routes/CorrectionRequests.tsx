import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CorrectionsGrid } from '../components/CorrectionsGrid';
import { RecordsNav } from '../components/RecordsNav';
import { CORRECTION_STATUSES } from '../schemas';
import type { CorrectionStatus } from '../types';

const field =
  'h-9 w-full rounded-md border bg-background px-3 text-base md:text-sm pointer-coarse:h-11 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

/**
 * Requests to correct a record (`records/corrections`, #191), for `correction:read` with the
 * scope all. A correction is a request with its author and reason, never a silent edit: a second
 * person (`correction:decide`) approves or rejects it with a reason.
 */
export default function CorrectionRequests() {
  const { t } = useTranslation('records');
  const statusId = useId();
  const [status, setStatus] = useState<CorrectionStatus | ''>('pending');
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('corrections.heading')}</h1>
      <RecordsNav />
      <p className="text-sm text-muted-foreground">{t('corrections.intro')}</p>
      <div className="flex flex-col gap-1.5 md:max-w-xs">
        <label htmlFor={statusId} className="text-sm font-medium">
          {t('corrections.show')}
        </label>
        <select
          id={statusId}
          className={field}
          value={status}
          onChange={(event) => setStatus(event.target.value as CorrectionStatus | '')}
        >
          {CORRECTION_STATUSES.map((each) => (
            <option key={each} value={each}>
              {t(`corrections.status.${each}`)}
            </option>
          ))}
          <option value="">{t('corrections.all')}</option>
        </select>
      </div>
      <CorrectionsGrid status={status} label={t('corrections.heading')} />
    </div>
  );
}
