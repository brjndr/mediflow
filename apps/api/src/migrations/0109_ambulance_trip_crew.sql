-- The crew of an ambulance trip (#590), named when the trip is dispatched. One row per person and
-- trip, written once and never changed or removed (the table grants no update or delete), at most
-- one driver a trip. The person must be a member of the hospital. Additive.
CREATE TABLE ambulance_trip_crew (
  tenant_id uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants (id),
  trip_id uuid NOT NULL,
  user_id uuid NOT NULL,
  duty text NOT NULL CHECK (duty IN ('driver', 'paramedic', 'attendant')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, user_id),
  CONSTRAINT ambulance_trip_crew_trip FOREIGN KEY (tenant_id, trip_id)
    REFERENCES ambulance_trips (tenant_id, id),
  CONSTRAINT ambulance_trip_crew_member FOREIGN KEY (tenant_id, user_id)
    REFERENCES memberships (tenant_id, user_id)
);
CREATE UNIQUE INDEX ambulance_trip_crew_one_driver ON ambulance_trip_crew (trip_id)
  WHERE duty = 'driver';
CREATE INDEX ambulance_trip_crew_user ON ambulance_trip_crew (tenant_id, user_id);
SELECT enable_tenant_rls('ambulance_trip_crew', 'SELECT, INSERT');
