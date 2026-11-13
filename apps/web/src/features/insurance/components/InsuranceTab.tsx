import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { DetailTab } from '@/features/patients';
import type { SlotProps } from '@/registry';
import { errorMessageKey } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { StatusBadge, type StatusTone } from '@/shared/ui/status-badge';
import { useFormatters } from '@/tenancy';
import {
  useCancelPreAuth,
  useEndPolicy,
  usePatientPolicies,
  usePatientPreAuths,
} from '../hooks/use-coverage';
import type { PatientPolicy, PreAuth, PreAuthStatus } from '../types';
import { LimitMeter } from './LimitMeter';
import { PolicyDialog } from './PolicyDialog';
import { DecisionDialog, PreAuthDialog } from './PreAuthDialogs';
import { refusalKey } from './refusal';

const POLICY_TONE: Record<PatientPolicy['status'], StatusTone> = {
  active: 'success',
  expired: 'neutral',
  ended: 'neutral',
};
const PREAUTH_TONE: Record<PreAuthStatus, StatusTone> = {
  submitted: 'info',
  approved: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
};

type Panel =
  | { kind: 'policy' }
  | { kind: 'request' }
  | { kind: 'decide'; preAuth: PreAuth }
  | { kind: 'end'; policy: PatientPolicy }
  | { kind: 'cancel'; preAuth: PreAuth }
  | null;

/**
 * The "Insurance" tab of the patient's screen (`patient.detail.tabs`, #182), for `policy:read`:
 * the policies on the record, and with `preauth:read` the requests to the payer and their
 * answers. `policy:manage` adds a policy or ends one; `preauth:manage` raises a request, records
 * the payer's answer or withdraws a request. Given the patient's id only, and reads nothing
 * until the tab is opened.
 */
export default function InsuranceTab({ context }: SlotProps) {
  const { t } = useTranslation('insurance');
  const canRead = usePermission('policy:read');
  const patientId = typeof context?.patientId === 'string' ? context.patientId : '';
  if (!patientId || !canRead) return null;
  return (
    <DetailTab id="insurance" title={t('tab.title')}>
      {/* Keyed by the patient: another patient's cover is never carried over. */}
      <PatientCover key={patientId} patientId={patientId} />
    </DetailTab>
  );
}

function PatientCover({ patientId }: { patientId: string }) {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const canManagePolicy = usePermission('policy:manage');
  const canReadPayers = usePermission('payer:read');
  const canReadPreAuth = usePermission('preauth:read');
  const canManagePreAuth = usePermission('preauth:manage');
  const policies = usePatientPolicies(patientId);
  const preAuths = usePatientPreAuths(patientId, canReadPreAuth);
  const endPolicy = useEndPolicy();
  const cancel = useCancelPreAuth();
  const [panel, setPanel] = useState<Panel>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  const status = useRef<HTMLParagraphElement>(null);
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);

  const active = (policies.data ?? []).filter((policy) => policy.status === 'active');
  const close = () => setPanel(null);
  const failure = endPolicy.error ?? cancel.error;

  return (
    <div className="flex flex-col gap-6">
      <p ref={status} role="status" tabIndex={-1} className="text-sm outline-none">
        {message.text}
      </p>

      <section aria-labelledby="policies-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="policies-heading" className="text-lg font-semibold">
            {t('policy.heading')}
          </h2>
          {canManagePolicy && canReadPayers && (
            <Button type="button" variant="outline" onClick={() => setPanel({ kind: 'policy' })}>
              {t('policy.add.button')}
            </Button>
          )}
        </div>
        {policies.isPending ? (
          <p className="text-sm text-muted-foreground">{tCommon('app.loading')}</p>
        ) : policies.isError ? (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className="text-sm text-destructive">
              {tCommon(errorMessageKey(policies.error))}
            </p>
            <Button type="button" variant="outline" onClick={() => void policies.refetch()}>
              {tCommon('grid.retry')}
            </Button>
          </div>
        ) : policies.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('policy.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {policies.data.map((policy) => (
              <li key={policy.id} className="flex flex-col gap-2 rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {policy.payerName}, {policy.planName}
                  </span>
                  <StatusBadge
                    tone={POLICY_TONE[policy.status]}
                    label={t(`policy.status.${policy.status}`)}
                  />
                </div>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                  <Fact label={t('policy.number')} value={policy.policyNumber} />
                  <Fact label={t('policy.memberId')} value={policy.memberId} />
                  <Fact
                    label={t('policy.holder')}
                    value={`${policy.holderName} (${t(`policy.relation.${policy.relationship}`)})`}
                  />
                  <Fact
                    label={t('policy.valid')}
                    value={
                      policy.validTo
                        ? t('policy.validRange', {
                            from: format.calendarDate(policy.validFrom),
                            to: format.calendarDate(policy.validTo),
                          })
                        : t('policy.validFromOnly', { from: format.calendarDate(policy.validFrom) })
                    }
                  />
                  {policy.preAuthRequired && (
                    <Fact label={t('policy.preAuth')} value={t('policy.preAuthRequired')} />
                  )}
                </dl>
                {canManagePolicy && policy.status === 'active' && (
                  <div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setPanel({ kind: 'end', policy })}
                    >
                      {t('policy.end.button')}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {canReadPreAuth && (
        <section aria-labelledby="preauth-heading" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="preauth-heading" className="text-lg font-semibold">
              {t('preauth.heading')}
            </h2>
            {canManagePreAuth && (
              <Button
                type="button"
                variant="outline"
                aria-disabled={active.length === 0}
                onClick={() => active.length > 0 && setPanel({ kind: 'request' })}
                aria-describedby={active.length === 0 ? 'preauth-needs-policy' : undefined}
              >
                {t('preauth.add.button')}
              </Button>
            )}
          </div>
          {canManagePreAuth && active.length === 0 && (
            <p id="preauth-needs-policy" className="text-sm text-muted-foreground">
              {t('preauth.needsPolicy')}
            </p>
          )}
          {preAuths.isPending ? (
            <p className="text-sm text-muted-foreground">{tCommon('app.loading')}</p>
          ) : preAuths.isError ? (
            <div className="flex flex-col items-start gap-2">
              <p role="alert" className="text-sm text-destructive">
                {tCommon(errorMessageKey(preAuths.error))}
              </p>
              <Button type="button" variant="outline" onClick={() => void preAuths.refetch()}>
                {tCommon('grid.retry')}
              </Button>
            </div>
          ) : preAuths.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('preauth.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {preAuths.data.map((item) => (
                <li key={item.id} className="flex flex-col gap-2 rounded-md border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{item.treatment}</span>
                    <StatusBadge
                      tone={PREAUTH_TONE[item.status]}
                      label={t(`preauth.status.${item.status}`)}
                    />
                  </div>
                  <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                    <Fact
                      label={t('preauth.policy')}
                      value={`${item.payerName}, ${item.policyNumber}`}
                    />
                    <Fact
                      label={t('preauth.requested')}
                      value={format.money(item.requestedMinor)}
                    />
                    <Fact label={t('preauth.reference')} value={item.referenceNumber} />
                    <Fact label={t('preauth.note')} value={item.decisionNote} />
                    <Fact
                      label={t('preauth.documents')}
                      value={item.documents.length > 0 ? item.documents.join(', ') : undefined}
                    />
                    <Fact label={t('preauth.sent')} value={format.dateTime(item.requestedAt)} />
                  </dl>
                  {item.status === 'approved' && item.approvedMinor !== undefined && (
                    <LimitMeter billedMinor={item.billedMinor} approvedMinor={item.approvedMinor} />
                  )}
                  {canManagePreAuth && item.status === 'submitted' && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setPanel({ kind: 'decide', preAuth: item })}
                      >
                        {t('preauth.decide.button')}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setPanel({ kind: 'cancel', preAuth: item })}
                      >
                        {t('preauth.cancel.button')}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {refusalKey(failure)
            ? t(refusalKey(failure) as 'errors.version_conflict')
            : tCommon(errorMessageKey(failure))}
        </p>
      )}

      {panel?.kind === 'policy' && (
        <PolicyDialog
          patientId={patientId}
          onClose={close}
          onSaved={() => {
            close();
            say(t('policy.add.saved'));
          }}
        />
      )}
      {panel?.kind === 'request' && (
        <PreAuthDialog
          patientId={patientId}
          policies={active}
          onClose={close}
          onSaved={() => {
            close();
            say(t('preauth.add.saved'));
          }}
        />
      )}
      {panel?.kind === 'decide' && (
        <DecisionDialog
          preAuth={panel.preAuth}
          onClose={close}
          onSaved={(outcome) => {
            close();
            say(t(`preauth.decide.saved.${outcome}`));
          }}
        />
      )}
      <ConfirmDialog
        open={panel?.kind === 'end'}
        onClose={close}
        title={t('policy.end.title')}
        description={t('policy.end.description')}
        cancelLabel={t('cancel')}
        confirmLabel={t('policy.end.confirm')}
        destructive
        pending={endPolicy.isPending}
        onConfirm={() => {
          if (panel?.kind !== 'end') return;
          endPolicy.mutate(
            { policyId: panel.policy.id, version: panel.policy.version },
            { onSuccess: () => say(t('policy.end.saved')) },
          );
          close();
        }}
      />
      <ConfirmDialog
        open={panel?.kind === 'cancel'}
        onClose={close}
        title={t('preauth.cancel.title')}
        description={t('preauth.cancel.description')}
        cancelLabel={t('cancel')}
        confirmLabel={t('preauth.cancel.confirm')}
        destructive
        pending={cancel.isPending}
        onConfirm={() => {
          if (panel?.kind !== 'cancel') return;
          cancel.mutate(
            { preAuthId: panel.preAuth.id, version: panel.preAuth.version },
            { onSuccess: () => say(t('preauth.cancel.saved')) },
          );
          close();
        }}
      />
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | undefined }) {
  if (value === undefined || value === '') return null;
  return (
    <div className="flex flex-col">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
