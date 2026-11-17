import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

const idOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * A payer's receipt against the payer share of a split visit (#1033). Billing records the payment
 * on the invoice the ordinary way and says `payment.recorded`, with the payer when the invoice is
 * the payer's; this module sets the money against the visit's claim, as `received_minor`.
 *
 * The claim must be decided (`approved`, or `settled` short of what was approved): it never takes
 * more than the approved amount, and a receipt on a claim not yet decided is left for the settle
 * action. A first receipt moves an approved claim to `settled` as the settle action does, so a
 * short payment leaves it settled with money outstanding, which can be written off or topped up
 * by the next receipt. `claim_receipts` holds one row per payment, so an event delivered twice
 * allocates once.
 */
export function subscribeToPayerReceipts(app: FastifyInstance): void {
  app.events.subscribe('payment.recorded', async (message, tx) => {
    const { payload } = message;
    const payerId = idOf(payload.payerId);
    const encounterId = idOf(payload.encounterId);
    const paymentId = idOf(payload.paymentId);
    const amount = payload.amountMinor;
    if (!payerId || !encounterId || !paymentId || !message.actorId) return;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) return;
    const { rows } = await tx.execute<{
      id: string;
      status: string;
      approved_minor: string | null;
      received_minor: string;
    }>(
      sql`select id, status, approved_minor, received_minor from claims
          where encounter_id = ${encounterId} and payer_id = ${payerId}
            and status in ('approved', 'settled')
          for update`,
    );
    const claim = rows[0];
    if (!claim) return;
    const room = Number(claim.approved_minor ?? 0) - Number(claim.received_minor);
    const allocated = Math.min(amount, room);
    if (allocated <= 0) return;
    const taken = await tx.execute(
      sql`insert into claim_receipts (payment_id, claim_id, amount_minor)
          values (${paymentId}, ${claim.id}, ${allocated})
          on conflict (tenant_id, payment_id) do nothing returning payment_id`,
    );
    if (taken.rows.length === 0) return;
    await tx.execute(
      sql`update claims set received_minor = received_minor + ${allocated}, status = 'settled'
          where id = ${claim.id}`,
    );
    await tx.execute(
      sql`insert into claim_events (claim_id, action, to_status, amount_minor, note, actor_id)
          values (${claim.id}, 'settle', 'settled', ${allocated}, 'Payer receipt on its invoice',
            ${message.actorId})`,
    );
    await tx.execute(
      sql`insert into outbox (tenant_id, event, entity_id, actor_id, payload)
          values (app_tenant_id(), 'claim.settled', ${claim.id}, ${message.actorId},
            ${JSON.stringify({ encounterId, payerId, receivedMinor: allocated })})`,
    );
  });
}
