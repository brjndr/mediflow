-- #986: a fulfilled request for a copy of a record may carry a fee. The service, the visit it is
-- charged to and the number of copies are fixed when the request is closed; billing listens to
-- `record.request_closed` and posts the charge. Additive; nothing existing changes.
ALTER TABLE record_requests
  ADD COLUMN fee_service_id uuid,
  ADD COLUMN fee_encounter_id uuid,
  ADD COLUMN fee_copies integer CHECK (fee_copies BETWEEN 1 AND 500),
  ADD CONSTRAINT record_requests_fee_service_fk FOREIGN KEY (tenant_id, fee_service_id)
    REFERENCES services (tenant_id, id),
  ADD CONSTRAINT record_requests_fee_encounter_fk FOREIGN KEY (tenant_id, fee_encounter_id)
    REFERENCES encounters (tenant_id, id),
  ADD CONSTRAINT record_requests_fee CHECK (
    (fee_service_id IS NULL AND fee_encounter_id IS NULL AND fee_copies IS NULL)
    OR (fee_service_id IS NOT NULL AND fee_encounter_id IS NOT NULL AND fee_copies IS NOT NULL
        AND state = 'fulfilled')
  );
GRANT UPDATE (fee_service_id, fee_encounter_id, fee_copies) ON record_requests TO mediflow_app;
