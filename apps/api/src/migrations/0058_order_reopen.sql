-- A received order can go back to partly received (#426): units returned to the supplier as damaged
-- or the wrong item are awaited again, so a replacement is received against the same order. The
-- trigger is the one of 0053 with that one move added.
CREATE OR REPLACE FUNCTION purchase_orders_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.number <> OLD.number
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'An order''s hospital and identity cannot be changed' USING ERRCODE = '42501';
  END IF;
  -- What is ordered, from whom and for where changes while it is a draft only.
  IF OLD.status <> 'draft' AND (NEW.supplier_id <> OLD.supplier_id OR NEW.location_id <> OLD.location_id
     OR NEW.note IS DISTINCT FROM OLD.note OR NEW.edited_by <> OLD.edited_by) THEN
    RAISE EXCEPTION 'A submitted order is not edited' USING ERRCODE = '42501';
  END IF;
  -- Who submitted, approved or ended it, and why, never change once recorded.
  IF (OLD.submitted_by IS NOT NULL AND (NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
        OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at))
     OR (OLD.approved_by IS NOT NULL AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by
        OR NEW.approved_at IS DISTINCT FROM OLD.approved_at))
     OR (OLD.ended_by IS NOT NULL AND (NEW.ended_by IS DISTINCT FROM OLD.ended_by
        OR NEW.ended_at IS DISTINCT FROM OLD.ended_at OR NEW.end_note IS DISTINCT FROM OLD.end_note)) THEN
    RAISE EXCEPTION 'Who moved an order on never changes' USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('submitted', 'cancelled'))
    OR (OLD.status = 'submitted' AND NEW.status IN ('approved', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('partly_received', 'received', 'cancelled'))
    OR (OLD.status = 'partly_received' AND NEW.status IN ('received', 'closed'))
    OR (OLD.status = 'received' AND NEW.status = 'partly_received')
  ) THEN
    RAISE EXCEPTION 'An order cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;
