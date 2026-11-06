-- Allergen catalog (#380): the drug classes, foods and other things a patient is commonly allergic
-- to, so that an allergy can name something the system understands.
--
-- * It is reference data shared by every hospital: it holds no patient or hospital data, so it has
--   no tenant_id and the app may only read it. Changing it is a migration. A hospital's own
--   additions, if ever wanted, are an additive table of their own.
-- * A single medicine is not stored here: it is a generic name of the hospital's own drug catalog
--   (`drugs`), found there when an allergen is searched for.
-- * `members` are the generic names a drug class covers, in lower case. A medicine belongs to the
--   class when a word of its generic name begins with a member ("amoxicillin" covers
--   "amoxicillin and clavulanic acid"). A food or other allergen covers no medicine.

CREATE TABLE allergens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 100),
  name_lower text NOT NULL GENERATED ALWAYS AS (lower(name)) STORED,
  kind text NOT NULL CHECK (kind IN ('drug_class', 'food', 'other')),
  members text[] NOT NULL DEFAULT '{}',
  CONSTRAINT allergens_members CHECK ((kind = 'drug_class') = (cardinality(members) > 0))
);

CREATE UNIQUE INDEX allergens_name ON allergens (name_lower);

GRANT SELECT ON allergens TO mediflow_app;

INSERT INTO allergens (name, kind, members) VALUES
  ('Penicillins', 'drug_class', ARRAY['penicillin', 'amoxicillin', 'ampicillin', 'cloxacillin',
    'flucloxacillin', 'dicloxacillin', 'piperacillin', 'benzathine', 'phenoxymethylpenicillin']),
  ('Cephalosporins', 'drug_class', ARRAY['cefalexin', 'cephalexin', 'cefazolin', 'cefadroxil',
    'cefuroxime', 'cefaclor', 'cefixime', 'cefpodoxime', 'cefotaxime', 'ceftriaxone',
    'ceftazidime', 'cefepime']),
  ('Sulfonamides (sulfa drugs)', 'drug_class', ARRAY['sulfamethoxazole', 'sulfadiazine',
    'sulfasalazine', 'sulfacetamide', 'co-trimoxazole', 'cotrimoxazole']),
  ('Macrolides', 'drug_class', ARRAY['erythromycin', 'azithromycin', 'clarithromycin',
    'roxithromycin']),
  ('Fluoroquinolones', 'drug_class', ARRAY['ciprofloxacin', 'levofloxacin', 'ofloxacin',
    'moxifloxacin', 'norfloxacin']),
  ('Tetracyclines', 'drug_class', ARRAY['tetracycline', 'doxycycline', 'minocycline']),
  ('Aminoglycosides', 'drug_class', ARRAY['gentamicin', 'amikacin', 'streptomycin', 'tobramycin',
    'neomycin']),
  ('NSAIDs (anti-inflammatory painkillers)', 'drug_class', ARRAY['ibuprofen', 'diclofenac',
    'naproxen', 'aspirin', 'ketorolac', 'indomethacin', 'piroxicam', 'etoricoxib', 'celecoxib',
    'nimesulide', 'mefenamic']),
  ('Opioids', 'drug_class', ARRAY['morphine', 'codeine', 'tramadol', 'fentanyl', 'pethidine',
    'oxycodone', 'tapentadol']),
  ('ACE inhibitors', 'drug_class', ARRAY['enalapril', 'lisinopril', 'ramipril', 'captopril',
    'perindopril']),
  ('Local anaesthetics', 'drug_class', ARRAY['lidocaine', 'lignocaine', 'bupivacaine',
    'procaine', 'ropivacaine']),
  ('Peanuts', 'food', '{}'),
  ('Tree nuts', 'food', '{}'),
  ('Milk', 'food', '{}'),
  ('Eggs', 'food', '{}'),
  ('Wheat (gluten)', 'food', '{}'),
  ('Soy', 'food', '{}'),
  ('Fish', 'food', '{}'),
  ('Shellfish', 'food', '{}'),
  ('Sesame', 'food', '{}'),
  ('Latex', 'other', '{}'),
  ('Iodine contrast dye', 'other', '{}'),
  ('Adhesive tape or plaster', 'other', '{}'),
  ('Bee or wasp stings', 'other', '{}'),
  ('Dust mites', 'other', '{}'),
  ('Pollen', 'other', '{}'),
  ('Animal dander', 'other', '{}');
