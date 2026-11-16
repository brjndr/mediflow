-- Retention for account_events (#481): password changes and session revokes are kept for 2 years
-- (730 days, the floor), longer for the people of a hospital that asks for more. The decision is
-- to be confirmed against the compliance checklist (#147).

-- How long a hospital keeps the account events of its staff. A row is optional: a hospital with
-- none has the platform default (ACCOUNT_EVENTS_RETENTION_DAYS, 730 unless set higher). The app
-- role only reads it; the platform sets it (there is no screen for that yet).
CREATE TABLE account_event_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id),
  retention_days integer NOT NULL CHECK (retention_days BETWEEN 730 AND 3650),
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT enable_tenant_rls('account_event_settings', 'SELECT');

-- The sweep runs as the worker role, which reads which hospitals a user belongs to and their
-- settings, and may delete only events older than the floor. Nobody else may delete or change one.
CREATE POLICY worker_list ON account_event_settings FOR SELECT TO mediflow_worker USING (true);
GRANT SELECT ON account_event_settings TO mediflow_worker;
CREATE POLICY worker_user_tenants ON memberships FOR SELECT TO mediflow_worker USING (true);
GRANT SELECT (user_id, tenant_id) ON memberships TO mediflow_worker;

ALTER TABLE account_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY worker_expired_read ON account_events FOR SELECT TO mediflow_worker
  USING (at < now() - interval '730 days');
CREATE POLICY worker_expired_delete ON account_events FOR DELETE TO mediflow_worker
  USING (at < now() - interval '730 days');
GRANT SELECT, DELETE ON account_events TO mediflow_worker;

-- Still append-only: updates and truncation are refused for everyone, a delete only for the
-- worker role (and only of expired rows, by the policy above).
CREATE OR REPLACE FUNCTION account_events_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'mediflow_worker' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'account_events is append-only' USING ERRCODE = 'restrict_violation';
END
$$;
