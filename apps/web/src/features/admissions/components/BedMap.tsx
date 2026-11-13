import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { isAllowed, useAccessPolicy, usePermission } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import type { GridAction } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import type { BoardFilters } from '../api';
import { useBoard } from '../hooks/use-board';
import type { BoardBed } from '../types';
import { StatusBadge } from './StatusBadge';

interface RoomGroup {
  id: string;
  name: string;
  beds: BoardBed[];
}
interface WardGroup {
  id: string;
  name: string;
  rooms: RoomGroup[];
}

/** The beds as they come (ward, then bed number), gathered into wards and their rooms. */
function groupBeds(beds: BoardBed[]): WardGroup[] {
  const wards = new Map<string, WardGroup>();
  for (const bed of beds) {
    let ward = wards.get(bed.wardId);
    if (!ward) {
      ward = { id: bed.wardId, name: bed.wardName, rooms: [] };
      wards.set(bed.wardId, ward);
    }
    let room = ward.rooms.find((each) => each.id === bed.roomId);
    if (!room) {
      room = { id: bed.roomId, name: bed.roomName, beds: [] };
      ward.rooms.push(room);
    }
    room.beds.push(bed);
  }
  return [...wards.values()];
}

/**
 * The same beds as the list (same request, same filters), drawn by ward and room. A bed shows
 * its status, who is in it and any hold, and carries the same actions as a list row.
 */
export function BedMap({
  filters,
  live,
  actions,
}: {
  filters: BoardFilters;
  live: boolean;
  actions: GridAction<BoardBed>[];
}) {
  const { t } = useTranslation('admissions');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const policy = useAccessPolicy();
  const mayOpenPatient = usePermission('patient:read');
  const beds = useBoard(filters, live);
  const rows = useMemo(() => beds.data?.pages.flatMap((page) => page.items) ?? [], [beds.data]);
  const wards = useMemo(() => groupBeds(rows), [rows]);
  const total = beds.data?.pages[0]?.total;
  const allowed = actions.filter(
    (action) => action.requires === undefined || isAllowed(policy, { requires: action.requires }),
  );
  const busy = beds.isPlaceholderData;

  if (beds.isPending) return <p role="status">{tCommon('grid.loading')}</p>;
  if (beds.isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(beds.error))}
        </p>
        <Button variant="outline" onClick={() => void beds.refetch()}>
          {tCommon('grid.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {total === undefined || busy ? '' : t('count', { count: total })}
      </p>
      {rows.length === 0 && <p>{t('empty')}</p>}
      {wards.map((ward) => (
        <section key={ward.id} aria-labelledby={`map-ward-${ward.id}`} className="space-y-2">
          <h2 id={`map-ward-${ward.id}`} className="text-lg font-semibold">
            {ward.name}
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {ward.rooms.map((room) => (
              <div key={room.id} className="rounded-lg border bg-card p-3">
                <h3 className="mb-2 text-sm font-medium text-muted-foreground">{room.name}</h3>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {room.beds.map((bed) => (
                    <li
                      key={bed.id}
                      aria-label={t('rowLabel', { number: bed.number, ward: bed.wardName })}
                      className="flex flex-col gap-1 rounded-md border p-2 text-sm"
                    >
                      <span className="font-semibold">{bed.number}</span>
                      <StatusBadge bed={bed} />
                      {bed.occupant &&
                        (mayOpenPatient ? (
                          <Link
                            to={`/patients/${bed.occupant.patientId}`}
                            className="font-medium underline underline-offset-2"
                            aria-label={t('openPatient', {
                              name: bed.occupant.patientName,
                              number: bed.number,
                            })}
                          >
                            {bed.occupant.patientName}
                          </Link>
                        ) : (
                          <span>{bed.occupant.patientName}</span>
                        ))}
                      {bed.reservation && (
                        <span className="text-muted-foreground">
                          {t('reservation.heldFor', {
                            name: bed.reservation.patientName,
                            until: format.dateTime(bed.reservation.expiresAt),
                          })}
                        </span>
                      )}
                      {!busy && (
                        <div className="flex flex-wrap gap-1 pt-1">
                          {allowed.map((action) => (
                            <Button
                              key={action.id}
                              size="sm"
                              variant="outline"
                              aria-disabled={action.disabled?.(bed) || undefined}
                              aria-label={`${action.label}, ${t('rowLabel', {
                                number: bed.number,
                                ward: bed.wardName,
                              })}`}
                              onClick={() => {
                                if (!action.disabled?.(bed)) action.onSelect(bed);
                              }}
                            >
                              {action.label}
                            </Button>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}
      {beds.hasNextPage && !busy && (
        <Button
          variant="outline"
          className="self-start"
          aria-disabled={beds.isFetchingNextPage || undefined}
          onClick={() => void beds.fetchNextPage()}
        >
          {tCommon('grid.loadMore')}
        </Button>
      )}
    </div>
  );
}
