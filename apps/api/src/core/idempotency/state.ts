import type { FastifyRequest } from 'fastify';

/** Requests whose key is claimed and whose response is still to be stored (see plugin.ts). */
export const claimed = new WeakMap<FastifyRequest, { key: string; userId: string }>();

/** Requests answered from a stored result: the work was not done again, so it is not audited. */
export const replayed = new WeakSet<FastifyRequest>();
