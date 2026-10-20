import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { usePermission } from '@/access';
import { TriageSummary } from '@/features/triage';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { useFormatters } from '@/tenancy';
import { DiagnosesPanel } from '../components/DiagnosesPanel';
import { EncounterActions } from '../components/EncounterActions';
import { LabOrdersPanel } from '../components/LabOrdersPanel';
import { NotesPanel } from '../components/NotesPanel';
import { PrescriptionsPanel } from '../components/PrescriptionsPanel';
import { PrintSummaryButton } from '../components/PrintDocuments';
import { useEncounter } from '../hooks/use-clinical';
import type { Encounter } from '../types';

/** An id from the address, or empty when it is not one. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The consultation (`encounters/:encounterId`), for `encounter:read`: who the visit is for and
 * with whom, what triage found (allergies and the newest vitals), the notes for
 * `clinicalNote:read`, the diagnoses for `diagnosis:read`, the prescriptions for
 * `prescription:read` and the lab orders for `order:read` (#82), each part shown only to whoever
 * holds its permission, printing the visit summary for `encounter:print` (#89), and closing or
 * cancelling for `encounter:update`.
 */
export default function EncounterDetail() {
  const { t } = useTranslation('clinical');
  const { t: tCommon } = useTranslation();
  const raw = useParams().encounterId ?? '';
  const encounterId = ID.test(raw) ? raw : '';
  const encounter = useEncounter(encounterId);
  const missing =
    encounterId === '' ||
    (isApiError(encounter.error) &&
      (encounter.error.status === 404 || encounter.error.status === 403));

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('detail.heading')}</h1>
      {missing ? (
        <Unavailable />
      ) : encounter.isPending ? (
        <p className="text-sm text-muted-foreground">{tCommon('app.loading')}</p>
      ) : encounter.isError ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(encounter.error))}
          </p>
          <Button type="button" variant="outline" onClick={() => void encounter.refetch()}>
            {tCommon('grid.retry')}
          </Button>
        </div>
      ) : (
        <Consultation encounter={encounter.data} />
      )}
    </div>
  );
}

function Unavailable() {
  const { t } = useTranslation('clinical');
  return (
    <div className="flex flex-col items-start gap-3">
      <p role="alert" className="text-sm">
        {t('detail.unavailable')}
      </p>
      <Button asChild variant="outline">
        <Link to="/encounters">{t('detail.back')}</Link>
      </Button>
    </div>
  );
}

function Consultation({ encounter }: { encounter: Encounter }) {
  const { t } = useTranslation('clinical');
  const format = useFormatters();
  const canReadNotes = usePermission('clinicalNote:read');
  const canReadDiagnoses = usePermission('diagnosis:read');
  const canReadPrescriptions = usePermission('prescription:read');
  const canReadOrders = usePermission('order:read');
  const canUpdate = usePermission('encounter:update');
  const canPrint = usePermission('encounter:print');
  const ended = encounter.endedAt
    ? t(encounter.status === 'cancelled' ? 'detail.cancelledBy' : 'detail.closedBy', {
        name: encounter.endedByName ?? '',
        time: format.dateTime(encounter.endedAt),
      })
    : '';

  return (
    <>
      <div className="flex flex-col gap-1">
        <p className="text-lg font-medium">
          {t('detail.patient', { name: encounter.patientName, mrn: encounter.patientMrn })}
        </p>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">{t('detail.status')}</dt>
          <dd>
            <StatusWord status={encounter.status} />
            {ended && <span className="ml-2 text-muted-foreground">{ended}</span>}
          </dd>
          <dt className="text-muted-foreground">{t('detail.doctor')}</dt>
          <dd>{encounter.attendingDoctorName ?? t('detail.noDoctor')}</dd>
          {encounter.departmentName && (
            <>
              <dt className="text-muted-foreground">{t('detail.department')}</dt>
              <dd>{encounter.departmentName}</dd>
            </>
          )}
          <dt className="text-muted-foreground">{t('detail.opened')}</dt>
          <dd>
            {t('detail.openedBy', {
              time: format.dateTime(encounter.openedAt),
              name: encounter.openedByName,
            })}
          </dd>
          {encounter.cancelReason && (
            <>
              <dt className="text-muted-foreground">{t('detail.cancelReason')}</dt>
              <dd>{encounter.cancelReason}</dd>
            </>
          )}
        </dl>
        {canPrint && encounter.status !== 'cancelled' && (
          <div className="mt-2">
            <PrintSummaryButton encounter={encounter} />
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {/* What triage found comes first on a narrow screen: the allergies matter before the
            notes. Beside the notes where there is room. */}
        <aside aria-label={t('detail.triage')} className="flex flex-col gap-6 lg:order-last">
          <TriageSummary patientId={encounter.patientId} />
        </aside>
        <div className="flex min-w-0 flex-col gap-8">
          {canReadNotes && <NotesPanel encounter={encounter} />}
          {canReadDiagnoses && <DiagnosesPanel encounter={encounter} />}
          {canReadPrescriptions && <PrescriptionsPanel encounter={encounter} />}
          {canReadOrders && <LabOrdersPanel encounter={encounter} />}
        </div>
      </div>

      {canUpdate && <EncounterActions encounter={encounter} />}
    </>
  );
}

function StatusWord({ status }: { status: Encounter['status'] }) {
  const { t } = useTranslation('clinical');
  return <span className="font-medium">{t(`status.${status}`)}</span>;
}
