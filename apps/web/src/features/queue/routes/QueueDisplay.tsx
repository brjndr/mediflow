import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { errorMessageKey } from '@/shared/api';
import { Card } from '@/shared/ui/card';
import { LiveStatus } from '../components/LiveStatus';
import { useQueueDisplay, useQueueEvents } from '../hooks/use-queue';

/**
 * The waiting-room display (#78): for each department the token numbers being served, the doctor
 * they go to, and the numbers next. It reads `GET /queue/display`, which holds no patient, so
 * nothing about anyone is in the browser's memory or on the screen. For signed-in staff only.
 */
// Default export: route modules are loaded by the manifest with a dynamic import.
export default function QueueDisplay() {
  const { t } = useTranslation('queue');
  const { t: tCommon } = useTranslation();
  const events = useQueueEvents(true, '');
  const display = useQueueDisplay({ enabled: true, live: events === 'live' });
  const departments = display.data?.departments ?? [];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('display.heading')}</h1>
        <p className="text-muted-foreground">{t('display.description')}</p>
        <LiveStatus status={events} />
        <p>
          <Link to="/queue" className="text-sm font-medium underline underline-offset-4">
            {t('display.back')}
          </Link>
        </p>
      </div>

      {display.isError && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(display.error))}
        </p>
      )}
      {display.isSuccess && departments.length === 0 && (
        <p className="text-lg text-muted-foreground">{t('display.empty')}</p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {departments.map((department) => (
          <Card asChild key={department.departmentId} className="flex flex-col gap-4 p-5">
            <section aria-labelledby={`display-${department.departmentId}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 id={`display-${department.departmentId}`} className="text-xl font-semibold">
                  {department.departmentName}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t('display.waiting', { count: department.waiting })}
                </p>
              </div>

              <div className="space-y-2">
                <h3 className="text-sm font-medium text-muted-foreground">
                  {t('display.nowServing')}
                </h3>
                {department.serving.length === 0 ? (
                  <p className="text-base">{t('display.nobodyServing')}</p>
                ) : (
                  <ul className="space-y-2">
                    {department.serving.map((serving) => (
                      <li
                        key={`${serving.number}-${serving.doctorName ?? ''}`}
                        className="flex flex-wrap items-baseline gap-x-4 gap-y-1"
                      >
                        <span className="text-5xl font-bold tabular-nums">
                          {t('display.token', { number: serving.number })}
                        </span>
                        {serving.doctorName && (
                          <span className="text-lg">{serving.doctorName}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="space-y-2">
                <h3 className="text-sm font-medium text-muted-foreground">{t('display.next')}</h3>
                {department.next.length === 0 ? (
                  <p className="text-base">{t('display.nobodyWaiting')}</p>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {department.next.map((number) => (
                      <li
                        key={number}
                        className="rounded-md border px-3 py-1 text-2xl font-semibold tabular-nums"
                      >
                        {number}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </Card>
        ))}
      </div>
    </div>
  );
}
