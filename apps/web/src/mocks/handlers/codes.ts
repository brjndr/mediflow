import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';

type Code = components['schemas']['Code'];
type CodePage = components['schemas']['CodePage'];
type System = Code['system'];

const FEATURE_FLAG = 'codes';
const READ = 'code:read';
const MANAGE = 'code:manage';
const SYSTEMS: readonly System[] = ['icd10', 'procedure'];

/**
 * A sample of ICD-10, enough to search and page. The real set (some 14,000 codes) is loaded by
 * the API from the published classification, never typed in here and never bundled.
 */
const ICD10: [string, string][] = [
  ['A01.0', 'Typhoid fever'],
  ['A09', 'Infectious gastroenteritis and colitis, unspecified'],
  ['A15.0', 'Tuberculosis of lung'],
  ['A90', 'Dengue fever'],
  ['B20', 'Human immunodeficiency virus disease'],
  ['B34.9', 'Viral infection, unspecified'],
  ['B50.9', 'Plasmodium falciparum malaria, unspecified'],
  ['B54', 'Unspecified malaria'],
  ['C50.9', 'Malignant neoplasm of breast, unspecified'],
  ['C61', 'Malignant neoplasm of prostate'],
  ['D50.9', 'Iron deficiency anaemia, unspecified'],
  ['D64.9', 'Anaemia, unspecified'],
  ['E03.9', 'Hypothyroidism, unspecified'],
  ['E05.9', 'Thyrotoxicosis, unspecified'],
  ['E10.9', 'Type 1 diabetes mellitus without complications'],
  ['E11.2', 'Type 2 diabetes mellitus with kidney complications'],
  ['E11.9', 'Type 2 diabetes mellitus without complications'],
  ['E55.9', 'Vitamin D deficiency, unspecified'],
  ['E66.9', 'Obesity, unspecified'],
  ['E78.5', 'Hyperlipidaemia, unspecified'],
  ['F32.9', 'Depressive episode, unspecified'],
  ['F41.1', 'Generalized anxiety disorder'],
  ['G40.9', 'Epilepsy, unspecified'],
  ['G43.9', 'Migraine, unspecified'],
  ['H10.9', 'Conjunctivitis, unspecified'],
  ['H25.9', 'Senile cataract, unspecified'],
  ['H66.9', 'Otitis media, unspecified'],
  ['I10', 'Essential (primary) hypertension'],
  ['I20.9', 'Angina pectoris, unspecified'],
  ['I21.9', 'Acute myocardial infarction, unspecified'],
  ['I25.1', 'Atherosclerotic heart disease'],
  ['I48', 'Atrial fibrillation and flutter'],
  ['I50.9', 'Heart failure, unspecified'],
  ['I63.9', 'Cerebral infarction, unspecified'],
  ['J00', 'Acute nasopharyngitis (common cold)'],
  ['J02.9', 'Acute pharyngitis, unspecified'],
  ['J03.9', 'Acute tonsillitis, unspecified'],
  ['J06.9', 'Acute upper respiratory infection, unspecified'],
  ['J18.9', 'Pneumonia, unspecified'],
  ['J20.9', 'Acute bronchitis, unspecified'],
  ['J30.4', 'Allergic rhinitis, unspecified'],
  ['J44.9', 'Chronic obstructive pulmonary disease, unspecified'],
  ['J45.9', 'Asthma, unspecified'],
  ['K21.9', 'Gastro-oesophageal reflux disease without oesophagitis'],
  ['K29.7', 'Gastritis, unspecified'],
  ['K35.8', 'Acute appendicitis, other and unspecified'],
  ['K59.0', 'Constipation'],
  ['K80.2', 'Calculus of gallbladder without cholecystitis'],
  ['L20.9', 'Atopic dermatitis, unspecified'],
  ['L50.9', 'Urticaria, unspecified'],
  ['M17.9', 'Gonarthrosis, unspecified'],
  ['M54.5', 'Low back pain'],
  ['M79.1', 'Myalgia'],
  ['N18.9', 'Chronic kidney disease, unspecified'],
  ['N20.0', 'Calculus of kidney'],
  ['N39.0', 'Urinary tract infection, site not specified'],
  ['O80', 'Single spontaneous delivery'],
  ['R05', 'Cough'],
  ['R10.4', 'Other and unspecified abdominal pain'],
  ['R50.9', 'Fever, unspecified'],
  ['R51', 'Headache'],
  ['S52.5', 'Fracture of lower end of radius'],
  ['S82.6', 'Fracture of lateral malleolus'],
  ['T78.4', 'Allergy, unspecified'],
  ['Z00.0', 'General medical examination'],
  ['Z23', 'Need for immunization against single bacterial diseases'],
  ['Z34.9', 'Supervision of normal pregnancy, unspecified'],
];
/** Procedures, with made-up codes: the hospital's own procedure set is loaded by the API. */
const PROCEDURES = [
  'Appendicectomy',
  'Arthroscopy of knee',
  'Caesarean section',
  'Cataract extraction with lens implant',
  'Cholecystectomy, laparoscopic',
  'Circumcision',
  'Colonoscopy',
  'Coronary angiography',
  'Dilatation and curettage',
  'Excision of skin lesion',
  'Hernia repair, inguinal',
  'Hysterectomy, abdominal',
  'Incision and drainage of abscess',
  'Lumbar puncture',
  'Normal delivery with episiotomy',
  'Reduction of fracture, closed',
  'Tonsillectomy',
  'Total knee replacement',
  'Upper gastrointestinal endoscopy',
  'Wound debridement',
];

/** Enough synthetic codes after the real ones for a set that is far more than a page. */
function build(): Omit<Code, 'favourite'>[] {
  const codes: Omit<Code, 'favourite'>[] = [];
  for (const [code, title] of ICD10) {
    codes.push({
      id: `icd10_${code.replace('.', '').toLowerCase()}`,
      system: 'icd10',
      code,
      title,
    });
  }
  for (let index = 0; index < 1200; index++) {
    const code = `U${String(Math.floor(index / 10)).padStart(2, '0')}.${index % 10}`;
    codes.push({
      id: `icd10_${code.replace('.', '').toLowerCase()}x`,
      system: 'icd10',
      code: `${code}X`,
      title: `Sample condition ${String(index + 1).padStart(4, '0')}`,
    });
  }
  for (const [index, title] of PROCEDURES.entries()) {
    const code = `PR-${String(index + 1).padStart(4, '0')}`;
    codes.push({ id: `proc_${index + 1}`, system: 'procedure', code, title });
  }
  return codes;
}
// The codes never change: only the favourites are state.
const CODES = build();

/** Each hospital's favourites, by tenant. One hospital never sees another's. */
function seed(): Map<string, Set<string>> {
  return new Map([
    [TENANT_IDS.hospital, new Set(['icd10_i10', 'icd10_e119', 'icd10_j069', 'proc_3'])],
    [TENANT_IDS.clinic, new Set(['icd10_j069'])],
  ]);
}
let favourites = seed();
onMockReset(() => {
  favourites = seed();
});

const marked = (tenantId: string) => favourites.get(tenantId) ?? new Set<string>();
const view = (tenantId: string, code: Omit<Code, 'favourite'>): Code => ({
  ...code,
  favourite: marked(tenantId).has(code.id),
});
const plain = (text: string) => text.toLowerCase().replace(/\./g, '');

export const codesHandlers = [
  // A search reads data only; it is a POST so that what was typed is never in an address.
  http.post('*/api/codes/search', async ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    const system = SYSTEMS.find((value) => value === body.system);
    const typed = body.q ?? '';
    if (!system || typeof typed !== 'string' || typed.length > 100) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
    const only = body.favourites === true;
    // The favourites are the session's hospital's, whatever the request says.
    const own = marked(access.tenantId);
    const visible = CODES.filter((code) => code.system === system)
      .filter((code) => !only || own.has(code.id))
      .filter((code) => {
        const title = code.title.toLowerCase().split(/[^a-z0-9]+/);
        // Each word starts the code, with or without its dot, or a word of the title.
        return words.every(
          (word) =>
            plain(code.code).startsWith(plain(word)) || title.some((part) => part.startsWith(word)),
        );
      })
      // Favourites first, then the codes in order (they are stored in order).
      .sort((a, b) => Number(own.has(b.id)) - Number(own.has(a.id)));
    const limit = Math.min(Math.max(Number(body.limit) || 25, 1), 100);
    const cursor = typeof body.cursor === 'string' ? body.cursor : null;
    const start = cursor ? visible.findIndex((code) => code.id === cursor) : 0;
    if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    const next = visible[start + limit];
    return HttpResponse.json<CodePage>({
      items: visible.slice(start, start + limit).map((code) => view(access.tenantId, code)),
      nextCursor: next?.id ?? null,
      // With the first page only, as the contract says.
      ...(cursor ? {} : { total: visible.length }),
    });
  }),

  ...(['put', 'delete'] as const).map((method) =>
    http[method]('*/api/codes/:codeId/favourite', ({ request, params }) => {
      const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
      if ('denied' in access) return access.denied;
      const code = CODES.find((candidate) => candidate.id === params.codeId);
      if (!code) return error(404, 'code_not_found', 'No such code');
      const own = new Set(marked(access.tenantId));
      // Doing it twice is harmless, so a retried request cannot fail.
      if (method === 'put') own.add(code.id);
      else own.delete(code.id);
      favourites.set(access.tenantId, own);
      return HttpResponse.json<Code>(view(access.tenantId, code));
    }),
  ),
];
