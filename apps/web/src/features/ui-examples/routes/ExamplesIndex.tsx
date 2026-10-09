import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

const PAGES = ['grid', 'charts', 'form', 'editor'] as const;

export default function ExamplesIndex() {
  const { t } = useTranslation('ui_examples');
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('index.heading')}</h1>
        <p className="text-muted-foreground">{t('index.description')}</p>
      </div>
      <ul className="flex flex-col gap-3">
        {PAGES.map((page) => (
          <li key={page} className="rounded-lg border p-4">
            <Link
              to={`/examples/${page}`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {t(`index.${page}`)}
            </Link>
            <p className="text-sm text-muted-foreground">{t(`index.${page}Summary`)}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
