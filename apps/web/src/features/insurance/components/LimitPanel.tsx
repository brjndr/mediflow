import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import type { SlotProps } from '@/registry';
import { Button } from '@/shared/ui/button';
import { StatusBadge, type StatusTone } from '@/shared/ui/status-badge';
import { useFormatters } from '@/tenancy';
import { useEncounterPreAuths, usePatientPolicies } from '../hooks/use-coverage';
import type { PreAuthStatus } from '../types';
import { LimitMeter } from './LimitMeter';
import { PreAuthDialog } from './PreAuthDialogs';

const TONE: Record<PreAuthStatus, StatusTone> = {
  submitted: 'info',
  approved: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
};

/** Same ids as the patient's screen: both come from the slot's context. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The cover a visit bills against (`invoice.builder.panels`, #182), for `preauth:read`: each
 * approved pre-authorization with its limit, what the visit has been charged so far and a
 * warning once the bill nears the limit or passes it, so the desk sees it before issuing the
 * invoice. Requests still waiting for the payer and refusals are listed; `preauth:manage` can
 * raise a request for the visit from here. Shows nothing for a visit without any.
 */
export default function LimitPanel({ context }: SlotProps) {
  const { t } = useTranslation('insurance');
  const format = useFormatters();
  const canRead = usePermission('preauth:read');
  const canManage = usePermission('preauth:manage');
  const canReadPolicies = usePermission('policy:read');
  const encounterId =
    typeof context?.encounterId === 'string' && ID.test(context.encounterId)
      ? context.encounterId
      : '';
  const patientId =
    typeof context?.patientId === 'string' && ID.test(context.patientId) ? context.patientId : '';
  const preAuths = useEncounterPreAuths(encounterId, canRead);
  const policies = usePatientPolicies(patientId, canManage && canReadPolicies && patientId !== '');
  const [asking, setAsking] = useState(false);
  const [saved, setSaved] = useState(false);
  if (!canRead || encounterId === '') return null;

  const items = (preAuths.data ?? []).filter((item) => item.status !== 'cancelled');
  const active = (policies.data ?? []).filter((policy) => policy.status === 'active');
  const canAsk = canManage && patientId !== '' && active.length > 0;
  if (items.length === 0 && !canAsk && !saved) return null;

  return (
    <section aria-labelledby="limit-heading" className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="limit-heading" className="text-lg font-semibold">
          {t('limit.heading')}
        </h2>
        {canAsk && (
          <Button type="button" variant="outline" size="sm" onClick={() => setAsking(true)}>
            {t('preauth.add.button')}
          </Button>
        )}
      </div>
      <p role="status" className={saved ? 'text-sm' : 'sr-only'}>
        {saved ? t('preauth.add.saved') : ''}
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('limit.none')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.id} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">
                  {item.payerName}, {item.treatment}
                </span>
                <StatusBadge tone={TONE[item.status]} label={t(`preauth.status.${item.status}`)} />
              </div>
              {item.status === 'approved' && item.approvedMinor !== undefined ? (
                <LimitMeter billedMinor={item.billedMinor} approvedMinor={item.approvedMinor} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {item.status === 'submitted'
                    ? t('limit.waiting', { amount: format.money(item.requestedMinor) })
                    : t('limit.refused')}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {asking && (
        <PreAuthDialog
          patientId={patientId}
          policies={active}
          encounterId={encounterId}
          onClose={() => setAsking(false)}
          onSaved={() => {
            setAsking(false);
            setSaved(true);
          }}
        />
      )}
    </section>
  );
}
