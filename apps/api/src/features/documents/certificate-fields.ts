/** The kinds of certificate, and the fields each has until a hospital changes them (#567). */
export const CERTIFICATE_KINDS = ['medical', 'fitness', 'birth', 'death'] as const;
export type CertificateKind = (typeof CERTIFICATE_KINDS)[number];

export interface FieldDef {
  name: string;
  label?: string;
  type: 'text' | 'date' | 'time' | 'lines' | 'select';
  required: boolean;
  options?: string[];
}

/** The same list as the web app's `STANDARD_FIELDS`; the web screen labels them itself. */
export const STANDARD_FIELDS: Record<CertificateKind, readonly FieldDef[]> = {
  medical: [
    { name: 'diagnosis', type: 'lines', required: true },
    { name: 'restFrom', type: 'date', required: true },
    { name: 'restTo', type: 'date', required: true },
    { name: 'remarks', type: 'lines', required: false },
  ],
  fitness: [
    { name: 'purpose', type: 'text', required: true },
    { name: 'findings', type: 'lines', required: false },
    {
      name: 'outcome',
      type: 'select',
      required: true,
      options: ['fit', 'fit_with_conditions', 'unfit'],
    },
    { name: 'validUntil', type: 'date', required: false },
  ],
  birth: [
    { name: 'childName', type: 'text', required: false },
    { name: 'dateOfBirth', type: 'date', required: true },
    { name: 'timeOfBirth', type: 'time', required: false },
    { name: 'sex', type: 'select', required: true, options: ['female', 'male', 'other'] },
    { name: 'placeOfBirth', type: 'text', required: true },
    { name: 'motherName', type: 'text', required: true },
    { name: 'fatherName', type: 'text', required: false },
  ],
  death: [
    { name: 'deceasedName', type: 'text', required: true },
    { name: 'dateOfDeath', type: 'date', required: true },
    { name: 'timeOfDeath', type: 'time', required: false },
    { name: 'placeOfDeath', type: 'text', required: true },
    { name: 'causeOfDeath', type: 'lines', required: true },
    {
      name: 'manner',
      type: 'select',
      required: true,
      options: ['natural', 'accident', 'suicide', 'homicide', 'undetermined'],
    },
  ],
};
