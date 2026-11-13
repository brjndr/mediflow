import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';

/**
 * What a module asks of a discharge before the stay ends (#790). A gate throws an `HttpError`
 * to refuse; it runs in the discharge request's transaction, before anything is changed, and
 * sees ids only. `acknowledged` is the caller's explicit confirmation sent with the discharge.
 */
export type DischargeGate = (
  request: FastifyRequest,
  stay: { admissionId: string; encounterId: string; patientId: string; acknowledged: boolean },
) => Promise<void>;

export interface DischargeGates {
  register(name: string, gate: DischargeGate): void;
  /** Runs every gate in the order registered; the first refusal stops the discharge. */
  check(
    request: FastifyRequest,
    stay: { admissionId: string; encounterId: string; patientId: string; acknowledged: boolean },
  ): Promise<void>;
}

declare module 'fastify' {
  interface FastifyInstance {
    dischargeGates: DischargeGates;
  }
}

/** Where a module declares a condition of discharge without admissions knowing the module. */
export const dischargeGatesPlugin = fp(
  async (app) => {
    const gates = new Map<string, DischargeGate>();
    app.decorate('dischargeGates', {
      register(name, gate) {
        if (gates.has(name)) throw new Error(`discharge_gate_twice: ${name}`);
        gates.set(name, gate);
      },
      async check(request, stay) {
        for (const gate of gates.values()) await gate(request, stay);
      },
    } satisfies DischargeGates);
  },
  { name: 'discharge-gates' },
);
