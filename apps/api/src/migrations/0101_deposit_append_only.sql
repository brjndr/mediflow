-- The deposit ledger of a stay (0097) was append-only by grants alone. A trigger now refuses
-- UPDATE and DELETE on its three tables whoever the role is, as on the other ledgers (#800).
-- Corrections are new rows. Test clean-up runs with triggers off (session_replication_role).

CREATE FUNCTION deposit_ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: corrections are new rows', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER deposits_append_only BEFORE UPDATE OR DELETE ON deposits
  FOR EACH ROW EXECUTE FUNCTION deposit_ledger_append_only();
CREATE TRIGGER deposit_applications_append_only BEFORE UPDATE OR DELETE ON deposit_applications
  FOR EACH ROW EXECUTE FUNCTION deposit_ledger_append_only();
CREATE TRIGGER deposit_refunds_append_only BEFORE UPDATE OR DELETE ON deposit_refunds
  FOR EACH ROW EXECUTE FUNCTION deposit_ledger_append_only();
