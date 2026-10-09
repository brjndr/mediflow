import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { safeLogoUrl } from './logo-url';
import { useTenant } from './tenant-context';

/**
 * The hospital's logo where the product name would be, or the product name when the hospital has
 * no logo, its URL is not allowed, or the image fails to load.
 */
export function TenantBrand({ className }: { className?: string }) {
  const { t } = useTranslation();
  const tenant = useTenant();
  const logoUrl = safeLogoUrl(tenant?.theme.logoUrl);
  // Remember which URL failed, so a later hospital's logo still gets its chance.
  const [failedUrl, setFailedUrl] = useState<string>();

  if (tenant && logoUrl && failedUrl !== logoUrl) {
    return (
      <img
        src={logoUrl}
        alt={tenant.name}
        loading="lazy"
        decoding="async"
        className={cn('h-7 w-auto max-w-40 object-contain', className)}
        onError={() => setFailedUrl(logoUrl)}
      />
    );
  }
  return (
    <span className={cn('text-sm font-semibold text-primary', className)}>{t('app.name')}</span>
  );
}
