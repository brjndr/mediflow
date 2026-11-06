import type { components } from '@mediflow/contract';

/** A medicine or a consumable the hospital keeps (`tenantId`). What it is, not its stock or price. */
export type Drug = components['schemas']['Drug'];
export type DrugPage = components['schemas']['DrugPage'];
export type DrugCreate = components['schemas']['DrugCreate'];
export type DrugUpdate = components['schemas']['DrugUpdate'];
export type DrugType = Drug['type'];
export type DrugForm = Drug['form'];
export type DrugSchedule = Drug['schedule'];

/** A medicine a doctor starred, as the prescription sets API names it (#394). */
export type FavouriteDrug = components['schemas']['FavouriteDrug'];
export type FavouriteDrugs = components['schemas']['FavouriteDrugs'];
