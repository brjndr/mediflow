-- #589: a trip may name the visit it is for and the priced service it is charged as. Billing posts
-- the charge when the trip is completed (it listens to `ambulance.trip_status_changed`). Both are
-- fixed when the trip is requested (the guard trigger lets nothing else change). Additive.
ALTER TABLE ambulance_trips
  ADD COLUMN encounter_id uuid,
  ADD COLUMN service_id uuid,
  ADD CONSTRAINT ambulance_trips_encounter_fk FOREIGN KEY (tenant_id, encounter_id)
    REFERENCES encounters (tenant_id, id),
  ADD CONSTRAINT ambulance_trips_service_fk FOREIGN KEY (tenant_id, service_id)
    REFERENCES services (tenant_id, id),
  ADD CONSTRAINT ambulance_trips_charge CHECK (
    service_id IS NULL OR (encounter_id IS NOT NULL AND patient_id IS NOT NULL)
  );
