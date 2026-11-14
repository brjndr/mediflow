-- Blood bank: transfusion reactions (#585, part B).
--
-- * A reaction is reported against one blood unit that was issued or transfused, for the patient it
--   was given to. It is insert-only; what happens afterwards is a row in transfusion_reaction_updates
--   (also insert-only), which may raise the severity but never lower it (checked by the API).
-- * Recording a severe or hemolytic reaction holds the unit's sibling units (same collection) by
--   discarding them; that is done by the API in the same transaction, through the unit's own guard.

CREATE TABLE transfusion_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  blood_unit_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  encounter_id uuid,
  transfused_at timestamptz NOT NULL,
  onset_at timestamptz NOT NULL,
  severity text NOT NULL CHECK (severity IN ('mild', 'moderate', 'severe')),
  kind text NOT NULL CHECK (kind IN ('febrile', 'allergic', 'hemolytic', 'trali', 'taco', 'other')),
  actions text NOT NULL CHECK (char_length(actions) BETWEEN 1 AND 2000),
  reported_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transfusion_reactions_onset CHECK (onset_at >= transfused_at),
  CONSTRAINT transfusion_reactions_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT transfusion_reactions_unit FOREIGN KEY (tenant_id, blood_unit_id)
    REFERENCES blood_units (tenant_id, id),
  CONSTRAINT transfusion_reactions_patient FOREIGN KEY (tenant_id, patient_id)
    REFERENCES patients (tenant_id, id),
  CONSTRAINT transfusion_reactions_encounter FOREIGN KEY (tenant_id, encounter_id)
    REFERENCES encounters (tenant_id, id)
);
CREATE INDEX transfusion_reactions_listing ON transfusion_reactions (tenant_id, created_at DESC, id DESC);
CREATE INDEX transfusion_reactions_unit_idx ON transfusion_reactions (tenant_id, blood_unit_id);
CREATE INDEX transfusion_reactions_patient_idx ON transfusion_reactions (tenant_id, patient_id);
SELECT enable_tenant_rls('transfusion_reactions', 'SELECT, INSERT');

CREATE TABLE transfusion_reaction_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  reaction_id uuid NOT NULL,
  note text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 2000),
  severity text CHECK (severity IN ('mild', 'moderate', 'severe')),
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transfusion_reaction_updates_reaction FOREIGN KEY (tenant_id, reaction_id)
    REFERENCES transfusion_reactions (tenant_id, id)
);
CREATE INDEX transfusion_reaction_updates_idx
  ON transfusion_reaction_updates (tenant_id, reaction_id, recorded_at, id);
SELECT enable_tenant_rls('transfusion_reaction_updates', 'SELECT, INSERT');

-- A patient record that was merged into another takes no new rows here either (#557).
CREATE TRIGGER refuse_merged_patient BEFORE INSERT ON transfusion_reactions
  FOR EACH ROW EXECUTE FUNCTION refuse_row_for_merged_patient();
