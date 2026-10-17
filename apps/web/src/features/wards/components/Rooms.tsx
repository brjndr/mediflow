import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { Form, SelectField, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useBedCategories, useWardChange, type WardChange } from '../hooks/use-wards';
import {
  BED_NUMBER_MAX,
  bedFormSchema,
  BLOCK_REASONS,
  blockFormSchema,
  NOTE_MAX,
  ROOM_NAME_MAX,
  roomFormSchema,
  type BedFormValues,
} from '../schemas';
import type { Bed, BedCategory, Room, WardDetail } from '../types';
import { refusalKey } from './refusal';
import { useExpectedVersion } from './use-expected';

/**
 * The one form that is open in the ward, if any. A form that changes a room or a bed holds it as
 * it was when the form opened: what is sent is what was changed since then, from that version.
 */
type Panel =
  | { kind: 'addRoom' }
  | { kind: 'renameRoom'; room: Room }
  | { kind: 'addBed'; roomId: string }
  | { kind: 'editBed'; bed: Bed }
  | { kind: 'blockBed'; bedId: string }
  | null;

type Outcome = 'done' | 'conflict' | 'failed';
/** Makes a change from the open form, says it was done, and closes the form when it was. */
type Run = (change: WardChange, done: string) => Promise<Outcome>;

/** The bed categories a bed can be given, and how asking for them went. */
interface Categories {
  items: BedCategory[];
  loading: boolean;
  failed: boolean;
  retry: () => void;
}

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
      <Button
        type="button"
        variant="outline"
        aria-disabled={pending || undefined}
        onClick={onCancel}
      >
        {t('rooms.cancel')}
      </Button>
    </div>
  );
}

/** A room's name, for a new room or one being renamed. */
function RoomForm({
  from,
  latest,
  pending,
  run,
  onCancel,
}: {
  /** The room as it was when the form opened. Absent for a new room. */
  from?: Room;
  /** The room as it is saved now. */
  latest?: Room;
  pending: boolean;
  run: Run;
  onCancel: () => void;
}) {
  const { t } = useTranslation('wards');
  const form = useZodForm(roomFormSchema, { name: from?.name ?? '' });
  const version = useExpectedVersion(from?.version ?? 0, latest?.version);
  return (
    <div className={panelBox}>
      <h3
        data-panel-heading
        tabIndex={-1}
        className="rounded-sm text-base font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {from ? t('rooms.rename', { name: from.name }) : t('rooms.addHeading')}
      </h3>
      <Form
        form={form}
        onSubmit={async ({ name }) => {
          if (!from) return void (await run({ type: 'addRoom', name }, t('rooms.added', { name })));
          const outcome = await run(
            { type: 'renameRoom', roomId: from.id, name, expectedVersion: version.expected },
            t('rooms.renamed', { name }),
          );
          if (outcome === 'conflict') version.conflict();
        }}
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
          submit={from ? t('rooms.renameSubmit') : t('rooms.addSubmit')}
          pending={pending}
          onCancel={onCancel}
        />
      </Form>
    </div>
  );
}

const bedValues = (bed?: Bed): BedFormValues => ({
  number: bed?.number ?? '',
  bedCategoryId: bed?.bedCategoryId ?? '',
});

/** A bed's number and category, for a new bed or one being changed. */
function BedForm({
  room,
  from,
  latest,
  categories,
  pending,
  run,
  onCancel,
}: {
  room: Room;
  /** The bed as it was when the form opened. Absent for a new bed. */
  from?: Bed;
  /** The bed as it is saved now. Differs from `from` once someone else has changed it. */
  latest?: Bed;
  categories: Categories;
  pending: boolean;
  run: Run;
  onCancel: () => void;
}) {
  const { t } = useTranslation('wards');
  const form = useZodForm(bedFormSchema, bedValues(from));
  // Read while rendering, which is what keeps it up to date.
  const { dirtyFields } = form.formState;
  const version = useExpectedVersion(from?.version ?? 0, latest?.version);
  // What someone else saved meanwhile goes into the fields this person has not touched. What was
  // typed stays, and is all that is sent.
  const { reset } = form;
  useEffect(() => {
    if (latest) reset(bedValues(latest), { keepDirtyValues: true });
  }, [reset, latest]);

  // The bed's own category stays an option when it has been archived since.
  const own = [from, latest].flatMap((bed) =>
    bed && !categories.items.some((category) => category.id === bed.bedCategoryId)
      ? [{ value: bed.bedCategoryId, label: bed.bedCategoryName }]
      : [],
  );
  const options = [
    ...own.filter((option, index) => own.findIndex((o) => o.value === option.value) === index),
    ...categories.items.map((category) => ({ value: category.id, label: category.name })),
  ];

  const submit = async (values: BedFormValues) => {
    if (!from) {
      await run(
        { type: 'addBed', roomId: room.id, ...values },
        t('beds.added', { number: values.number }),
      );
      return;
    }
    const body = {
      ...(dirtyFields.number ? { number: values.number } : {}),
      ...(dirtyFields.bedCategoryId ? { bedCategoryId: values.bedCategoryId } : {}),
      expectedVersion: version.expected,
    };
    const outcome = await run(
      { type: 'updateBed', bedId: from.id, body },
      t('beds.saved', { number: values.number }),
    );
    if (outcome === 'conflict') version.conflict();
  };

  const heading = (
    <h3
      data-panel-heading
      tabIndex={-1}
      className="rounded-sm text-base font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      {from
        ? t('beds.editHeading', { number: from.number })
        : t('beds.addHeading', { room: room.name })}
    </h3>
  );
  const cancel = (
    <Button type="button" variant="outline" className="self-start" onClick={onCancel}>
      {t('beds.cancel')}
    </Button>
  );

  // Nothing is said about the categories until it is known what they are.
  if (categories.loading) {
    return (
      <div className={panelBox}>
        {heading}
        <p role="status" className="text-sm text-muted-foreground">
          {t('beds.categoriesLoading')}
        </p>
        {cancel}
      </div>
    );
  }
  if (categories.failed) {
    return (
      <div className={panelBox}>
        {heading}
        <p role="alert" className="text-sm text-destructive">
          {t('beds.categoriesFailed')}
        </p>
        <div className="flex flex-wrap gap-3">
          <Button type="button" variant="outline" onClick={categories.retry}>
            {t('beds.categoriesRetry')}
          </Button>
          {cancel}
        </div>
      </div>
    );
  }
  if (options.length === 0) {
    return (
      <div className={panelBox}>
        {heading}
        <p className="text-sm text-muted-foreground">{t('beds.noCategories')}</p>
        {cancel}
      </div>
    );
  }

  return (
    <div className={panelBox}>
      {heading}
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
          submit={from ? t('beds.editSubmit') : t('beds.addSubmit')}
          pending={pending}
          onCancel={onCancel}
        />
      </Form>
    </div>
  );
}

/** Why a bed is taken out of use: a reason from a list, and a few words when they help. */
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
  const form = useZodForm(blockFormSchema, { reason: '', note: '' });
  return (
    <div className={panelBox}>
      <h3
        data-panel-heading
        tabIndex={-1}
        className="rounded-sm text-base font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {t('beds.blockHeading', { number: bed.number })}
      </h3>
      <Form
        form={form}
        onSubmit={async ({ reason, note }) => {
          await run(
            { type: 'blockBed', bedId: bed.id, reason, note },
            t('beds.blocked', { number: bed.number }),
          );
        }}
      >
        <SelectField
          name="reason"
          label={t('beds.reason')}
          required
          placeholder={t('beds.chooseReason')}
          options={BLOCK_REASONS.map((value) => ({ value, label: t(`beds.reasons.${value}`) }))}
        />
        <TextField
          name="note"
          label={t('beds.note')}
          hint={t('beds.noteHint')}
          maxLength={NOTE_MAX}
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
  act,
}: {
  room: Room;
  /** The person may change the ward, and the ward is not archived. */
  mayManage: boolean;
  showArchived: boolean;
  categories: Categories;
  panel: Panel;
  open: (panel: Panel) => void;
  pending: boolean;
  run: Run;
  /** A change made straight from a button, with no form. */
  act: (change: WardChange, done: string) => void;
}) {
  const { t } = useTranslation('wards');
  const headingId = `room-${room.id}`;
  const beds = useMemo(
    () => room.beds.filter((bed) => showArchived || !bed.archived),
    [room.beds, showArchived],
  );
  // While a form is open nothing else is started: its answer would land on the form.
  const busy = pending || panel !== null;
  // A form is for a room that can still be changed by this person.
  const forms = mayManage && !room.archived;
  const inRoom = (id: string) => room.beds.find((bed) => bed.id === id && !bed.archived);
  const editing = forms && panel?.kind === 'editBed' ? inRoom(panel.bed.id) : undefined;
  const blocking = forms && panel?.kind === 'blockBed' ? inRoom(panel.bedId) : undefined;

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
          if (bed.status !== 'blocked' || !bed.blockedReason) return t(`beds.status.${bed.status}`);
          const reason = t(`beds.reasons.${bed.blockedReason}`);
          return bed.blockedNote
            ? t('beds.status.blockedNoted', { reason, note: bed.blockedNote })
            : t('beds.status.blockedFor', { reason });
        },
      },
    ],
    [t],
  );

  // The server decides every transition; here only the ones that can succeed are offered.
  const actions: GridAction<Bed>[] = forms
    ? [
        {
          id: 'edit',
          label: t('beds.actions.edit'),
          disabled: (bed) => busy || bed.archived,
          onSelect: (bed) => open({ kind: 'editBed', bed }),
        },
        {
          id: 'block',
          label: t('beds.actions.block'),
          disabled: (bed) => busy || bed.archived || bed.status !== 'available',
          onSelect: (bed) => open({ kind: 'blockBed', bedId: bed.id }),
        },
        {
          id: 'unblock',
          label: t('beds.actions.unblock'),
          disabled: (bed) => busy || bed.archived || bed.status !== 'blocked',
          onSelect: (bed) =>
            act({ type: 'unblockBed', bedId: bed.id }, t('beds.unblocked', { number: bed.number })),
        },
        {
          id: 'archive',
          label: t('beds.actions.archive'),
          disabled: (bed) => busy || bed.archived || bed.status === 'occupied',
          onSelect: (bed) =>
            act(
              { type: 'archiveBed', bedId: bed.id },
              t('beds.archivedDone', { number: bed.number }),
            ),
        },
        {
          id: 'restore',
          label: t('beds.actions.restore'),
          disabled: (bed) => busy || !bed.archived,
          onSelect: (bed) =>
            act(
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
                aria-disabled={busy || undefined}
                onClick={() =>
                  act(
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
                  aria-disabled={busy || undefined}
                  onClick={() => open({ kind: 'addBed', roomId: room.id })}
                >
                  {t('beds.add', { room: room.name })}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  aria-disabled={busy || undefined}
                  onClick={() => open({ kind: 'renameRoom', room })}
                >
                  {t('rooms.rename', { name: room.name })}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  aria-disabled={busy || undefined}
                  onClick={() =>
                    act(
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

      {forms && panel?.kind === 'renameRoom' && panel.room.id === room.id && (
        <RoomForm from={panel.room} latest={room} pending={pending} run={run} onCancel={close} />
      )}
      {forms && panel?.kind === 'addBed' && panel.roomId === room.id && (
        <BedForm room={room} categories={categories} pending={pending} run={run} onCancel={close} />
      )}
      {panel?.kind === 'editBed' && editing && (
        <BedForm
          room={room}
          from={panel.bed}
          latest={editing}
          categories={categories}
          pending={pending}
          run={run}
          onCancel={close}
        />
      )}
      {blocking && <BlockForm bed={blocking} pending={pending} run={run} onCancel={close} />}
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
  const bedCategories = useBedCategories(false, mayManage);
  const [showArchived, setShowArchived] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  // What was just done, said once in a status line.
  const [done, setDone] = useState<string | null>(null);

  const categories: Categories = {
    items: bedCategories.data ?? [],
    loading: bedCategories.isPending,
    failed: bedCategories.isError,
    retry: () => void bedCategories.refetch(),
  };

  const open = (next: Panel) => {
    change.reset();
    // A form that is opened, or left, starts a new attempt: what is added from it is not taken
    // for a repeat of something added from a form before it.
    change.newAttempt();
    setDone(null);
    setPanel(next);
  };

  const send = async (action: WardChange, message: string): Promise<Outcome> => {
    setDone(null);
    try {
      await change.mutateAsync(action);
      setDone(message);
      return 'done';
    } catch (error) {
      // Shown from the mutation state below.
      return isApiError(error) && error.serverCode === 'conflict' ? 'conflict' : 'failed';
    }
  };
  // From a form: the form stays, with what was typed, unless the change was made.
  const run: Run = async (action, message) => {
    const outcome = await send(action, message);
    if (outcome === 'done') setPanel(null);
    return outcome;
  };
  const act = (action: WardChange, message: string) => {
    change.reset();
    void send(action, message);
  };

  const rooms = detail.rooms.filter((room) => showArchived || !room.archived);
  const refused = refusalKey(change.error);

  // A form whose room or bed can no longer be changed (archived meanwhile, or the right to
  // change the ward gone) is no longer open: nothing waits behind a form that is not shown.
  const stillOpen = (): Panel => {
    if (!panel || !mayManage || panel.kind === 'addRoom') return mayManage ? panel : null;
    const holds = (room: Room) => {
      if (panel.kind === 'renameRoom') return room.id === panel.room.id;
      if (panel.kind === 'addBed') return room.id === panel.roomId;
      const bedId = panel.kind === 'editBed' ? panel.bed.id : panel.bedId;
      return room.beds.some((bed) => bed.id === bedId && !bed.archived);
    };
    return detail.rooms.some((room) => !room.archived && holds(room)) ? panel : null;
  };
  const shown = stillOpen();

  // A form opens beside the rooms, from one of many buttons: the keyboard goes to its heading,
  // and back to the button when it closes, or to the line that says what was done.
  const box = useRef<HTMLElement>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  usePanelFocus(shown, box, statusLine);

  return (
    <section ref={box} aria-labelledby="ward-rooms" className="flex flex-col gap-3">
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
      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {done ?? ''}
      </p>

      {rooms.length === 0 && <p className="text-sm text-muted-foreground">{t('rooms.none')}</p>}
      {rooms.map((room) => (
        <RoomCard
          key={room.id}
          room={room}
          mayManage={mayManage}
          showArchived={showArchived}
          categories={categories}
          panel={shown}
          open={open}
          pending={change.isPending}
          run={run}
          act={act}
        />
      ))}

      {mayManage &&
        (shown?.kind === 'addRoom' ? (
          <RoomForm pending={change.isPending} run={run} onCancel={() => open(null)} />
        ) : (
          <Button
            variant="outline"
            className="self-start"
            aria-disabled={change.isPending || shown !== null || undefined}
            onClick={() => open({ kind: 'addRoom' })}
          >
            {t('rooms.add')}
          </Button>
        ))}
    </section>
  );
}
