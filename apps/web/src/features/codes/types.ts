import type { components } from '@mediflow/contract';

/**
 * A diagnosis or procedure code. Reference data shared by every hospital, so it has no
 * `tenantId`; `favourite` is the active hospital's own mark.
 */
export type Code = components['schemas']['Code'];
export type CodePage = components['schemas']['CodePage'];
export type CodeSystem = Code['system'];
