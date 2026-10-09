import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import { useAppDispatch, useAppSelector } from './store-hooks';
import { setNotice } from './ui-slice';

/** One dismissible message under the header. F-10 replaces it with the app's notification surface. */
export function NoticeBanner() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const notice = useAppSelector((state) => state.ui.notice);
  if (!notice) return null;
  return (
    <div role="status" className="flex items-center gap-3 border-b bg-accent px-4 py-2 text-sm">
      <span className="flex-1">{t(`notice.${notice}`)}</span>
      <Button size="sm" variant="outline" onClick={() => dispatch(setNotice(null))}>
        {t('notice.dismiss')}
      </Button>
    </div>
  );
}
