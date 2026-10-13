import { api, requireData } from '@/shared/api';
import type { RichTextDocument } from '@/shared/ui/rich-text';
import type { TemplateKind } from './placeholders';
import { templateDetailSchema, templatePageSchema, templateVersionSchema } from './schemas';
import type { RedactionReason, TemplateDetail, TemplatePage, TemplateVersion } from './types';

export interface TemplateFilters {
  kind: TemplateKind | '';
  archived: boolean;
}

// The contract describes the text as an open object; the app's document type is what is sent.
const asBody = (document: RichTextDocument) => document as unknown as Record<string, unknown>;

export async function fetchTemplates(
  { kind, archived, cursor, limit }: TemplateFilters & { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<TemplatePage> {
  const result = await api.GET('/templates', {
    params: { query: { kind: kind || undefined, archived, cursor, limit } },
    signal,
  });
  return templatePageSchema.parse(requireData(result));
}

export async function fetchTemplate(
  templateId: string,
  signal?: AbortSignal,
): Promise<TemplateDetail> {
  const result = await api.GET('/templates/{templateId}', {
    params: { path: { templateId } },
    signal,
  });
  return templateDetailSchema.parse(requireData(result));
}

/** One version as it was saved: versions are never changed. */
export async function fetchTemplateVersion(
  templateId: string,
  version: number,
  signal?: AbortSignal,
): Promise<TemplateVersion> {
  const result = await api.GET('/templates/{templateId}/versions/{version}', {
    params: { path: { templateId, version } },
    signal,
  });
  return templateVersionSchema.parse(requireData(result));
}

export async function createTemplate(
  template: { kind: TemplateKind; name: string; body: RichTextDocument },
  idempotencyKey: string,
): Promise<TemplateDetail> {
  const result = await api.POST('/templates', {
    body: { ...template, body: asBody(template.body) },
    params: { header: { 'idempotency-key': idempotencyKey } },
  });
  return templateDetailSchema.parse(requireData(result));
}

/** Saves a new version: the name, the text, or both, from the version that was on screen. */
export async function saveTemplate(
  templateId: string,
  change: { name?: string; body?: RichTextDocument; expectedVersion: number },
): Promise<TemplateDetail> {
  const { body, ...rest } = change;
  const result = await api.PUT('/templates/{templateId}', {
    params: { path: { templateId } },
    body: { ...rest, ...(body ? { body: asBody(body) } : {}) },
  });
  return templateDetailSchema.parse(requireData(result));
}

/**
 * Removes the name and the text of one older version, for good. The reason is from a list, so
 * that it cannot repeat what is being removed.
 */
export async function redactTemplateVersion(
  templateId: string,
  version: number,
  reason: RedactionReason,
): Promise<TemplateDetail> {
  const result = await api.POST('/templates/{templateId}/versions/{version}/redact', {
    params: { path: { templateId, version } },
    body: { reason },
  });
  return templateDetailSchema.parse(requireData(result));
}

export async function setTemplateArchived(
  templateId: string,
  archived: boolean,
): Promise<TemplateDetail> {
  const params = { path: { templateId } };
  const result = archived
    ? await api.POST('/templates/{templateId}/archive', { params })
    : await api.POST('/templates/{templateId}/restore', { params });
  return templateDetailSchema.parse(requireData(result));
}
