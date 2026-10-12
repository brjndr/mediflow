import type { components } from '@mediflow/contract';

/** Something the hospital can charge for, of one hospital (`tenantId`). No patient data. */
export type Service = components['schemas']['Service'];
export type ServicePage = components['schemas']['ServicePage'];
export type ServiceCreate = components['schemas']['ServiceCreate'];
export type ServiceUpdate = components['schemas']['ServiceUpdate'];
export type ServiceCategory = Service['category'];
export type TaxClass = Service['taxClass'];
/** What a service costs on one price list from one date. Never edited once made. */
export type ServicePrice = components['schemas']['ServicePrice'];
export type ServicePricePage = components['schemas']['ServicePricePage'];
export type ServicePriceCreate = components['schemas']['ServicePriceCreate'];
