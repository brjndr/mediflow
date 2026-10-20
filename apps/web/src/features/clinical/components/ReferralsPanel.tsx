import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { useDepartmentOptions } from '@/features/departments';
import { useDoctorOptions } from '@/features/doctors';
import { errorMessageKey, isApiError } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import {
  Form,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
  useFieldValue,
  useSetFieldValue,
  useZodForm,
} from '@/shared/ui/form';
import { useFormatters } from '@/tenancy';
import { useCancelReferral, useCreateReferral, useReferrals } from '../hooks/use-clinical';
import {
  blankReferral,
  REASON_MAX,
  reasonSchema,
  REFERRAL_REASON_MAX,
  REFERRAL_URGENCIES,
  referralFormSchema,
  toReferralCreate,
  type ReasonValues,
  type ReferralValues,
} from '../schemas';
import type { Encounter, Referral } from '../types';

const REFUSED: Record<string, string> = {
  encounter_not_open: 'referrals.refused.notOpen',
  unknown_department: 'referrals.refused.unknownDepartment',
  unknown_doctor: 'referrals.refused.unknownDoctor',
  doctor_not_in_department: 'referrals.refused.otherDepartment',
  already_cancelled: 'referrals.refused.alreadyCancelled',
  referral_not_found: 'referrals.refused.gone',
};

function useRefusal(error: unknown) {
  const { t } = useTranslation('clinical');
  const { t: tCommon } = useTranslation();
  if (!error) return undefined;
  const code = isApiError(error) ? error.serverCode : undefined;
  const key = code === undefined ? undefined : REFUSED[code];
  return key ? t(key) : tCommon(errorMessageKey(error));
}

/** Where a referral goes: the department, and the doctor when one was named. */
const destination = (row: Referral) =>
  row.doctorName ? `${row.departmentName}: ${row.doctorName}` : row.departmentName;

/**
 * The encounter's referrals (#88), for `referral:read`, oldest first with the cancelled ones kept
 * and marked. `referral:create` refers the patient to a department, or one of its doctors, while
 * the encounter is open, and cancels a referral with a reason, also after it closed.
 */
export function ReferralsPanel({ encounter }: { encounter: Encounter }) {
  const { t } = useTranslation('clinical');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const headingId = useId();
  const canCreate = usePermission('referral:create');
  const referrals = useReferrals(encounter.id);
  const box = useRef<HTMLElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  const [cancelling, setCancelling] = useState<Referral | null>(null);
  usePanelFocus(cancelling?.id ?? null, box, status);
  const rows = useMemo(
    () => referrals.data?.pages.flatMap((page) => page.items) ?? [],
    [referrals.data],
  );
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);

  const columns = useMemo<GridColumn<Referral>[]>(
    () => [
      {
        id: 'to',
        header: t('referrals.columns.to'),
        value: destination,
        hideable: false,
        render: (row, text) =>
          row.cancelledAt ? (
            <span className="text-muted-foreground line-through">{text}</span>
          ) : (
            text
          ),
      },
      {
        id: 'urgency',
        header: t('referrals.columns.urgency'),
        value: (row) => t(`referrals.urgency.${row.urgency}`),
      },
      {
        id: 'reason',
        header: t('referrals.columns.reason'),
        value: (row) => row.reason,
        render: (_row, text) => <span className="whitespace-pre-line">{text}</span>,
      },
      {
        id: 'referred',
        header: t('referrals.columns.referred'),
        value: (row) =>
          t('referrals.referredBy', {
            name: row.referredByName,
            time: format.dateTime(row.referredAt),
          }),
      },
      {
        id: 'status',
        header: t('referrals.columns.status'),
        // A word, never the strike-through alone.
        value: (row) =>
          row.cancelledAt
            ? t('referrals.cancelled', {
                name: row.cancelledByName ?? '',
                time: format.dateTime(row.cancelledAt),
                reason: row.cancelReason ?? '',
              })
            : t('referrals.open'),
      },
    ],
    [t, format],
  );

  const actions = useMemo<GridAction<Referral>[]>(
    () =>
      encounter.status === 'cancelled'
        ? []
        : [
            {
              id: 'cancel',
              label: t('referrals.cancel'),
              requires: 'referral:create',
              disabled: (row) => row.cancelledAt !== undefined,
              onSelect: (row) => setCancelling(row),
            },
          ],
    [t, encounter.status],
  );

  return (
    <section ref={box} aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2 id={headingId} className="text-lg font-semibold">
        {t('referrals.heading')}
      </h2>
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 empty:hidden"
      >
        {message.text}
      </p>
      <DataGrid
        label={t('referrals.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={destination}
        actions={actions}
        status={referrals.isPending ? 'loading' : referrals.isError ? 'error' : 'ready'}
        errorMessage={referrals.isError ? tCommon(errorMessageKey(referrals.error)) : undefined}
        onRetry={() => void referrals.refetch()}
        emptyMessage={t('referrals.empty')}
        hasNextPage={referrals.hasNextPage}
        loadingMore={referrals.isFetchingNextPage}
        onLoadMore={() => void referrals.fetchNextPage()}
      />
      {cancelling && (
        <CancelForm
          referral={cancelling}
          onCancel={() => setCancelling(null)}
          onCancelled={() => {
            setCancelling(null);
            say(t('referrals.cancelledNow'));
          }}
        />
      )}
      {canCreate && encounter.status === 'open' && (
        // Hidden, not removed, while a cancellation is asked: a referral being written is kept.
        <div hidden={cancelling !== null}>
          <AddReferral encounterId={encounter.id} onReferred={() => say(t('referrals.referred'))} />
        </div>
      )}
    </section>
  );
}

function CancelForm({
  referral,
  onCancel,
  onCancelled,
}: {
  referral: Referral;
  onCancel: () => void;
  onCancelled: () => void;
}) {
  const { t } = useTranslation('clinical');
  const cancel = useCancelReferral(referral.encounterId);
  const form = useZodForm(reasonSchema, { reason: '' });
  const failure = useRefusal(cancel.error);
  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <h3 data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('referrals.cancelHeading', { to: destination(referral) })}
      </h3>
      <Form
        form={form}
        onSubmit={(values: ReasonValues) =>
          cancel.mutate(
            { referralId: referral.id, reason: values.reason },
            { onSuccess: onCancelled },
          )
        }
      >
        <TextField<ReasonValues>
          name="reason"
          label={t('referrals.cancelReason')}
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
          <SubmitButton pending={cancel.isPending}>{t('referrals.cancelSubmit')}</SubmitButton>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('cancel')}
          </Button>
        </div>
      </Form>
    </div>
  );
}

/** Refers the patient: a department, a doctor of it or any of them, how urgent, and why. */
function AddReferral({ encounterId, onReferred }: { encounterId: string; onReferred: () => void }) {
  const { t } = useTranslation('clinical');
  const { t: tCommon } = useTranslation();
  const headingId = useId();
  const create = useCreateReferral(encounterId);
  const departments = useDepartmentOptions();
  const form = useZodForm(referralFormSchema, blankReferral);
  const failure = useRefusal(create.error);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h3 id={headingId} className="font-semibold">
        {t('referrals.form.heading')}
      </h3>
      {!departments.available ? (
        // The departments are another feature's: without them nobody can be chosen.
        <p className="text-sm">{t('referrals.form.noDepartments')}</p>
      ) : (
        <Form
          form={form}
          onSubmit={(values) =>
            create.mutate(toReferralCreate(values), {
              onSuccess: () => {
                form.reset(blankReferral);
                onReferred();
              },
            })
          }
        >
          <SelectField<ReferralValues>
            name="departmentId"
            label={t('referrals.form.department')}
            required
            placeholder={
              departments.isPending
                ? t('referrals.form.departmentsLoading')
                : t('referrals.form.chooseDepartment')
            }
            options={(departments.data ?? []).map((department) => ({
              value: department.id,
              label: department.name,
            }))}
          />
          {departments.isError && (
            <p role="alert" className="text-sm text-destructive">
              {tCommon(errorMessageKey(departments.error))}
            </p>
          )}
          <DoctorChoice />
          <SelectField<ReferralValues>
            name="urgency"
            label={t('referrals.form.urgency')}
            required
            options={REFERRAL_URGENCIES.map((urgency) => ({
              value: urgency,
              label: t(`referrals.urgency.${urgency}`),
            }))}
          />
          <TextAreaField<ReferralValues>
            name="reason"
            label={t('referrals.form.reason')}
            hint={t('referrals.form.reasonHint')}
            required
            maxLength={REFERRAL_REASON_MAX}
            rows={3}
          />
          {failure && (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          )}
          <SubmitButton pending={create.isPending} className="self-start">
            {create.isPending ? t('referrals.form.saving') : t('referrals.form.submit')}
          </SubmitButton>
        </Form>
      )}
    </section>
  );
}

/**
 * A doctor of the chosen department, or none: any of its doctors. Without `doctor:read` or the
 * doctors switch only the department is chosen, which is a whole referral by itself.
 */
function DoctorChoice() {
  const { t } = useTranslation('clinical');
  const doctors = useDoctorOptions();
  const departmentId = String(useFieldValue('departmentId') ?? '');
  const doctorId = String(useFieldValue('doctorId') ?? '');
  const setValue = useSetFieldValue();
  const ofDepartment = (doctors.data ?? []).filter(
    (doctor) => doctor.departmentId === departmentId,
  );
  // A doctor of the department chosen before is let go when the department changes.
  const stale = doctorId !== '' && !ofDepartment.some((doctor) => doctor.id === doctorId);
  useEffect(() => {
    if (stale && doctors.data) setValue('doctorId', '');
  }, [stale, doctors.data, setValue]);
  if (!doctors.available || departmentId === '') return null;
  return (
    <SelectField<ReferralValues>
      name="doctorId"
      label={t('referrals.form.doctor')}
      placeholder={t('referrals.form.anyDoctor')}
      options={ofDepartment.map((doctor) => ({ value: doctor.id, label: doctor.name }))}
    />
  );
}
