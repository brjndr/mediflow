-- Deep links on the API (#1089): `POST /session/open-link` finds which hospital owns a record from
-- its globally unique id, before the session is at that hospital.
--
-- Authentication runs as `mediflow_auth`, which has no grant on hospital data. Each linkable kind
-- gets one function that answers only "which hospital owns this id", owned by a role that bypasses
-- row-level security and can read nothing of the record but its id and hospital, as patient search
-- (0114) and the audit seals (0154) do. Only the auth role may run them. A new kind is a function
-- here and `app.links.register(kind, function)` in its feature.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mediflow_link') THEN
    CREATE ROLE mediflow_link NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
GRANT mediflow_link TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO mediflow_link;
GRANT SELECT (id, tenant_id) ON patients TO mediflow_link;

-- The hospital of a patient, or nothing.
CREATE FUNCTION patient_link_owner(record uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT p.tenant_id FROM patients p WHERE p.id = record $$;

ALTER FUNCTION patient_link_owner(uuid) OWNER TO mediflow_link;
REVOKE EXECUTE ON FUNCTION patient_link_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION patient_link_owner(uuid) TO mediflow_auth;
