import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

/** Shared frame of the example pages: a heading and a way back to the index. */
export function ExamplePage({ heading, children }: { heading: string; children: ReactNode }) {
  const { t } = useTranslation('ui_examples');
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6">
      <Link to="/examples" className="text-sm text-primary underline-offset-4 hover:underline">
        {t('back')}
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
      {children}
    </div>
  );
}
