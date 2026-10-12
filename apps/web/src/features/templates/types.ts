import type { components } from '@mediflow/contract';
import type { RichTextDocument } from '@/shared/ui/rich-text';

type Schemas = components['schemas'];

/** A document template of a hospital (`tenantId`): a blank form, with no patient data in it. */
export type Template = Schemas['Template'];
export type TemplatePage = Schemas['TemplatePage'];
export type TemplateVersionInfo = Schemas['TemplateVersionInfo'];
/** The text is the app's rich text document, reduced to its allowlist where it enters the app. */
export type TemplateDetail = Omit<Schemas['TemplateDetail'], 'body'> & { body: RichTextDocument };
export type TemplateVersion = Omit<Schemas['TemplateVersion'], 'body'> & { body: RichTextDocument };
