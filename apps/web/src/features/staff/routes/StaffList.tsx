import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Can } from '@/access';
import { useSession } from '@/app/session';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import {
  SEARCH_DEBOUNCE_MS,
  useDebouncedValue,
  useSendInvite,
  useStaff,
  useStaffAction,
  type StaffAction,
} from '../hooks/use-staff';
import { STAFF_STATUSES } from '../schemas';
import type { StaffMember, StaffStatus } from '../types';

const MANAGE = 'staff:manage';
const INVITE = 'staff:invite';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';
const link =
  'inline-flex items-center rounded-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

/** What the server said, as a key of this feature's strings, when it has one. */
function refusal(error: unknown) {
  if (!isApiError(error)) return null;
  if (error.serverCode === 'cannot_deactivate_self') return 'errors.self' as const;
  if (error.serverCode === 'last_admin') return 'errors.lastAdmin' as const;
  if (error.serverCode === 'unknown_role') return 'errors.unknownRole' as const;
  if (error.serverCode === 'rate_limited') return 'errors.busy' as const;
  return null;
}

/** Asks before deactivating: it ends the person's work here at once. */
function ConfirmDeactivate({
  member,
  pending,
  onConfirm,
  onCancel,
}: {
  member: StaffMember;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('staff');
  const heading = useRef<HTMLHeadingElement>(null);
  // It opens above the list, away from the button that opened it: take the keyboard there.
  useEffect(() => heading.current?.focus(), []);
  return (
    <section
      aria-labelledby="staff-confirm"
      className="flex flex-col gap-3 rounded-lg border border-destructive/40 p-4"
    >
      <h2 id="staff-confirm" ref={heading} tabIndex={-1} className="text-lg font-semibold">
        {t('confirm.heading', { name: member.name })}
      </h2>
      <p className="text-sm text-muted-foreground">{t('confirm.body')}</p>
      <div className="flex flex-wrap gap-3">
        <Button variant="destructive" disabled={pending} onClick={onConfirm}>
          {t('confirm.yes')}
        </Button>
        <Button variant="outline" disabled={pending} onClick={onCancel}>
          {t('confirm.no')}
        </Button>
      </div>
    </section>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function StaffList() {
  const { t } = useTranslation('staff');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const ownId = useSession()?.user.id;
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StaffStatus>('active');
  const [confirming, setConfirming] = useState<StaffMember | null>(null);
  // What was just done, said once in a status line.
  const [done, setDone] = useState<string | null>(null);
  const q = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const staff = useStaff({ q, status });
  const action = useStaffAction();
  const resend = useSendInvite();

  const rows = useMemo(() => staff.data?.pages.flatMap((page) => page.items) ?? [], [staff.data]);
  const total = staff.data?.pages[0]?.total;
  const busy = action.isPending || resend.isPending;

  const clear = () => {
    action.reset();
    resend.reset();
    setDone(null);
  };

  const run = (kind: StaffAction, member: StaffMember) => {
    clear();
    setConfirming(null);
    action.mutate(
      { action: kind, member },
      { onSuccess: () => setDone(t(`done.${kind}`, { name: member.name })) },
    );
  };

  const columns = useMemo<GridColumn<StaffMember>[]>(
    () => [
      {
        id: 'name',
        header: t('columns.name'),
        value: (row) => (row.id === ownId ? t('you', { name: row.name }) : row.name),
        hideable: false,
      },
      { id: 'email', header: t('columns.email'), value: (row) => row.email },
      { id: 'role', header: t('columns.role'), value: (row) => row.roleName },
    ],
    [t, ownId],
  );

  // One change at a time: an action on its way is not overtaken by another.
  const actions: GridAction<StaffMember>[] =
    status === 'active'
      ? [
          {
            id: 'revokeSessions',
            label: t('actions.revokeSessions'),
            requires: MANAGE,
            disabled: () => busy,
            onSelect: (row) => run('revokeSessions', row),
          },
          {
            id: 'deactivate',
            label: t('actions.deactivate'),
            requires: MANAGE,
            // Nobody deactivates themselves: the server refuses it too.
            disabled: (row) => busy || row.id === ownId,
            onSelect: (row) => {
              clear();
              setConfirming(row);
            },
          },
        ]
      : status === 'deactivated'
        ? [
            {
              id: 'reactivate',
              label: t('actions.reactivate'),
              requires: MANAGE,
              disabled: () => busy,
              onSelect: (row) => run('reactivate', row),
            },
          ]
        : [
            {
              id: 'resend',
              label: t('actions.resend'),
              requires: INVITE,
              disabled: () => busy,
              onSelect: (row) => {
                clear();
                resend.mutate(
                  {
                    body: { name: row.name, email: row.email, roleId: row.roleId },
                    idempotencyKey: crypto.randomUUID(),
                  },
                  { onSuccess: () => setDone(t('done.resend', { email: row.email })) },
                );
              },
            },
          ];

  const failure = action.error ?? resend.error;
  const refused = refusal(failure);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
        <Can permission={INVITE}>
          <Link to="/staff/invite" className={`${link} pt-2 text-sm`}>
            {t('invite')}
          </Link>
        </Can>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex min-w-56 flex-1 flex-col gap-1 text-sm font-medium">
          {t('filters.search')}
          <span className="relative">
            <Search
              aria-hidden="true"
              className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
            />
            <input
              type="search"
              value={search}
              maxLength={100}
              autoComplete="off"
              placeholder={t('filters.searchPlaceholder')}
              onChange={(event) => setSearch(event.target.value)}
              className={`${control} w-full pl-8 pr-3`}
            />
          </span>
        </label>
        <label className="flex min-w-44 flex-col gap-1 text-sm font-medium">
          {t('filters.status')}
          <select
            value={status}
            disabled={busy}
            onChange={(event) => {
              clear();
              setConfirming(null);
              setStatus(STAFF_STATUSES.find((s) => s === event.target.value) ?? 'active');
            }}
            className={control}
          >
            {STAFF_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`filters.${value}`)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {confirming && (
        <Can permission={MANAGE}>
          <ConfirmDeactivate
            key={confirming.id}
            member={confirming}
            pending={busy}
            onConfirm={() => run('deactivate', confirming)}
            onCancel={() => setConfirming(null)}
          />
        </Can>
      )}

      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {refused ? t(refused) : tCommon(errorMessageKey(failure))}
        </p>
      )}
      <p role="status" className="text-sm text-muted-foreground">
        {/* Not while the previous view's rows are still shown: the total would be theirs. */}
        {done ??
          (total === undefined || staff.isPlaceholderData
            ? ''
            : t(`count.${status}`, { count: total }))}
      </p>

      <DataGrid
        label={t('gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.name}
        actions={actions}
        status={staff.isPending ? 'loading' : staff.isError ? 'error' : 'ready'}
        errorMessage={staff.isError ? tCommon(errorMessageKey(staff.error)) : undefined}
        onRetry={() => void staff.refetch()}
        emptyMessage={q.trim() ? t('empty.search') : t(`empty.${status}`)}
        hasNextPage={staff.hasNextPage}
        loadingMore={staff.isFetchingNextPage}
        onLoadMore={() => void staff.fetchNextPage()}
      />
    </div>
  );
}
