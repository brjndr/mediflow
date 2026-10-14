import type { components } from '@mediflow/contract';

/** Records of one kind loaded from a file (`tenantId`). Counts and codes, never a value of a row. */
export type ImportBatch = components['schemas']['ImportBatch'];
export type ImportBatchPage = components['schemas']['ImportBatchPage'];
export type ImportBatchStatus = ImportBatch['status'];
export type ImportKind = components['schemas']['ImportKind'];
export type ImportColumn = components['schemas']['ImportColumn'];
export type ImportProblem = components['schemas']['ImportProblem'];
export type ImportProblemPage = components['schemas']['ImportProblemPage'];
