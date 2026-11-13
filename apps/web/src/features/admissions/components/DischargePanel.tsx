import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { usePermission } from '@/access';
import { useDischargeClearance } from '@/features/billing';
import { Button } from '@/shared/ui/button';
import { useDischargePlan } from '../hooks/use-discharge-plan';
import { DISCHARGE_TYPES, openClearances, type Admission, type DischargeType } from '../types';
import { DischargePlanSection } from './DischargePlanSection';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';

/** Ending one stay: how it ends, then confirm. The server decides whether the patient may go. */
export function DischargePanel({
  admission,
  pending,
  onSubmit,
  onBack,
}: {
  admission: Admission;
  pending: boolean;
  onSubmit: (type: DischargeType, billAcknowledged: boolean) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation('admissions');
  const [type, setType] = useState<DischargeType>('routine');
  const [confirmed, setConfirmed] = useState(false);
  // The bill against the hospital's policy (DS-04, #167): read only by someone who may see
  // charges; for anyone else the server decides alone.
  const bill = useDischargeClearance(admission.id);
  const settlement = bill.settlement;
  const unsettled =
    settlement !== undefined && settlement.policy !== 'off' && !settlement.clearance.cleared;
  // Under `block` only someone holding dischargeBill:override may go on, by confirming (the server
  // checks the same).
  const mayOverride = usePermission('dischargeBill:override');
  const blocked = unsettled && settlement.policy === 'block';
  const needsConfirm = unsettled && (settlement.policy === 'warn' || (blocked && mayOverride));
  // The plan (DS-01, #164): advice and clearances. Without one (no permission, or an API that
  // has none yet) nothing here waits for it and the server decides alone.
  const found = useDischargePlan(admission.id);
  const open = found.plan ? openClearances(found.plan, type) : [];
  const stopped =
    bill.pending ||
    found.pending ||
    open.length > 0 ||
    (blocked && !mayOverride) ||
    (needsConfirm && !confirmed);
  return (
    <section
      aria-labelledby="admission-discharge-heading"
      className="flex flex-col gap-3 rounded-md border p-4"
    >
      <h2
        id="admission-discharge-heading"
        data-panel-heading
        tabIndex={-1}
        className="rounded-sm text-lg font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {t('discharge.heading', { patient: admission.patientName })}
      </h2>
      <p className="text-sm text-muted-foreground">{t('discharge.description')}</p>
      <label className="flex max-w-xs flex-col gap-1 text-sm font-medium">
        {t('discharge.type')}
        <select
          value={type}
          onChange={(event) => setType(event.target.value as DischargeType)}
          className={control}
        >
          {DISCHARGE_TYPES.map((each) => (
            <option key={each} value={each}>
              {t(`discharge.types.${each}`)}
            </option>
          ))}
        </select>
      </label>
      {found.plan && (
        <>
          <DischargePlanSection admissionId={admission.id} plan={found.plan} type={type} />
          {open.length > 0 && (
            <p role="status" className="text-sm font-medium" data-testid="clearance-gate">
              {t('plan.gate', {
                kinds: open.map((kind) => t(`plan.clearances.kinds.${kind}`)).join(', '),
              })}
            </p>
          )}
        </>
      )}
      {bill.pending && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('discharge.bill.checking')}
        </p>
      )}
      {unsettled && (
        <div className="flex flex-col gap-2 rounded-md border p-3 text-sm" data-testid="bill-gate">
          <p className="font-medium">
            {blocked && !mayOverride ? t('discharge.bill.blocked') : t('discharge.bill.unsettled')}
          </p>
          <ul className="list-disc ps-5">
            {settlement.clearance.reasons.map((reason) => (
              <li key={reason}>{t(`discharge.bill.reasons.${reason}`)}</li>
            ))}
          </ul>
          <Link
            to={`/billing/stays/${admission.id}`}
            className="inline-flex w-fit items-center rounded-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11"
          >
            {t('discharge.bill.open')}
          </Link>
          {needsConfirm && (
            <label className="flex items-start gap-2 pointer-coarse:min-h-11">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                className="mt-1 size-4"
              />
              {blocked ? t('discharge.bill.override') : t('discharge.bill.confirm')}
            </label>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          aria-disabled={pending || stopped || undefined}
          onClick={() => {
            if (!pending && !stopped) onSubmit(type, needsConfirm && confirmed);
          }}
        >
          {t('discharge.submit')}
        </Button>
        <Button type="button" variant="outline" onClick={onBack}>
          {t('discharge.back')}
        </Button>
      </div>
    </section>
  );
}
