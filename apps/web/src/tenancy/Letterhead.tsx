import { useState } from 'react';
import { safeLogoUrl } from './logo-url';
import { useTenant } from './tenant-context';

/**
 * The hospital's letterhead for a printed document: its logo, when it has one that may be
 * loaded, beside its name, both from the tenant config. Never a name written in code.
 */
export function Letterhead() {
  const tenant = useTenant();
  const logoUrl = safeLogoUrl(tenant?.theme.logoUrl);
  const [failedUrl, setFailedUrl] = useState<string>();
  if (!tenant) return null;
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
      <p className="text-xl font-semibold">{tenant.name}</p>
    </header>
  );
}
