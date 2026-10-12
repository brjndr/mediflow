import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { Form, SelectField, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useBedCategories, useWardChange, type WardChange } from '../hooks/use-wards';
import {
  BED_NUMBER_MAX,
  bedFormSchema,
  blockFormSchema,
  REASON_MAX,
  ROOM_NAME_MAX,
  roomFormSchema,
  type BedFormValues,
} from '../schemas';
import type { Bed, BedCategory, Room, WardDetail } from '../types';
import { refusalKey } from './refusal';

/** The one form that is open in the ward, if any. Beds and rooms are named by id. */
type Panel =
  | { kind: 'addRoom' }
  | { kind: 'renameRoom' | 'addBed'; roomId: string }
  | { kind: 'editBed' | 'blockBed'; bedId: string }
  | null;

type Run = (change: WardChange, done: string) => Promise<void>;

const panelBox = 'flex max-w-xl flex-col gap-3 rounded-lg border p-4';

function Buttons({
  submit,
  pending,
  onCancel,
}: {
  submit: string;
  pending: boolean;
  onCancel: () => void;
}) {
  const { t } = useTranslation('wards');
  return (
    <div className="flex flex-wrap gap-3">
      <SubmitButton pending={pending}>{submit}</SubmitButton>
      <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
        {t('rooms.cancel')}
      </Button>
    </div>
  );
}

/** A room's name, for a new room or one being renamed. */
function RoomForm({
  room,
  pending,
  run,
  onCancel,
}: {
  room?: Room;
  pending: boolean;
  run: Run;
  onCancel: () => void;
}) {
  const { t } = useTranslation('wards');
  const form = useZodForm(roomFormSchema, { name: room?.name ?? '' });
  return (
    <div className={panelBox}>
      <h3 className="text-base font-semibold">
        {room ? t('rooms.rename', { name: room.name }) : t('rooms.addHeading')}
      </h3>
      <Form
        form={form}
        onSubmit={({ name }) =>
          room
            ? run(
                { type: 'renameRoom', roomId: room.id, name, expectedVersion: room.version },
                t('rooms.renamed', { name }),
              )
            : run({ type: 'addRoom', name }, t('rooms.added', { name }))
        }
      >
        <TextField
          name="name"
          label={t('rooms.name')}
          hint={t('rooms.nameHint')}
          required
          maxLength={ROOM_NAME_MAX}
          autoComplete="off"
        />
        <Buttons
          submit={room ? t('rooms.renameSubmit') : t('rooms.addSubmit')}
          pending={pending}
          onCancel={onCancel}
        />
      </Form>
    </div>
  );
}

/** A bed's number and category, for a new bed or one being changed. */
function BedForm({
  room,
  bed,
  categories,
  pending,
  run,
  onCancel,
}: {
  room: Room;
  bed?: Bed;
  categories: BedCategory[];
  pending: boolean;
  run: Run;
  onCancel: () => void;
}) {
  const { t } = useTranslation('wards');
  const form = useZodForm(bedFormSchema, {
    number: bed?.number ?? '',
    bedCategoryId: bed?.bedCategoryId ?? '',
  });
  // The bed's own category stays an option when it has been archived since.
  const options = [
    ...(bed && !categories.some((category) => category.id === bed.bedCategoryId)
      ? [{ value: bed.bedCategoryId, label: bed.bedCategoryName }]
      : []),
    ...categories.map((category) => ({ value: category.id, label: category.name })),
  ];

  const submit = (values: BedFormValues) => {
    if (!bed) {
      return run(
        { type: 'addBed', roomId: room.id, ...values },
        t('beds.added', { number: values.number }),
      );
    }
    // Only what was changed is sent, from the version of the bed that is on screen now.
    const body = {
      ...(values.number === bed.number ? {} : { number: values.number }),
      ...(values.bedCategoryId === bed.bedCategoryId
        ? {}
        : { bedCategoryId: values.bedCategoryId }),
      expectedVersion: bed.version,
    };
    return run(
      { type: 'updateBed', bedId: bed.id, body },
      t('beds.saved', { number: values.number }),
    );
  };

  return (
    <div className={panelBox}>
      <h3 className="text-base font-semibold">
        {bed
          ? t('beds.editHeading', { number: bed.number })
          : t('beds.addHeading', { room: room.name })}
      </h3>
      {options.length === 0 ? (
        <>
          <p className="text-sm text-muted-foreground">{t('beds.noCategories')}</p>
          <Button type="button" variant="outline" className="self-start" onClick={onCancel}>
            {t('beds.cancel')}
          </Button>
        </>
      ) : (
        <Form form={form} onSubmit={submit}>
          <TextField
            name="number"
            label={t('beds.number')}
            hint={t('beds.numberHint')}
            required
            maxLength={BED_NUMBER_MAX}
            autoComplete="off"
          />
          <SelectField
            name="bedCategoryId"
            label={t('beds.category')}
            required
            placeholder={t('beds.chooseCategory')}
            options={options}
          />
          <Buttons
            submit={bed ? t('beds.editSubmit') : t('beds.addSubmit')}
            pending={pending}
            onCancel={onCancel}
          />
        </Form>
      )}
    </div>
  );
}

/** Why a bed is taken out of use. */
function BlockForm({
  bed,
  pending,
  run,
  onCancel,
}: {
  bed: Bed;
  pending: boolean;
  run: Run;
  onCancel: () => void;
}) {
  const { t } = useTranslation('wards');
  const form = useZodForm(blockFormSchema, { reason: '' });
  return (
    <div className={panelBox}>
      <h3 className="text-base font-semibold">{t('beds.blockHeading', { number: bed.number })}</h3>
      <Form
        form={form}
        onSubmit={({ reason }) =>
          run(
            { type: 'blockBed', bedId: bed.id, reason },
            t('beds.blocked', { number: bed.number }),
          )
        }
      >
        <TextField
          name="reason"
          label={t('beds.reason')}
          hint={t('beds.reasonHint')}
          required
          maxLength={REASON_MAX}
          autoComplete="off"
        />
        <Buttons submit={t('beds.blockSubmit')} pending={pending} onCancel={onCancel} />
      </Form>
    </div>
  );
}

function RoomCard({
  room,
  mayManage,
  showArchived,
  categories,
  panel,
  open,
  pending,
  run,
}: {
  room: Room;
  /** The person may change the ward, and the ward is not archived. */
  mayManage: boolean;
  showArchived: boolean;
  categories: BedCategory[];
  panel: Panel;
  open: (panel: Panel) => void;
  pending: boolean;
  run: Run;
}) {
  const { t } = useTranslation('wards');
  const headingId = `room-${room.id}`;
  const beds = useMemo(
    () => room.beds.filter((bed) => showArchived || !bed.archived),
    [room.beds, showArchived],
  );
  const bedOf = (kind: 'editBed' | 'blockBed') =>
    panel?.kind === kind ? room.beds.find((bed) => bed.id === panel.bedId) : undefined;
  const editing = bedOf('editBed');
  const blocking = bedOf('blockBed');

  const columns = useMemo<GridColumn<Bed>[]>(
    () => [
      {
        id: 'number',
        header: t('beds.columns.number'),
        value: (bed) => bed.number,
        hideable: false,
      },
      { id: 'category', header: t('beds.columns.category'), value: (bed) => bed.bedCategoryName },
      {
        id: 'status',
        header: t('beds.columns.status'),
        value: (bed) => {
          if (bed.archived) return t('beds.status.archived');
          return bed.status === 'blocked' && bed.blockedReason
            ? t('beds.status.blockedFor', { reason: bed.blockedReason })
            : t(`beds.status.${bed.status}`);
        },
      },
    ],
    [t],
  );

  // The server decides every transition; here only the ones that can succeed are offered.
  const actions: GridAction<Bed>[] =
    mayManage && !room.archived
      ? [
          {
            id: 'edit',
            label: t('beds.actions.edit'),
            disabled: (bed) => pending || bed.archived,
            onSelect: (bed) => open({ kind: 'editBed', bedId: bed.id }),
          },
          {
            id: 'block',
            label: t('beds.actions.block'),
            disabled: (bed) => pending || bed.archived || bed.status !== 'available',
            onSelect: (bed) => open({ kind: 'blockBed', bedId: bed.id }),
          },
          {
            id: 'unblock',
            label: t('beds.actions.unblock'),
            disabled: (bed) => pending || bed.archived || bed.status !== 'blocked',
            onSelect: (bed) =>
              void run(
                { type: 'unblockBed', bedId: bed.id },
                t('beds.unblocked', { number: bed.number }),
              ),
          },
          {
            id: 'archive',
            label: t('beds.actions.archive'),
            disabled: (bed) => pending || bed.archived || bed.status === 'occupied',
            onSelect: (bed) =>
              void run(
                { type: 'archiveBed', bedId: bed.id },
                t('beds.archivedDone', { number: bed.number }),
              ),
          },
          {
            id: 'restore',
            label: t('beds.actions.restore'),
            disabled: (bed) => pending || !bed.archived,
            onSelect: (bed) =>
              void run(
                { type: 'restoreBed', bedId: bed.id },
                t('beds.restoredDone', { number: bed.number }),
              ),
          },
        ]
      : [];

  const close = () => open(null);
  const badge = 'ml-2 rounded-full border px-2 py-0.5 text-xs font-medium';

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id={headingId} className="text-base font-semibold break-words">
          {room.name}
          {room.archived && <span className={badge}>{t('rooms.archived')}</span>}
        </h3>
        {mayManage && (
          <div className="flex flex-wrap gap-2">
            {room.archived ? (
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() =>
                  void run(
                    { type: 'restoreRoom', roomId: room.id },
                    t('rooms.restoredDone', { name: room.name }),
                  )
                }
              >
                {t('rooms.restore', { name: room.name })}
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => open({ kind: 'addBed', roomId: room.id })}
                >
                  {t('beds.add', { room: room.name })}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => open({ kind: 'renameRoom', roomId: room.id })}
                >
                  {t('rooms.rename', { name: room.name })}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    void run(
                      { type: 'archiveRoom', roomId: room.id },
                      t('rooms.archivedDone', { name: room.name }),
                    )
                  }
                >
                  {t('rooms.archive', { name: room.name })}
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      <DataGrid
        label={t('beds.gridLabel', { room: room.name })}
        columns={columns}
        rows={beds}
        rowId={(bed) => bed.id}
        rowLabel={(bed) => bed.number}
        actions={actions}
        status="ready"
        emptyMessage={t('beds.none')}
      />

      {panel?.kind === 'renameRoom' && panel.roomId === room.id && (
        <RoomForm room={room} pending={pending} run={run} onCancel={close} />
      )}
      {panel?.kind === 'addBed' && panel.roomId === room.id && (
        <BedForm room={room} categories={categories} pending={pending} run={run} onCancel={close} />
      )}
      {editing && (
        <BedForm
          // A form for each bed: choosing another bed starts from that bed.
          key={editing.id}
          room={room}
          bed={editing}
          categories={categories}
          pending={pending}
          run={run}
          onCancel={close}
        />
      )}
      {blocking && (
        <BlockForm key={blocking.id} bed={blocking} pending={pending} run={run} onCancel={close} />
      )}
    </section>
  );
}

/**
 * The rooms of a ward and the beds in each. A manager adds, renames and archives rooms and beds,
 * and blocks a bed or puts it back in use. Occupied and being cleaned are shown and never set
 * here: admissions and housekeeping set them.
 */
export function Rooms({ detail }: { detail: WardDetail }) {
  const { t } = useTranslation('wards');
  const { t: tCommon } = useTranslation();
  const mayManage = usePermission('ward:manage') && !detail.ward.archived;
  const change = useWardChange(detail.ward.id);
  const categories = useBedCategories(false, mayManage);
  const [showArchived, setShowArchived] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  // What was just done, said once in a status line.
  const [done, setDone] = useState<string | null>(null);

  const open = (next: Panel) => {
    change.reset();
    setDone(null);
    setPanel(next);
  };

  const run: Run = async (action, message) => {
    setDone(null);
    try {
      await change.mutateAsync(action);
      setPanel(null);
      setDone(message);
    } catch {
      // Shown from the mutation state below. The form stays, with what was typed.
    }
  };

  const rooms = detail.rooms.filter((room) => showArchived || !room.archived);
  const refused = refusalKey(change.error);

  return (
    <section aria-labelledby="ward-rooms" className="flex flex-col gap-3">
      <div className="space-y-1">
        <h2 id="ward-rooms" className="text-lg font-semibold">
          {t('rooms.heading')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('rooms.description')}</p>
      </div>
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          className="h-4 w-4"
          checked={showArchived}
          onChange={(event) => setShowArchived(event.target.checked)}
        />
        {t('rooms.showArchived')}
      </label>

      {change.isError && (
        <p role="alert" className="text-sm text-destructive">
          {refused ? t(refused) : tCommon(errorMessageKey(change.error))}
        </p>
      )}
      <p role="status" className="text-sm text-muted-foreground">
        {done ?? ''}
      </p>

      {rooms.length === 0 && <p className="text-sm text-muted-foreground">{t('rooms.none')}</p>}
      {rooms.map((room) => (
        <RoomCard
          key={room.id}
          room={room}
          mayManage={mayManage}
          showArchived={showArchived}
          categories={categories.data ?? []}
          panel={panel}
          open={open}
          pending={change.isPending}
          run={run}
        />
      ))}

      {mayManage &&
        (panel?.kind === 'addRoom' ? (
          <RoomForm pending={change.isPending} run={run} onCancel={() => open(null)} />
        ) : (
          <Button
            variant="outline"
            className="self-start"
            disabled={change.isPending}
            onClick={() => open({ kind: 'addRoom' })}
          >
            {t('rooms.add')}
          </Button>
        ))}
    </section>
  );
}
