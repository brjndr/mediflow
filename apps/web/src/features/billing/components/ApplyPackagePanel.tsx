import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { ServiceSearch, type ServiceOption } from '@/features/services';
import { focusIfLost } from '@/shared/lib/focus';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { useApplyPackage } from '../hooks/use-billing';
import { refusalText } from '../lib/panel-helpers';

/** Refusals of the API that have words of their own; any other failure gets the generic ones. */
const REFUSALS = new Set([
  'service_archived',
  'no_price',
  'service_not_found',
  'not_a_package',
  'package_empty',
  'package_applied',
  'encounter_cancelled',
]);

/**
 * Applies a package of the price catalog to the visit (#117), for `charge:create`. Only the
 * package is sent: the server posts one charge at its price in effect, and voids the visit's
 * pending charges for what the package includes (and covers any posted later). `onAdded` is given
 * the package charge's id so the bill being built takes it.
 */
export function ApplyPackagePanel({
  encounterId,
  onAdded,
}: {
  encounterId: string;
  onAdded: (chargeId: string) => void;
}) {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const canCharge = usePermission('charge:create');
  const canRead = usePermission('charge:read');
  const apply = useApplyPackage(encounterId);
  const [chosen, setChosen] = useState<ServiceOption | null>(null);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const status = useRef<HTMLParagraphElement>(null);

  if (!canCharge || !canRead) return null;

  async function submit() {
    if (!chosen) {
      setMessage({ text: t('package.chooseOne'), failed: true });
      focusIfLost(status.current);
      return;
    }
    try {
      const charge = await apply.mutateAsync({ serviceId: chosen.id });
      onAdded(charge.id);
      setMessage({ text: t('package.applied', { name: charge.description }), failed: false });
      setChosen(null);
    } catch (error) {
      setMessage({
        text: refusalText(error, REFUSALS, 'package', t, tCommon),
        failed: true,
      });
    }
  }

  return (
    <section aria-labelledby="apply-package-heading" className="flex flex-col gap-3">
      <h2 id="apply-package-heading" className="text-lg font-semibold">
        {t('package.heading')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('package.description')}</p>
      <ServiceSearch
        category="package"
        label={t('package.search')}
        onSelect={(service) => {
          setChosen(service);
          setMessage(null);
        }}
      />
      {chosen && (
        <p className="text-sm font-medium" data-testid="chosen-package">
          {t('package.chosen', { name: chosen.name })}
        </p>
      )}
      <div>
        <Button
          type="button"
          variant="outline"
          aria-disabled={apply.isPending}
          onClick={() => {
            if (!apply.isPending) void submit();
          }}
        >
          {apply.isPending ? t('package.applying') : t('package.submit')}
        </Button>
      </div>
      {/* Always on the page, so an applied or refused package is announced. */}
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className={cn(
          'text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 empty:hidden',
          message?.failed && 'text-destructive',
        )}
      >
        {message?.text}
      </p>
    </section>
  );
}
