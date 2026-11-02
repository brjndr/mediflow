import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { SlotProps } from '@/registry';
import { Button } from '@/shared/ui/button';

/**
 * "Create invoice" on a consultation (`encounter.detail.actions`), given the visit's id and its
 * status. Rendered for every visit, so it reads no data: the page it opens shows the visit's
 * pending charges. The manifest offers it to roles that hold `invoice:create` and `charge:read`.
 * A cancelled visit has nothing to bill.
 */
export default function CreateInvoiceAction({ context }: SlotProps) {
  const { t } = useTranslation('billing');
  const { encounterId, status } = context ?? {};
  if (typeof encounterId !== 'string' || status === 'cancelled') return null;
  return (
    <Button asChild variant="outline">
      <Link to={`/billing/new?encounterId=${encodeURIComponent(encounterId)}`}>
        {t('action.create')}
      </Link>
    </Button>
  );
}
