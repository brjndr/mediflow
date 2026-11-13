import type { components } from '@mediflow/contract';
import type { RichTextDocument } from '@/shared/ui/rich-text';

type Schemas = components['schemas'];

/** A consent signed for a patient (MR-02, #190). The list holds no text or signature. */
export type Consent = Schemas['Consent'];
export type ConsentPage = Schemas['ConsentPage'];
export type ConsentSigner = Schemas['ConsentSigner'];
export type ConsentSignature = Schemas['ConsentSignature'];
/** The text is the app's rich text document, reduced to its allowlist where it enters the app. */
export type ConsentDetail = Omit<Schemas['ConsentDetail'], 'body'> & { body: RichTextDocument };
export type ConsentCreate = Omit<Schemas['ConsentCreate'], 'body'> & { body: RichTextDocument };

export type Certificate = Schemas['Certificate'];
export type CertificatePage = Schemas['CertificatePage'];
export type CertificateKind = Schemas['CertificateKind'];
export type CertificateCreate = Schemas['CertificateCreate'];
/** One field of a certificate format (#567). `label` is absent on a standard field. */
export type CertificateField = Schemas['CertificateFieldDef'];
export type CertificateFieldType = CertificateField['type'];
export type CertificateFormat = Schemas['CertificateFormat'];
export type CertificateFormatUpdate = Schemas['CertificateFormatUpdate'];
