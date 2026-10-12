// Public surface of the feature. Other features and core import from here only.
export { templatesFeature } from './manifest';
export {
  fillPlaceholders,
  placeholdersFor,
  type Placeholder,
  type TemplateKind,
} from './placeholders';
export type { Template, TemplateVersion } from './types';
