import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { useDoctorOptions } from '@/features/doctors';
import { usePatientName } from '@/features/patients';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { nextDay, todayIn } from '@/shared/utils/timezone';
import { useFormatters, useTenant } from '@/tenancy';
import { RoomDialog } from '../components/RoomDialog';
import { OperationDialog } from '../components/OperationDialog';
import { RecoveryDialog } from '../components/RecoveryDialog';
import { PeriopDialog } from '../components/PeriopDialog';
import { BookDialog, CancelDialog, RescheduleDialog } from '../components/SurgeryDialogs';
import { useDaySurgeries, useMoveSurgery, useRooms, useUpdateRoom } from '../hooks/use-theatre';
import { allowedMoves } from '../schemas';
import type { OtRoom, Surgery } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';
const ALL = 'all';

/** The calendar day before another (the helper for the next day is shared). */
function previousDay(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** Who the surgery is for: the name when the caller may read patients, else a plain word. */
function SurgeryPatient({ patientId }: { patientId: string }) {
  const { t } = useTranslation('theatre');
  const patient = usePatientName(patientId);
  if (patient.data) return <>{`${patient.data.firstName} ${patient.data.lastName}`}</>;
  return <>{t('surgeries.onRecord')}</>;
}

type Dialog =
  | { periop: Surgery }
  | { operation: Surgery }
  | { recovery: Surgery }
  | { book: true }
  | { reschedule: Surgery }
  | { cancel: Surgery }
  | { room: OtRoom | 'new' };

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function Theatre() {
  const { t } = useTranslation('theatre');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const timezone = useTenant()?.timezone ?? 'UTC';
  const canSchedule = usePermission('surgery:schedule');
  const canManage = usePermission('theatre:manage');

  const [day, setDay] = useState(() => todayIn(timezone));
  const [roomFilter, setRoomFilter] = useState<string>(ALL);
  const rooms = useRooms();
  const doctors = useDoctorOptions();
  const surgeries = useDaySurgeries(day, roomFilter === ALL ? undefined : roomFilter);
  const move = useMoveSurgery();
  const updateRoom = useUpdateRoom();

  const [dialog, setDialog] = useState<Dialog>();
  const [done, setDone] = useState<string>();
  const statusLine = useRef<HTMLParagraphElement>(null);
  // A row that moved on may have left the list and taken focus with it.
  useEffect(() => {
    if (done) focusIfLost(statusLine.current);
  }, [done]);

  const roomName = useMemo(
    () => new Map((rooms.data ?? []).map((room) => [room.id, room.name])),
    [rooms.data],
  );
  const surgeonName = useMemo(
    () => new Map((doctors.data ?? []).map((doctor) => [doctor.id, doctor.name])),
    [doctors.data],
  );
  const rows = useMemo(
    () => surgeries.data?.pages.flatMap((page) => page.items) ?? [],
    [surgeries.data],
  );
  const total = surgeries.data?.pages[0]?.total;
  const roomRows = rooms.data ?? [];

  const closeDialog = () => {
    setDialog(undefined);
    setTimeout(() => focusIfLost(statusLine.current), 0);
  };

  const run = async (surgery: Surgery, to: 'start' | 'complete') => {
    move.reset();
    setDone(undefined);
    try {
      await move.mutateAsync({ surgery, to });
      setDone(t(`done.${to}`, { procedure: surgery.procedure }));
    } catch {
      focusIfLost(statusLine.current);
    }
  };

  const toggleArchived = async (room: OtRoom) => {
    updateRoom.reset();
    setDone(undefined);
    try {
      await updateRoom.mutateAsync({ room, archived: !room.archived });
      setDone(t(room.archived ? 'done.restored' : 'done.archived', { name: room.name }));
    } catch {
      focusIfLost(statusLine.current);
    }
  };

  const busy = move.isPending || updateRoom.isPending;
  const surgeryActions: GridAction<Surgery>[] = [
    {
      id: 'periop',
      label: t('actions.periop'),
      requires: 'theatre:read',
      disabled: (row) => row.status === 'cancelled',
      onSelect: (row) => setDialog({ periop: row }),
    },
    {
      id: 'operation',
      label: t('actions.operation'),
      requires: 'theatre:read',
      disabled: (row) => row.status === 'cancelled',
      onSelect: (row) => setDialog({ operation: row }),
    },
    {
      id: 'recovery',
      label: t('actions.recovery'),
      requires: 'theatre:read',
      disabled: (row) => row.status === 'cancelled',
      onSelect: (row) => setDialog({ recovery: row }),
    },
    {
      id: 'start',
      label: t('actions.start'),
      requires: 'surgery:perform',
      disabled: (row) => busy || !allowedMoves(row.status).start,
      onSelect: (row) => void run(row, 'start'),
    },
    {
      id: 'complete',
      label: t('actions.complete'),
      requires: 'surgery:perform',
      disabled: (row) => busy || !allowedMoves(row.status).complete,
      onSelect: (row) => void run(row, 'complete'),
    },
    {
      id: 'reschedule',
      label: t('actions.reschedule'),
      requires: 'surgery:schedule',
      disabled: (row) => busy || !allowedMoves(row.status).reschedule,
      onSelect: (row) => setDialog({ reschedule: row }),
    },
    {
      id: 'cancel',
      label: t('actions.cancel'),
      requires: 'surgery:schedule',
      disabled: (row) => busy || !allowedMoves(row.status).cancel,
      onSelect: (row) => setDialog({ cancel: row }),
    },
  ];
  const roomActions: GridAction<OtRoom>[] = [
    {
      id: 'rename',
      label: t('actions.rename'),
      requires: 'theatre:manage',
      disabled: () => busy,
      onSelect: (row) => setDialog({ room: row }),
    },
    {
      id: 'archive',
      label: t('actions.archive'),
      requires: 'theatre:manage',
      disabled: () => busy,
      onSelect: (row) => void toggleArchived(row),
    },
  ];

  const surgeryColumns = useMemo<GridColumn<Surgery>[]>(
    () => [
      {
        id: 'time',
        header: t('surgeries.time'),
        value: (row) => `${format.time(row.startsAt)} - ${format.time(row.endsAt)}`,
        hideable: false,
      },
      { id: 'procedure', header: t('surgeries.procedure'), value: (row) => row.procedure },
      {
        id: 'room',
        header: t('surgeries.room'),
        value: (row) => roomName.get(row.roomId) ?? '',
      },
      {
        id: 'surgeon',
        header: t('surgeries.surgeon'),
        value: (row) => surgeonName.get(row.surgeonId) ?? t('surgeries.surgeonUnknown'),
      },
      {
        id: 'patient',
        header: t('surgeries.patient'),
        value: () => t('surgeries.onRecord'),
        render: (row) => <SurgeryPatient patientId={row.patientId} />,
      },
      {
        id: 'status',
        header: t('surgeries.status'),
        value: (row) => t(`status.${row.status}`),
        hideable: false,
      },
    ],
    [t, format, roomName, surgeonName],
  );
  const roomColumns = useMemo<GridColumn<OtRoom>[]>(
    () => [
      { id: 'name', header: t('rooms.name'), value: (row) => row.name, hideable: false },
      {
        id: 'state',
        header: t('rooms.state'),
        value: (row) => t(row.archived ? 'rooms.archived' : 'rooms.inUse'),
      },
    ],
    [t],
  );

  const error = move.isError ? move.error : updateRoom.isError ? updateRoom.error : undefined;
  const changed =
    isApiError(error) &&
    (error.serverCode === 'version_conflict' || error.serverCode === 'invalid_transition');

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {changed ? t('errors.changed') : tCommon(errorMessageKey(error))}
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

      <section aria-labelledby="surgeries-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="surgeries-heading" className="text-lg font-semibold">
            {t('surgeries.heading')}
          </h2>
          {canSchedule && (
            <Button onClick={() => setDialog({ book: true })}>{t('book.open')}</Button>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Button variant="outline" onClick={() => setDay(previousDay(day))}>
            {t('day.previous')}
          </Button>
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t('day.label')}
            <input
              type="date"
              value={day}
              onChange={(event) => event.target.value && setDay(event.target.value)}
              className={control}
            />
          </label>
          <Button variant="outline" onClick={() => setDay(nextDay(day))}>
            {t('day.next')}
          </Button>
          <Button variant="outline" onClick={() => setDay(todayIn(timezone))}>
            {t('day.today')}
          </Button>
          <label className="flex min-w-44 flex-col gap-1 text-sm font-medium">
            {t('surgeries.filterRoom')}
            <select
              value={roomFilter}
              onChange={(event) => setRoomFilter(event.target.value)}
              className={control}
            >
              <option value={ALL}>{t('surgeries.allRooms')}</option>
              {roomRows
                .filter((room) => !room.archived)
                .map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <p className="text-sm text-muted-foreground">
          {total === undefined || surgeries.isPlaceholderData
            ? ''
            : t('surgeries.count', { count: total })}
        </p>
        <DataGrid
          label={t('surgeries.gridLabel')}
          columns={surgeryColumns}
          rows={rows}
          rowId={(row) => row.id}
          rowLabel={(row) => t('surgeries.rowLabel', { procedure: row.procedure })}
          actions={surgeries.isPlaceholderData ? [] : surgeryActions}
          status={surgeries.isPending ? 'loading' : surgeries.isError ? 'error' : 'ready'}
          errorMessage={surgeries.isError ? tCommon(errorMessageKey(surgeries.error)) : undefined}
          onRetry={() => void surgeries.refetch()}
          emptyMessage={t('surgeries.empty')}
          hasNextPage={surgeries.hasNextPage && !surgeries.isPlaceholderData}
          total={surgeries.isPlaceholderData ? undefined : total}
          loadingMore={surgeries.isFetchingNextPage}
          onLoadMore={() => void surgeries.fetchNextPage()}
        />
      </section>

      <section aria-labelledby="rooms-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="rooms-heading" className="text-lg font-semibold">
            {t('rooms.heading')}
          </h2>
          {canManage && (
            <Button onClick={() => setDialog({ room: 'new' })}>{t('rooms.add')}</Button>
          )}
        </div>
        <DataGrid
          label={t('rooms.gridLabel')}
          columns={roomColumns}
          rows={roomRows}
          rowId={(row) => row.id}
          rowLabel={(row) => row.name}
          actions={roomActions}
          status={rooms.isPending ? 'loading' : rooms.isError ? 'error' : 'ready'}
          errorMessage={rooms.isError ? tCommon(errorMessageKey(rooms.error)) : undefined}
          onRetry={() => void rooms.refetch()}
          emptyMessage={t('rooms.empty')}
        />
      </section>

      {dialog && 'periop' in dialog && (
        <PeriopDialog surgery={dialog.periop} onClose={closeDialog} />
      )}
      {dialog && 'recovery' in dialog && (
        <RecoveryDialog surgery={dialog.recovery} onClose={closeDialog} />
      )}
      {dialog && 'operation' in dialog && (
        <OperationDialog surgery={dialog.operation} onClose={closeDialog} />
      )}
      {dialog && 'book' in dialog && (
        <BookDialog
          day={day}
          roomId={roomFilter === ALL ? undefined : roomFilter}
          onClose={closeDialog}
          onBooked={() => {
            setDone(t('done.booked'));
            closeDialog();
          }}
        />
      )}
      {dialog && 'reschedule' in dialog && (
        <RescheduleDialog
          surgery={dialog.reschedule}
          onClose={closeDialog}
          onMoved={() => {
            setDone(t('done.rescheduled'));
            closeDialog();
          }}
        />
      )}
      {dialog && 'cancel' in dialog && (
        <CancelDialog
          surgery={dialog.cancel}
          onClose={closeDialog}
          onCancelled={() => {
            setDone(t('done.cancelled'));
            closeDialog();
          }}
        />
      )}
      {dialog && 'room' in dialog && (
        <RoomDialog
          room={dialog.room === 'new' ? undefined : dialog.room}
          onClose={closeDialog}
          onSaved={(name) => {
            setDone(t(dialog.room === 'new' ? 'done.roomAdded' : 'done.roomRenamed', { name }));
            closeDialog();
          }}
        />
      )}
    </div>
  );
}
