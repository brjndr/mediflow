-- #557: a patient record that was merged into another takes no new rows in any module. One trigger
-- function is attached to every table that has a patient_id column; it raises SQLSTATE PM409,
-- which the API answers as 409 patient_merged. Updates are left alone (a merge moves rows itself),
-- and the guard also covers the `patients`-owning tables added later through the test in
-- patient-merge-guard.test.ts, which fails for a table with patient_id and no trigger.
CREATE FUNCTION refuse_row_for_merged_patient() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.patient_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM patients p
    WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.patient_id AND p.merged_into_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'This patient record was merged into another' USING ERRCODE = 'PM409';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_schema = c.table_schema
      AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'patient_id'
      AND EXISTS (SELECT 1 FROM information_schema.columns k
                  WHERE k.table_schema = 'public' AND k.table_name = c.table_name
                    AND k.column_name = 'tenant_id')
      AND c.table_name NOT IN ('patient_merges', 'patient_documents', 'document_legal_holds')
  LOOP
    EXECUTE format(
      'CREATE TRIGGER refuse_merged_patient BEFORE INSERT ON %I
       FOR EACH ROW EXECUTE FUNCTION refuse_row_for_merged_patient()', t.table_name);
  END LOOP;
END $$;
