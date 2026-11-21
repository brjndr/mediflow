-- More deep link kinds (#1114): the records an administrator follows from the audit log. Each gets
-- a function that answers only which hospital owns an id, as patient_link_owner does (0155).

GRANT SELECT (id, tenant_id) ON invoices TO mediflow_link;
CREATE FUNCTION invoice_link_owner(record uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT r.tenant_id FROM invoices r WHERE r.id = record $$;
ALTER FUNCTION invoice_link_owner(uuid) OWNER TO mediflow_link;
REVOKE EXECUTE ON FUNCTION invoice_link_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invoice_link_owner(uuid) TO mediflow_auth;

GRANT SELECT (id, tenant_id) ON encounters TO mediflow_link;
CREATE FUNCTION encounter_link_owner(record uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT r.tenant_id FROM encounters r WHERE r.id = record $$;
ALTER FUNCTION encounter_link_owner(uuid) OWNER TO mediflow_link;
REVOKE EXECUTE ON FUNCTION encounter_link_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION encounter_link_owner(uuid) TO mediflow_auth;

GRANT SELECT (id, tenant_id) ON appointments TO mediflow_link;
CREATE FUNCTION appointment_link_owner(record uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT r.tenant_id FROM appointments r WHERE r.id = record $$;
ALTER FUNCTION appointment_link_owner(uuid) OWNER TO mediflow_link;
REVOKE EXECUTE ON FUNCTION appointment_link_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION appointment_link_owner(uuid) TO mediflow_auth;

GRANT SELECT (id, tenant_id) ON admissions TO mediflow_link;
CREATE FUNCTION admission_link_owner(record uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT r.tenant_id FROM admissions r WHERE r.id = record $$;
ALTER FUNCTION admission_link_owner(uuid) OWNER TO mediflow_link;
REVOKE EXECUTE ON FUNCTION admission_link_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admission_link_owner(uuid) TO mediflow_auth;

GRANT SELECT (id, tenant_id) ON claims TO mediflow_link;
CREATE FUNCTION claim_link_owner(record uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT r.tenant_id FROM claims r WHERE r.id = record $$;
ALTER FUNCTION claim_link_owner(uuid) OWNER TO mediflow_link;
REVOKE EXECUTE ON FUNCTION claim_link_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_link_owner(uuid) TO mediflow_auth;

GRANT SELECT (id, tenant_id) ON er_encounters TO mediflow_link;
CREATE FUNCTION er_case_link_owner(record uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT r.tenant_id FROM er_encounters r WHERE r.id = record $$;
ALTER FUNCTION er_case_link_owner(uuid) OWNER TO mediflow_link;
REVOKE EXECUTE ON FUNCTION er_case_link_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION er_case_link_owner(uuid) TO mediflow_auth;
