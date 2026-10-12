import { z } from 'zod';
import type {
  Bed,
  BedCategory,
  BedCategoryPage,
  Room,
  Ward,
  WardCreate,
  WardDetail,
  WardPage,
} from './types';

export const BED_STATUSES = ['available', 'occupied', 'cleaning', 'blocked'] as const;
/** Why a bed is out of use: a list, so that nothing about a patient is written as the reason. */
export const BLOCK_REASONS = [
  'repair',
  'maintenance',
  'deep_cleaning',
  'reserved',
  'other',
] as const;

/** Responses are validated where they enter the app, so screens can trust their shape. */
export const bedCategorySchema: z.ZodType<BedCategory> = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  serviceId: z.string().optional(),
  serviceName: z.string().optional(),
  bedCount: z.number().int().min(0),
  archived: z.boolean(),
  version: z.number().int().min(1),
});

export const bedCategoryPageSchema: z.ZodType<BedCategoryPage> = z.object({
  items: z.array(bedCategorySchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const wardSchema: z.ZodType<Ward> = z.object({
  id: z.string(),
  tenantId: z.string(),
  code: z.string(),
  name: z.string(),
  floor: z.string().optional(),
  departmentId: z.string().optional(),
  departmentName: z.string().optional(),
  roomCount: z.number().int().min(0),
  bedCount: z.number().int().min(0),
  archived: z.boolean(),
  version: z.number().int().min(1),
});

export const wardPageSchema: z.ZodType<WardPage> = z.object({
  items: z.array(wardSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

const bedSchema: z.ZodType<Bed> = z.object({
  id: z.string(),
  roomId: z.string(),
  number: z.string(),
  bedCategoryId: z.string(),
  bedCategoryName: z.string(),
  status: z.enum(BED_STATUSES),
  blockedReason: z.enum(BLOCK_REASONS).optional(),
  blockedNote: z.string().optional(),
  archived: z.boolean(),
  version: z.number().int().min(1),
});

const roomSchema: z.ZodType<Room> = z.object({
  id: z.string(),
  name: z.string(),
  beds: z.array(bedSchema),
  archived: z.boolean(),
  version: z.number().int().min(1),
});

export const wardDetailSchema: z.ZodType<WardDetail> = z.object({
  ward: wardSchema,
  rooms: z.array(roomSchema),
});

export const NAME_MAX = 100;
export const CODE_MAX = 20;
export const FLOOR_MAX = 50;
export const ROOM_NAME_MAX = 50;
export const BED_NUMBER_MAX = 20;
export const NOTE_MAX = 100;

/** The ward form. Messages are translation keys in core `common`. */
export const wardFormSchema = z.object({
  name: z.string().trim().min(1, 'validation.required').max(NAME_MAX),
  floor: z.string().trim().max(FLOOR_MAX),
  departmentId: z.string(),
});
export type WardFormValues = z.infer<typeof wardFormSchema>;
export type WardField = keyof WardFormValues;

/** The form for a new ward: the same, with the code it will be known by. */
export const wardCreateFormSchema = wardFormSchema.extend({
  code: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(CODE_MAX)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'validation.invalid_format'),
});
export type WardCreateFormValues = z.infer<typeof wardCreateFormSchema>;

export const toWardFormValues = (ward?: Ward): WardFormValues => ({
  name: ward?.name ?? '',
  floor: ward?.floor ?? '',
  departmentId: ward?.departmentId ?? '',
});

/** A new ward as the API takes it: an optional field that was left empty is left out. */
export function toWardCreate(values: WardCreateFormValues): WardCreate {
  return {
    code: values.code,
    name: values.name,
    ...(values.floor ? { floor: values.floor } : {}),
    ...(values.departmentId ? { departmentId: values.departmentId } : {}),
  };
}

export const bedCategoryFormSchema = z.object({
  name: z.string().trim().min(1, 'validation.required').max(NAME_MAX),
  serviceId: z.string(),
});
export type BedCategoryFormValues = z.infer<typeof bedCategoryFormSchema>;

export const roomFormSchema = z.object({
  name: z.string().trim().min(1, 'validation.required').max(ROOM_NAME_MAX),
});
export type RoomFormValues = z.infer<typeof roomFormSchema>;

export const bedFormSchema = z.object({
  number: z.string().trim().min(1, 'validation.required').max(BED_NUMBER_MAX),
  bedCategoryId: z.string().min(1, 'validation.required'),
});
export type BedFormValues = z.infer<typeof bedFormSchema>;

export const blockFormSchema = z.object({
  reason: z.enum(BLOCK_REASONS, 'validation.required'),
  note: z.string().trim().max(NOTE_MAX),
});
export type BlockFormValues = z.infer<typeof blockFormSchema>;
