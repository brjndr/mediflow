import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { ServiceSearch, type ServiceOption } from '@/features/services';
import { focusIfLost } from '@/shared/lib/focus';
import { cn } from '@/shared/lib/utils';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useAddCharge } from '../hooks/use-billing';
import { refusalText } from '../lib/panel-helpers';
import {
  chargeQuantitySchema,
  type ChargeQuantityInput,
  type ChargeQuantityValues,
} from '../schemas';

/** Refusals of the API that have words of their own; any other failure gets the generic ones. */
const REFUSALS = new Set([
  'service_archived',
  'no_price',
  'service_not_found',
  'encounter_cancelled',
]);

const EMPTY: ChargeQuantityInput = { quantity: '1' };

/**
 * Charges a service of the price catalog to the visit (#115), for `charge:create`. Only the
 * service and how many are sent: the server posts it to the charge ledger at the price list's
 * price in effect, and it then shows among the pending charges like any other. `onAdded` is given
 * the new charge's id so the bill can take it.
 */
export function AddChargePanel({
  encounterId,
  onAdded,
}: {
  encounterId: string;
  onAdded: (chargeId: string) => void;
}) {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  // The API asks for both: charging, and reading the charge it answers with.
  const canCharge = usePermission('charge:create');
  const canRead = usePermission('charge:read');
  const allowed = canCharge && canRead;
  const add = useAddCharge(encounterId);
  const form = useZodForm<ChargeQuantityInput, ChargeQuantityValues>(chargeQuantitySchema, EMPTY);
  const [service, setService] = useState<ServiceOption | null>(null);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const status = useRef<HTMLParagraphElement>(null);

  if (!allowed) return null;

  async function submit(values: ChargeQuantityValues) {
    if (!service) {
      setMessage({ text: t('addCharge.chooseService'), failed: true });
      focusIfLost(status.current);
      return;
    }
    try {
      const charge = await add.mutateAsync({
        serviceId: service.id,
        quantity: Number(values.quantity),
      });
      onAdded(charge.id);
      setMessage({ text: t('addCharge.added', { name: charge.description }), failed: false });
      setService(null);
      form.reset(EMPTY);
    } catch (error) {
      setMessage({
        text: refusalText(error, REFUSALS, 'addCharge', t, tCommon),
        failed: true,
      });
    }
  }

  return (
    <section aria-labelledby="add-charge-heading" className="flex flex-col gap-3">
      <h2 id="add-charge-heading" className="text-lg font-semibold">
        {t('addCharge.heading')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('addCharge.description')}</p>
      <ServiceSearch
        label={t('addCharge.service')}
        onSelect={(chosen) => {
          setService(chosen);
          setMessage(null);
        }}
      />
      {service && (
        <p className="text-sm font-medium" data-testid="chosen-service">
          {t('addCharge.chosen', { name: service.name })}
        </p>
      )}
      <Form form={form} onSubmit={submit}>
        <TextField<ChargeQuantityInput>
          name="quantity"
          label={t('addCharge.quantity')}
          required
          inputMode="numeric"
          autoComplete="off"
        />
        <div>
          <SubmitButton variant="outline" pending={add.isPending}>
            {add.isPending ? t('addCharge.saving') : t('addCharge.submit')}
          </SubmitButton>
        </div>
      </Form>
      {/* Always on the page, so an added or refused charge is announced. */}
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
