import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { RingGauge } from '@/shared/ui/ring-gauge';
import { SearchInput } from '@/shared/ui/search-input';
import { StatusBadge, type StatusTone } from '@/shared/ui/status-badge';
import { Switch } from '@/shared/ui/switch';
import { ExamplePage } from '../components/ExamplePage';

const TONES: StatusTone[] = ['success', 'warning', 'danger', 'info', 'neutral'];

export default function VisualExample() {
  const { t } = useTranslation('ui_examples');
  const [on, setOn] = useState(true);
  const [search, setSearch] = useState('');
  return (
    <ExamplePage heading={t('visual.heading')}>
      <p className="text-muted-foreground">{t('visual.intro')}</p>
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>{t('visual.soft')}</Card>
        <Card variant="raised">{t('visual.raised')}</Card>
        <Card variant="brand">{t('visual.brand')}</Card>
      </div>
      <div className="flex flex-wrap gap-2">
        {TONES.map((tone) => (
          <StatusBadge key={tone} tone={tone} label={t(`visual.tones.${tone}`)} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-6">
        <label className="flex items-center gap-3 text-sm font-medium">
          <Switch checked={on} onCheckedChange={setOn} />
          {t('visual.switch')}
        </label>
        <RingGauge value={72} tone="success" label={t('visual.gauge')} />
        <Button variant="brand">{t('visual.button')}</Button>
      </div>
      <label className="flex max-w-sm flex-col gap-1 text-sm font-medium">
        {t('visual.search')}
        <SearchInput
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('visual.searchPlaceholder')}
        />
      </label>
    </ExamplePage>
  );
}
