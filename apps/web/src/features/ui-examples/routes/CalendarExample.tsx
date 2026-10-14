import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Calendar, type CalendarEventItem, type CalendarView } from '@/shared/ui/calendar';
import { useIsDesktop } from '@/shared/hooks/use-is-desktop';
import { todayIn, zonedToUtc } from '@/shared/utils/timezone';
import { useTenant } from '@/tenancy';
import { ExamplePage } from '../components/ExamplePage';

// Synthetic events on today at the hospital. A real screen asks the server for the visible range.
const PLAN = [
  ['09:00', '09:30', 'primary'],
  ['09:30', '10:00', 'muted'],
  ['10:15', '10:30', 'struck'],
  ['11:00', '12:00', 'danger'],
  ['14:00', '14:45', 'primary'],
] as const;

export default function CalendarExample() {
  const { t } = useTranslation('ui_examples');
  const tenant = useTenant();
  const timezone = tenant?.timezone ?? 'UTC';
  const locale = tenant?.locale ?? 'en';
  const today = todayIn(timezone);
  // The week is for desktop width (CLAUDE.md, Responsive Design).
  const [chosen, setChosen] = useState<CalendarView>('week');
  const view = useIsDesktop() ? chosen : 'day';
  const [selected, setSelected] = useState<string | null>(null);

  const events = useMemo<CalendarEventItem[]>(
    () =>
      PLAN.map(([start, end, tone], index) => ({
        id: `event-${index + 1}`,
        title: t('calendar.event', { number: index + 1 }),
        start: zonedToUtc(today, start, timezone),
        end: zonedToUtc(today, end, timezone),
        tone,
      })),
    [t, today, timezone],
  );

  return (
    <ExamplePage heading={t('calendar.heading')}>
      <div className="flex flex-wrap items-center gap-2">
        {(['day', 'week'] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={view === option}
            onClick={() => setChosen(option)}
            className="h-9 rounded-md border px-3 text-sm font-medium aria-pressed:bg-primary aria-pressed:text-primary-foreground pointer-coarse:h-11"
          >
            {t(`calendar.${option}`)}
          </button>
        ))}
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {selected ? t('calendar.selected', { id: selected }) : ''}
      </p>
      <Calendar
        label={t('calendar.heading')}
        view={view}
        day={today}
        timezone={timezone}
        locale={locale}
        events={events}
        onSelectEvent={setSelected}
      />
    </ExamplePage>
  );
}
