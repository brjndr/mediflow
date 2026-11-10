import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { usePermission } from '@/access';
import { EncounterOrders } from '@/features/clinical';
import { usePatientName } from '@/features/patients';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { useFormatters } from '@/tenancy';
import { IdentifyDialog } from '../components/CaseDialogs';
import { DispositionDialog } from '../components/DispositionDialog';
import { failureText } from '../components/failure';
import { NotesPanel } from '../components/NotesPanel';
import { useCase, useOpenEncounter, useStartTreatment } from '../hooks/use-emergency';
import type { EmergencyCase } from '../types';

/** An id from the address, or empty when it is not one. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function Who({ row }: { row: EmergencyCase }) {
  const { t } = useTranslation('emergency');
  const patient = usePatientName(row.patientId ?? '');
  if (row.patientId) {
    return (
      <>{patient.data ? `${patient.data.firstName} ${patient.data.lastName}` : t('onRecord')}</>
    );
  }
  return <>{row.alias ?? t('unidentified')}</>;
}

/**
 * One patient in the department (`emergency/:caseId`), for `emergency:read`: where they are in the
 * flow, observation notes and rapid orders for `emergency:care` (orders need the patient on
 * record and `order:create`), and how they leave for `emergency:dispose`: discharge, admit,
 * refer or expired. Once they have left the screen is a record of how.
 */
export default function CaseCare() {
  const { t } = useTranslation('emergency');
  const { t: tCommon } = useTranslation();
  const raw = useParams().caseId ?? '';
  const caseId = ID.test(raw) ? raw : '';
  const found = useCase(caseId);
  const missing =
    caseId === '' ||
    (isApiError(found.error) && (found.error.status === 404 || found.error.status === 403));

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
      <Button asChild variant="outline" className="self-start">
        <Link to="/emergency">{t('care.back')}</Link>
      </Button>
      {missing ? (
        <p role="alert">{t('care.unavailable')}</p>
      ) : found.isPending ? (
        <p className="text-sm text-muted-foreground">{tCommon('app.loading')}</p>
      ) : found.isError ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(found.error))}
          </p>
          <Button variant="outline" onClick={() => void found.refetch()}>
            {tCommon('grid.retry')}
          </Button>
        </div>
      ) : (
        <Care row={found.data} />
      )}
    </div>
  );
}

function Care({ row }: { row: EmergencyCase }) {
  const { t } = useTranslation('emergency');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const canCare = usePermission('emergency:care');
  const canDispose = usePermission('emergency:dispose');
  const canRegister = usePermission('emergency:register');
  const start = useStartTreatment();
  const openEncounter = useOpenEncounter();
  const [disposing, setDisposing] = useState(false);
  const [identifying, setIdentifying] = useState(false);
  const [message, setMessage] = useState('');
  const statusLine = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (message) focusIfLost(statusLine.current);
  }, [message]);
  const left = row.status === 'disposed';
  const failure = failureText(start.error ?? openEncounter.error, t, tCommon);

  const run = async (action: () => Promise<unknown>, done: string) => {
    try {
      await action();
      setMessage(done);
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {row.tempId} · <Who row={row} />
        </h1>
        <p className="text-muted-foreground">
          {row.category === undefined ? t('category.none') : t(`category.short.${row.category}`)} ·{' '}
          {t(`status.${row.status}`)} · {t(`arrival.${row.arrivalMode}`)} ·{' '}
          {format.dateTime(row.arrivedAt)}
        </p>
        <p>{row.complaint}</p>
      </div>

      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm font-medium outline-none empty:sr-only focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {message}
      </p>
      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}

      {left ? (
        <section aria-labelledby="left-heading" className="rounded-md border p-4">
          <h2 id="left-heading" className="text-lg font-semibold">
            {t('left.heading')}
          </h2>
          <p>
            {t(`disposition.types.${row.disposition ?? 'discharge'}`)}
            {row.disposedAt ? ` · ${format.dateTime(row.disposedAt)}` : ''}
          </p>
          {row.destination && <p>{t('left.destination', { destination: row.destination })}</p>}
          {row.deathAt && <p>{t('left.deathAt', { at: format.dateTime(row.deathAt) })}</p>}
          {row.dispositionNote && (
            <p className="whitespace-pre-wrap break-words">{row.dispositionNote}</p>
          )}
          {row.admissionId && (
            <p>
              <Link className="underline" to="/admissions">
                {t('left.admission')}
              </Link>
            </p>
          )}
        </section>
      ) : (
        <div className="flex flex-wrap gap-2">
          {canCare && row.status === 'waiting' && (
            <Button
              aria-busy={start.isPending}
              onClick={() =>
                void run(() => start.mutateAsync(row), t('care.started', { id: row.tempId }))
              }
            >
              {t('care.start')}
            </Button>
          )}
          {canCare && row.patientId && !row.encounterId && (
            <Button
              variant="outline"
              aria-busy={openEncounter.isPending}
              onClick={() => void run(() => openEncounter.mutateAsync(row), t('care.ordersReady'))}
            >
              {t('care.openOrders')}
            </Button>
          )}
          {canRegister && !row.patientId && (
            <Button variant="outline" onClick={() => setIdentifying(true)}>
              {t('actions.identify')}
            </Button>
          )}
          {canDispose && (
            <Button onClick={() => setDisposing(true)}>{t('disposition.open')}</Button>
          )}
        </div>
      )}

      <NotesPanel row={row} />

      <section aria-labelledby="orders-heading" className="flex flex-col gap-3">
        <h2 id="orders-heading" className="text-lg font-semibold">
          {t('orders.heading')}
        </h2>
        {row.encounterId ? (
          <EncounterOrders encounterId={row.encounterId} />
        ) : (
          <p className="text-sm text-muted-foreground">
            {row.patientId ? t('orders.notOpen') : t('orders.needsPatient')}
          </p>
        )}
      </section>

      {identifying && (
        <IdentifyDialog
          row={row}
          onClose={() => {
            setIdentifying(false);
            setTimeout(() => focusIfLost(statusLine.current), 0);
          }}
          onDone={() => {
            setIdentifying(false);
            setMessage(t('done.identified', { id: row.tempId }));
          }}
        />
      )}
      {disposing && (
        <DispositionDialog
          row={row}
          onClose={() => {
            setDisposing(false);
            setTimeout(() => focusIfLost(statusLine.current), 0);
          }}
          onDone={(done) => {
            setDisposing(false);
            setMessage(t('disposition.done', { id: done.tempId }));
          }}
        />
      )}
    </>
  );
}
