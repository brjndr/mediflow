import type { components } from '@mediflow/contract';

type Schemas = components['schemas'];

/** A class of bed, which decides what a day in it is charged as (`tenantId`). */
export type BedCategory = Schemas['BedCategory'];
export type BedCategoryPage = Schemas['BedCategoryPage'];
export type BedCategoryCreate = Schemas['BedCategoryCreate'];
export type BedCategoryUpdate = Schemas['BedCategoryUpdate'];
/** A ward of the hospital (`tenantId`). Rooms and beds belong to their ward. */
export type Ward = Schemas['Ward'];
export type WardPage = Schemas['WardPage'];
export type WardCreate = Schemas['WardCreate'];
export type WardUpdate = Schemas['WardUpdate'];
/** A ward with its rooms and their beds. */
export type WardDetail = Schemas['WardDetail'];
export type Room = Schemas['Room'];
/** A bed and whether it can take a patient. Who is in it is never here. */
export type Bed = Schemas['Bed'];
export type BedUpdate = Schemas['BedUpdate'];
export type BedStatus = Bed['status'];
