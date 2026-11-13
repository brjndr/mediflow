import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { usePatientName } from '@/features/patients';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { AmbulanceDialog } from '../components/AmbulanceDialog';
import { DispatchDialog, RequestTripDialog } from '../components/TripDialogs';
import { useAmbulances, useMoveTrip, useSetService, useTrips } from '../hooks/use-ambulances';
import { allowedTripMoves, TRIP_STATUSES } from '../schemas';
import type { Ambulance, AmbulanceTrip, TripStatus } from '../types';
import type { TripMove } from '../api';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';
const ALL = 'all';

/** Who the trip is for: the name when the caller may read patients, else a plain word. */
function TripPatient({ patientId }: { patientId: string }) {
  const { t } = useTranslation('ambulances');
  const patient = usePatientName(patientId);
  if (patient.data) return <>{`${patient.data.firstName} ${patient.data.lastName}`}</>;
  return <>{t('trips.onRecord')}</>;
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function Ambulances() {
  const { t } = useTranslation('ambulances');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const canDispatch = usePermission('ambulance:dispatch');
  const canManage = usePermission('ambulance:manage');

  const [status, setStatus] = useState<TripStatus | typeof ALL>(ALL);
  const trips = useTrips(status === ALL ? undefined : status);
  const fleet = useAmbulances();
  const move = useMoveTrip();
  const service = useSetService();

  const [dialog, setDialog] = useState<'request' | 'add' | { dispatch: AmbulanceTrip }>();
  const [done, setDone] = useState<string>();
  const statusLine = useRef<HTMLParagraphElement>(null);
  const requestButton = useRef<HTMLButtonElement>(null);
  // A row that moved on may have left the filtered list and taken focus with it.
  useEffect(() => {
    if (done) focusIfLost(statusLine.current);
  }, [done]);

  const tripRows = useMemo(
    () => trips.data?.pages.flatMap((page) => page.items) ?? [],
    [trips.data],
  );
  const fleetRows = useMemo(
    () => fleet.data?.pages.flatMap((page) => page.items) ?? [],
    [fleet.data],
  );
  const tripTotal = trips.data?.pages[0]?.total;
  const fleetTotal = fleet.data?.pages[0]?.total;

  const closeDialog = () => {
    setDialog(undefined);
    setTimeout(() => focusIfLost(statusLine.current), 0);
  };

  const run = async (next: TripMove) => {
    move.reset();
    setDone(undefined);
    try {
      await move.mutateAsync(next);
      setDone(t(`done.${next.to}`));
    } catch {
      focusIfLost(statusLine.current);
    }
  };

  const toggleService = async (ambulance: Ambulance) => {
    service.reset();
    setDone(undefined);
    const to = ambulance.status === 'out_of_service' ? 'available' : 'out_of_service';
    try {
      await service.mutateAsync({ ambulance, to });
      setDone(t(`done.service_${to}`, { registration: ambulance.registration }));
    } catch {
      focusIfLost(statusLine.current);
    }
  };

  const busy = move.isPending || service.isPending;
  const tripActions: GridAction<AmbulanceTrip>[] = [
    {
      id: 'dispatch',
      label: t('actions.dispatch'),
      requires: 'ambulance:dispatch',
      disabled: (row) => busy || !allowedTripMoves(row.status).dispatch,
      onSelect: (row) => setDialog({ dispatch: row }),
    },
    {
      id: 'pickUp',
      label: t('actions.pickUp'),
      requires: 'ambulance:dispatch',
      disabled: (row) => busy || !allowedTripMoves(row.status).pickUp,
      onSelect: (row) => void run({ trip: row, to: 'picked_up' }),
    },
    {
      id: 'complete',
      label: t('actions.complete'),
      requires: 'ambulance:dispatch',
      disabled: (row) => busy || !allowedTripMoves(row.status).complete,
      onSelect: (row) => void run({ trip: row, to: 'completed' }),
    },
    {
      id: 'cancel',
      label: t('actions.cancel'),
      requires: 'ambulance:dispatch',
      disabled: (row) => busy || !allowedTripMoves(row.status).cancel,
      onSelect: (row) => void run({ trip: row, to: 'cancelled' }),
    },
  ];
  const fleetActions: GridAction<Ambulance>[] = [
    {
      id: 'service',
      label: t('actions.service'),
      requires: 'ambulance:manage',
      // Only an available ambulance goes out of service, and only one out of it returns.
      disabled: (row) => busy || row.status === 'on_trip',
      onSelect: (row) => void toggleService(row),
    },
  ];

  const tripColumns = useMemo<GridColumn<AmbulanceTrip>[]>(
    () => [
      { id: 'pickup', header: t('trips.pickup'), value: (row) => row.pickup, hideable: false },
      { id: 'destination', header: t('trips.destination'), value: (row) => row.destination },
      {
        id: 'patient',
        header: t('trips.patient'),
        value: (row) => (row.patientId ? t('trips.onRecord') : t('trips.noRecord')),
        render: (row, text) => (row.patientId ? <TripPatient patientId={row.patientId} /> : text),
      },
      {
        id: 'charge',
        header: t('trips.charge'),
        value: (row) =>
          row.serviceId && row.encounterId
            ? t(row.status === 'completed' ? 'trips.charged' : 'trips.chargeAfter', {
                service: row.serviceName ?? '',
              })
            : t('trips.noCharge'),
      },
      {
        id: 'status',
        header: t('trips.status'),
        value: (row) => t(`tripStatus.${row.status}`),
        hideable: false,
      },
      {
        id: 'ambulance',
        header: t('trips.ambulance'),
        value: (row) => row.ambulanceRegistration ?? '',
      },
      {
        id: 'requested',
        header: t('trips.requested'),
        value: (row) => format.dateTime(row.requestedAt),
      },
    ],
    [t, format],
  );
  const fleetColumns = useMemo<GridColumn<Ambulance>[]>(
    () => [
      {
        id: 'registration',
        header: t('fleet.registration'),
        value: (row) => row.registration,
        hideable: false,
      },
      { id: 'kind', header: t('fleet.kind'), value: (row) => t(`kind.${row.kind}`) },
      {
        id: 'status',
        header: t('fleet.status'),
        value: (row) => t(`ambulanceStatus.${row.status}`),
        hideable: false,
      },
    ],
    [t],
  );

  const error = move.isError ? move.error : service.isError ? service.error : undefined;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {isApiError(error) &&
          (error.serverCode === 'conflict' || error.serverCode === 'invalid_transition')
            ? t('errors.changed')
            : tCommon(errorMessageKey(error))}
        </p>
      )}
      {/* Always on the page, so a screen reader reads what is put in it; focusable, so focus has
          somewhere to go when the row it was on leaves the list. */}
      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm font-medium outline-none empty:sr-only focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {done ?? ''}
      </p>

      <section aria-labelledby="trips-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="trips-heading" className="text-lg font-semibold">
            {t('trips.heading')}
          </h2>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-44 flex-col gap-1 text-sm font-medium">
              {t('trips.filter')}
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value as TripStatus | typeof ALL)}
                className={control}
              >
                <option value={ALL}>{t('trips.all')}</option>
                {TRIP_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {t(`tripStatus.${value}`)}
                  </option>
                ))}
              </select>
            </label>
            {canDispatch && (
              <Button ref={requestButton} onClick={() => setDialog('request')}>
                {t('trips.request')}
              </Button>
            )}
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          {tripTotal === undefined || trips.isPlaceholderData
            ? ''
            : t('trips.count', { count: tripTotal })}
        </p>
        <DataGrid
          label={t('trips.gridLabel')}
          columns={tripColumns}
          rows={tripRows}
          rowId={(row) => row.id}
          rowLabel={(row) =>
            t('trips.rowLabel', { pickup: row.pickup, destination: row.destination })
          }
          actions={trips.isPlaceholderData ? [] : tripActions}
          status={trips.isPending ? 'loading' : trips.isError ? 'error' : 'ready'}
          errorMessage={trips.isError ? tCommon(errorMessageKey(trips.error)) : undefined}
          onRetry={() => void trips.refetch()}
          emptyMessage={t('trips.empty')}
          hasNextPage={trips.hasNextPage && !trips.isPlaceholderData}
          total={trips.isPlaceholderData ? undefined : tripTotal}
          loadingMore={trips.isFetchingNextPage}
          onLoadMore={() => void trips.fetchNextPage()}
        />
      </section>

      <section aria-labelledby="fleet-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="fleet-heading" className="text-lg font-semibold">
            {t('fleet.heading')}
          </h2>
          {canManage && <Button onClick={() => setDialog('add')}>{t('fleet.add')}</Button>}
        </div>
        <p className="text-sm text-muted-foreground">
          {fleetTotal === undefined || fleet.isPlaceholderData
            ? ''
            : t('fleet.count', { count: fleetTotal })}
        </p>
        <DataGrid
          label={t('fleet.gridLabel')}
          columns={fleetColumns}
          rows={fleetRows}
          rowId={(row) => row.id}
          rowLabel={(row) => row.registration}
          actions={fleet.isPlaceholderData ? [] : fleetActions}
          status={fleet.isPending ? 'loading' : fleet.isError ? 'error' : 'ready'}
          errorMessage={fleet.isError ? tCommon(errorMessageKey(fleet.error)) : undefined}
          onRetry={() => void fleet.refetch()}
          emptyMessage={t('fleet.empty')}
          hasNextPage={fleet.hasNextPage && !fleet.isPlaceholderData}
          total={fleet.isPlaceholderData ? undefined : fleetTotal}
          loadingMore={fleet.isFetchingNextPage}
          onLoadMore={() => void fleet.fetchNextPage()}
        />
      </section>

      {dialog === 'request' && (
        <RequestTripDialog
          onClose={closeDialog}
          onRequested={() => {
            setDone(t('done.requested'));
            closeDialog();
          }}
        />
      )}
      {dialog === 'add' && (
        <AmbulanceDialog
          onClose={closeDialog}
          onCreated={(registration) => {
            setDone(t('done.added', { registration }));
            closeDialog();
          }}
        />
      )}
      {typeof dialog === 'object' && (
        <DispatchDialog
          trip={dialog.dispatch}
          onClose={closeDialog}
          onDispatched={(registration) => {
            setDone(t('done.dispatched', { registration }));
            closeDialog();
          }}
        />
      )}
    </div>
  );
}
