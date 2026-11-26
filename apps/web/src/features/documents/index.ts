// Public surface of the feature. Other features and core import from here only.
export { documentsFeature } from './manifest';
// The upload, for a module that attaches a file as part of its own work (#1202).
export { useUploadDocument } from './hooks/use-documents';
export { DOCUMENT_TYPES, fileProblem } from './schemas';
export { UploadRefused } from './api';
