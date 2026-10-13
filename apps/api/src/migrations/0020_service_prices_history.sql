-- Service prices, after review of 0019 (BE-17a): the database lets less happen to a price's past.

-- 0019 filled price_lists for the hospitals that existed. tenants has forced row-level security,
-- so a login that cannot see it would have added nothing and reported no error. Better to stop
-- here than to leave a hospital that can set no price.
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM tenants t
    WHERE NOT EXISTS (SELECT FROM price_lists l WHERE l.tenant_id = t.id AND l.standard)
  ) THEN
    RAISE EXCEPTION 'A hospital has no standard price list';
  END IF;
END
$$;

-- A list that has prices is not removed, because a price is history: no cascade from the list.
-- (A hospital's own lists still go with the hospital, which cannot be deleted while it has
-- services.)
ALTER TABLE service_prices DROP CONSTRAINT service_prices_price_list;
ALTER TABLE service_prices ADD CONSTRAINT service_prices_price_list
  FOREIGN KEY (tenant_id, price_list_id) REFERENCES price_lists (tenant_id, id);

-- Both orderings the queries use (newest first, then id) straight from the index.
DROP INDEX service_prices_tenant_service;
CREATE INDEX service_prices_tenant_service ON service_prices
  (tenant_id, service_id, price_list_id, effective_from DESC, id DESC);

-- 0019 let the last day of any price be set to anything. The exclusion constraint stops two
-- prices covering a day, but not a day being left with none: a period that had ended could be
-- cut short, and the price in force could be made to end last year.
CREATE OR REPLACE FUNCTION service_prices_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  today date;
BEGIN
  -- The only things that happen to a price: it gets (or loses) its last day when a later price
  -- arrives (or is withdrawn), and it is withdrawn.
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.service_id <> OLD.service_id
    OR NEW.price_list_id <> OLD.price_list_id OR NEW.amount_minor <> OLD.amount_minor
    OR NEW.effective_from <> OLD.effective_from OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A price is never edited' USING ERRCODE = '42501';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'A withdrawn price is not changed' USING ERRCODE = '42501';
  END IF;

  -- Today where the hospital is.
  SELECT (now() AT TIME ZONE timezone)::date INTO today FROM tenants WHERE id = OLD.tenant_id;
  IF today IS NULL THEN
    RAISE EXCEPTION 'A price is changed only for its own hospital' USING ERRCODE = '42501';
  END IF;
  -- A price that is or was in force is history.
  IF NEW.withdrawn_at IS NOT NULL AND OLD.effective_from <= today THEN
    RAISE EXCEPTION 'A price that is or was in force is not withdrawn' USING ERRCODE = '42501';
  END IF;
  -- The last day is given, or taken away again, for days still to come: a period that has ended
  -- stays as it was, and none is made to end in the past.
  IF NEW.effective_to IS DISTINCT FROM OLD.effective_to
    AND (OLD.effective_to < today OR NEW.effective_to < today) THEN
    RAISE EXCEPTION 'The past of a price is not rewritten' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
