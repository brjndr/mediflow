import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { NoticeItem } from '../components/NoticeItem';
import { useArchiveNotice, useNotices } from '../hooks/use-notices';

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function NoticesPage() {
  const { t } = useTranslation('notices');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const notices = useNotices();
  const archive = useArchiveNotice();
  const items = notices.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>

      {notices.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('loading')}
        </p>
      )}

      {notices.isError && (
        <div role="alert" className="flex items-center gap-3 rounded-lg border p-4 text-sm">
          <span className="flex-1">{tCommon(errorMessageKey(notices.error))}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={notices.isFetching}
            onClick={() => void notices.refetch()}
          >
            {t('retry')}
          </Button>
        </div>
      )}

      {notices.isSuccess && items.length === 0 && (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      )}

      {archive.isError && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(archive.error))}
        </p>
      )}

      {items.length > 0 && (
        <ul className="flex flex-col gap-3">
          {items.map((notice) => (
            <NoticeItem
              key={notice.id}
              notice={notice}
              archiving={archive.isPending}
              onArchive={archive.mutate}
            />
          ))}
        </ul>
      )}

      {notices.hasNextPage && (
        <Button
          className="self-center"
          variant="outline"
          disabled={notices.isFetchingNextPage}
          onClick={() => void notices.fetchNextPage()}
        >
          {notices.isFetchingNextPage ? t('loadingMore') : t('loadMore')}
        </Button>
      )}
    </div>
  );
}
