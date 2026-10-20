import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { safeLogoUrl } from './logo-url';
import { useTenant } from './tenant-context';

/**
 * The hospital's letterhead for a printed document: its logo, when it has one that may be
 * loaded, beside its name, then its address, phone and registration number when the tenant
 * config has them. Never a name written in code. A document that needs a missing one says so
 * itself.
 */
export function Letterhead() {
  const { t } = useTranslation();
  const tenant = useTenant();
  const logoUrl = safeLogoUrl(tenant?.theme.logoUrl);
  const [failedUrl, setFailedUrl] = useState<string>();
  if (!tenant) return null;
  const contact = [
    tenant.phone && t('tenancy.letterheadPhone', { phone: tenant.phone }),
    tenant.registrationNumber &&
      t('tenancy.letterheadRegistration', { number: tenant.registrationNumber }),
  ].filter(Boolean);
  return (
    <header className="mb-6 flex items-center gap-4 border-b border-black pb-3">
      {logoUrl && failedUrl !== logoUrl && (
        // The name is beside it, so the logo says nothing more.
        <img
          src={logoUrl}
          alt=""
          className="h-14 w-auto max-w-48 object-contain"
          onError={() => setFailedUrl(logoUrl)}
        />
      )}
      <div>
        <p className="text-xl font-semibold">{tenant.name}</p>
        {tenant.address && <p className="whitespace-pre-line text-sm">{tenant.address}</p>}
        {contact.length > 0 && <p className="text-sm">{contact.join(' · ')}</p>}
      </div>
    </header>
  );
}
