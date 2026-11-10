import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { useEncounter } from '../hooks/use-clinical';
import { ORDER_KINDS } from '../schemas';
import { OrdersPanel } from './OrdersPanel';

/**
 * The lab, imaging and procedure orders of an encounter, for another module that works on one
 * (the emergency department's rapid orders, ER-02): the same panels as the consultation, each
 * with its own permissions, for `order:read`.
 */
export function EncounterOrders({ encounterId }: { encounterId: string }) {
  const { t: tCommon } = useTranslation();
  const canRead = usePermission('order:read');
  const encounter = useEncounter(encounterId);
  if (!canRead) return null;
  if (encounter.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {tCommon(errorMessageKey(encounter.error))}
      </p>
    );
  }
  if (!encounter.data) return null;
  const data = encounter.data;
  return (
    <div className="flex flex-col gap-8">
      {ORDER_KINDS.map((kind) => (
        <OrdersPanel key={kind} encounter={data} kind={kind} />
      ))}
    </div>
  );
}
