import { useMedicineName, type DrugForm } from '@/features/drugs';
import type { StockItemName } from '../types';

/** How an item of stock reads: as the drug master names it, with its unit when it has one. */
export function useItemName() {
  const nameOf = useMedicineName();
  return (item: StockItemName) =>
    nameOf({
      genericName: item.genericName,
      strength: item.strength,
      brandName: item.brandName,
      form: item.form as DrugForm,
    });
}
