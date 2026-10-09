import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Can } from '@/access';
import { Button } from '@/shared/ui/button';
import { useTenant } from '@/tenancy';
import type { Notice } from '../types';

interface NoticeItemProps {
  notice: Notice;
  onArchive: (noticeId: string) => void;
  archiving: boolean;
}

export function NoticeItem({ notice, onArchive, archiving }: NoticeItemProps) {
  const { t } = useTranslation('notices');
  const tenant = useTenant();
  // Stored in UTC, shown in the hospital's locale and timezone. F-06 adds shared formatters.
  const posted = useMemo(
    () =>
      new Intl.DateTimeFormat(tenant?.locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: tenant?.timezone,
      }).format(new Date(notice.createdAt)),
    [notice.createdAt, tenant?.locale, tenant?.timezone],
  );

  return (
    <li className="flex items-start gap-4 rounded-lg border p-4">
      <div className="min-w-0 flex-1 space-y-1">
        <h2 className="font-medium">{notice.title}</h2>
        <p className="text-sm text-muted-foreground">{notice.body}</p>
        <p className="text-xs text-muted-foreground">{t('postedOn', { date: posted })}</p>
      </div>
      <Can permission="notice:manage">
        <Button
          size="sm"
          variant="outline"
          disabled={archiving}
          aria-label={t('archiveLabel', { title: notice.title })}
          onClick={() => onArchive(notice.id)}
        >
          {t('archive')}
        </Button>
      </Can>
    </li>
  );
}
