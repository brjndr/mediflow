import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { usePermission } from '@/access';
import { Slot } from '@/registry';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { PageSkeleton } from '@/shared/ui/page-skeleton';
import { SystemPage } from '@/shared/ui/system-page';
import { maskPhone } from '@/shared/utils/mask';
import { useFormatters, useTenant } from '@/tenancy';
import { DetailTab, DetailTabs } from '../components/DetailTabs';
import { usePatient } from '../hooks/use-patient';
import { todayIn } from '../schemas';
import type { PatientRecord } from '../types';

/** Age on a day, both given as YYYY-MM-DD calendar dates: whole years, and months under one. */
function ageOn(dob: string, today: string): { years: number; months: number } {
  const [birthYear, birthMonth, birthDay] = dob.split('-').map(Number) as [number, number, number];
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  const months = Math.max(
    (year - birthYear) * 12 + (month - birthMonth) - (day < birthDay ? 1 : 0),
    0,
  );
  return { years: Math.floor(months / 12), months };
}

/** A phone number that is already masked is left as the server sent it. */
const withheldPhone = (phone: string) =>
  phone.replace(/\D/g, '').length > 4 ? maskPhone(phone) : phone;

function Demographics({ patient }: { patient: PatientRecord }) {
  const { t } = useTranslation('patients');
  const format = useFormatters();
  const consent = patient.contactConsent;
  // Without the field-level permission the server masks the phone and leaves these out. Say so,
  // so that "left out" is not read as "never recorded".
  const seesContact = usePermission('patient.contact:read');
  const none = <span className="text-muted-foreground">{t('detail.notRecorded')}</span>;
  const restricted = <span className="text-muted-foreground">{t('detail.restricted')}</span>;
  const rows: [string, React.ReactNode][] = [
    // The server masks the phone too. Masking again here covers a record that was cached before
    // the role lost the permission, until it is read afresh.
    [t('columns.phone'), seesContact ? patient.phone : withheldPhone(patient.phone)],
    [t('detail.email'), seesContact ? (patient.email ?? none) : restricted],
    [t('detail.address'), seesContact ? (patient.address ?? none) : restricted],
    [
      t('detail.consent'),
      consent
        ? t(consent.given ? 'detail.consentGiven' : 'detail.consentRefused', {
            when: format.dateTime(consent.at),
          })
        : none,
    ],
  ];
  return (
    // On a phone each label sits just above its value; where there is room they go side by side.
    <dl className="flex flex-col gap-3 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-1 gap-x-6 md:grid-cols-[12rem_minmax(0,1fr)]">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One patient: who they are at the top, then tabs. This feature provides the first tab; other
 * features add theirs through the `patient.detail.tabs` slot, and their buttons through
 * `patient.detail.actions`, without this screen knowing about them. A contribution is given the
 * patient's id and nothing else: it reads what it needs under its own permissions.
 *
 * Opening the screen reads the record from the API, which is what writes the audit entry.
 */
export default function PatientDetail() {
  const { t } = useTranslation('patients');
  const { t: tCommon } = useTranslation();
  const { id = '' } = useParams();
  const tenant = useTenant();
  const format = useFormatters();
  const patient = usePatient(id);

  if (patient.isPending) return <PageSkeleton label={t('detail.loading')} />;

  // Only when there is nothing to show. A refresh in the background that fails leaves the
  // record that is already on screen where it is.
  if (patient.data === undefined) {
    // The server gives one answer for a record that does not exist, is in another hospital or is
    // outside this user's scope, and so does this screen.
    if (isApiError(patient.error) && patient.error.code === 'not_found') {
      return (
        <SystemPage
          title={t('detail.notFoundTitle')}
          description={t('detail.notFoundBody')}
          actions={
            <Link
              to="/patients"
              className="inline-flex items-center rounded-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11 text-sm"
            >
              {t('created.backToList')}
            </Link>
          }
        />
      );
    }
    return (
      <SystemPage
        alert
        title={t('detail.errorTitle')}
        description={tCommon(errorMessageKey(patient.error))}
        actions={
          // Asking again does not help when the answer was "you may not".
          isApiError(patient.error) && patient.error.code === 'forbidden' ? undefined : (
            <Button variant="outline" onClick={() => void patient.refetch()}>
              {tCommon('grid.retry')}
            </Button>
          )
        }
      />
    );
  }

  const record = patient.data;
  const context = { patientId: record.id };
  const age = ageOn(record.dob, todayIn(tenant?.timezone ?? 'UTC'));

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6">
      <Link
        to="/patients"
        className="inline-flex items-center rounded-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11 self-start text-sm"
      >
        {t('created.backToList')}
      </Link>

      <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight break-words">
            {record.firstName} {record.lastName}
          </h1>
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <div className="flex gap-2">
              <dt className="text-muted-foreground">{t('columns.mrn')}</dt>
              <dd className="font-medium">{record.mrn}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">{t('columns.dob')}</dt>
              <dd>
                {/* A calendar date, not an instant: noon UTC keeps the day in every timezone. */}
                {format.date(`${record.dob}T12:00:00Z`)} (
                {age.years >= 1
                  ? t('detail.age', { count: age.years })
                  : t('detail.ageMonths', { count: age.months })}
                )
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">{t('columns.gender')}</dt>
              <dd>{t(`gender.${record.gender}`)}</dd>
            </div>
          </dl>
        </div>
        {/* What other features offer for this patient. Empty until one contributes. */}
        <div className="flex flex-wrap gap-2 empty:hidden">
          <Slot id="patient.detail.actions" context={context} />
        </div>
      </header>

      <DetailTabs label={t('detail.tabsLabel')}>
        <DetailTab id="details" title={t('detail.detailsTab')}>
          <Demographics patient={record} />
        </DetailTab>
        <Slot id="patient.detail.tabs" context={context} />
      </DetailTabs>
    </div>
  );
}
