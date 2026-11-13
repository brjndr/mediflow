import type { TFunction } from 'i18next';
import { STANDARD_FIELDS } from './schemas';
import type { CertificateField, CertificateKind } from './types';

/** Whether the screen has a label for this field of the kind (a field the hospital added has none). */
export function hasStandardLabel(kind: CertificateKind, name: string): boolean {
  return STANDARD_FIELDS[kind].some((field) => field.name === name);
}

const STANDARD_CHOICES = new Set(
  Object.values(STANDARD_FIELDS).flatMap((fields) =>
    fields.flatMap((field) => (field.options ?? []).map((value) => `${field.name}.${value}`)),
  ),
);

/**
 * What a field is called: the hospital's own label, or the standard one in the user's language.
 * A field the hospital added always has its own label, so its name is only a last resort.
 */
export function fieldLabel(t: TFunction, kind: CertificateKind, field: CertificateField): string {
  if (field.label) return field.label;
  return hasStandardLabel(kind, field.name)
    ? t(`certificate.field.${kind}.${field.name}`)
    : field.name;
}

/** A choice of a select field: the standard word where there is one, otherwise as typed. */
export function optionLabel(t: TFunction, field: CertificateField, value: string): string {
  return STANDARD_CHOICES.has(`${field.name}.${value}`)
    ? t(`certificate.option.${field.name}.${value}`)
    : value;
}
