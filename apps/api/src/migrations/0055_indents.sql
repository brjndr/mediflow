-- Store indents and issue vouchers (#105): a ward, a department or the pharmacy counter asks a
-- store for items (an indent), someone else approves it, for fewer units when the store has to,
-- and the store issues it on one or more vouchers. What the database itself guarantees:
--
-- * Issued stock moves only through the ledger: each voucher line names the entry that took its
--   units out of the store's batch and the entry that brought them in at the place that asked,
--   both of the same batch (source 'issue', reasons 'issue_out' and 'issue_in').
-- * An indent reconciles with what was issued: a voucher line adds its units to its indent line's
--   `issued_quantity` (by a trigger, nothing else may change it), which never passes what was
--   approved, and what was approved never passes what was asked.
-- * An indent is approved or rejected by someone who did not ask for it, and moves only along its
--   states; who asked, decided or ended it never changes once recorded.
-- * Vouchers and their lines are never changed or removed. Numbers (IND-, IV-) count up per
--   hospital, one counter per kind.

ALTER TABLE stock_locations DROP CONSTRAINT stock_locations_kind_check;
ALTER TABLE stock_locations ADD CONSTRAINT stock_locations_kind_check
  CHECK (kind IN ('store', 'pharmacy', 'ward', 'department'));

ALTER TABLE stock_ledger DROP CONSTRAINT stock_ledger_source_check;
ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_source_check
  CHECK (source IN ('adjustment', 'dispense', 'sale', 'sale_return', 'receipt', 'purchase_return',
    'dispense_return', 'issue'));
ALTER TABLE stock_ledger DROP CONSTRAINT stock_ledger_reason_check;
ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_reason_check
  CHECK (reason IN ('opening', 'count_correction', 'damaged', 'expired', 'other', 'dispense',
    'sale', 'sale_return', 'receipt', 'purchase_return', 'dispense_return', 'wastage',
    'issue_out', 'issue_in'));

CREATE TABLE inventory_counters (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  kind text NOT NULL CHECK (kind IN ('indent', 'issue')),
  last_number integer NOT NULL CHECK (last_number >= 1),
  PRIMARY KEY (tenant_id, kind)
);

SELECT enable_tenant_rls('inventory_counters', 'SELECT, INSERT, UPDATE');

CREATE TABLE stock_indents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  number integer NOT NULL CHECK (number >= 1),
  -- The place that asks, and the place asked: never the same.
  from_location_id uuid NOT NULL,
  to_location_id uuid NOT NULL,
  note text CHECK (note IS NULL OR (note = btrim(note) AND length(note) BETWEEN 1 AND 200)),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled', 'partly_issued', 'issued', 'closed')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  -- Who approved or rejected it, and why it was rejected.
  decided_by uuid,
  decided_at timestamptz,
  rejection_note text
    CHECK (rejection_note IS NULL OR (rejection_note = btrim(rejection_note) AND length(rejection_note) BETWEEN 1 AND 200)),
  -- Who cancelled it before it was decided, or closed it with units still to issue, and why.
  ended_by uuid,
  ended_at timestamptz,
  end_note text CHECK (end_note IS NULL OR (end_note = btrim(end_note) AND length(end_note) BETWEEN 1 AND 200)),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT stock_indents_number_taken UNIQUE (tenant_id, number),
  CONSTRAINT stock_indents_from FOREIGN KEY (tenant_id, from_location_id)
    REFERENCES stock_locations (tenant_id, id),
  CONSTRAINT stock_indents_to FOREIGN KEY (tenant_id, to_location_id)
    REFERENCES stock_locations (tenant_id, id),
  CONSTRAINT stock_indents_two_places CHECK (from_location_id <> to_location_id),
  CONSTRAINT stock_indents_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT stock_indents_tenant_id_places UNIQUE (tenant_id, id, from_location_id, to_location_id),
  CONSTRAINT stock_indents_decided CHECK (
    (decided_by IS NULL) = (decided_at IS NULL)
    AND (status IN ('requested', 'cancelled')) = (decided_by IS NULL)
    AND (status = 'rejected') = (rejection_note IS NOT NULL)
  ),
  CONSTRAINT stock_indents_ended CHECK (
    (status IN ('cancelled', 'closed')) = (ended_by IS NOT NULL)
    AND (ended_by IS NULL) = (ended_at IS NULL)
    -- Closing says why; withdrawing needs no reason.
    AND (status = 'closed') = (end_note IS NOT NULL)
  ),
  -- Two people: whoever asked never decides.
  CONSTRAINT stock_indents_two_people CHECK (decided_by IS NULL OR decided_by <> requested_by)
);

-- The indents newest first, of the hospital, of a status, and of either place.
CREATE INDEX stock_indents_tenant_requested ON stock_indents (tenant_id, requested_at DESC, id DESC);
CREATE INDEX stock_indents_tenant_status ON stock_indents (tenant_id, status, requested_at DESC, id DESC);
CREATE INDEX stock_indents_tenant_from ON stock_indents (tenant_id, from_location_id, requested_at DESC, id DESC);
CREATE INDEX stock_indents_tenant_to ON stock_indents (tenant_id, to_location_id, requested_at DESC, id DESC);

SELECT enable_tenant_rls('stock_indents', 'SELECT, INSERT, UPDATE');

CREATE FUNCTION stock_indents_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.number <> OLD.number
     OR NEW.from_location_id <> OLD.from_location_id OR NEW.to_location_id <> OLD.to_location_id
     OR NEW.note IS DISTINCT FROM OLD.note OR NEW.requested_by <> OLD.requested_by
     OR NEW.requested_at <> OLD.requested_at THEN
    RAISE EXCEPTION 'What was asked for never changes' USING ERRCODE = '42501';
  END IF;
  IF (OLD.decided_by IS NOT NULL AND (NEW.decided_by IS DISTINCT FROM OLD.decided_by
        OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
        OR NEW.rejection_note IS DISTINCT FROM OLD.rejection_note))
     OR (OLD.ended_by IS NOT NULL AND (NEW.ended_by IS DISTINCT FROM OLD.ended_by
        OR NEW.ended_at IS DISTINCT FROM OLD.ended_at OR NEW.end_note IS DISTINCT FROM OLD.end_note)) THEN
    RAISE EXCEPTION 'Who moved an indent on never changes' USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'requested' AND NEW.status IN ('approved', 'rejected', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('partly_issued', 'issued', 'closed'))
    OR (OLD.status = 'partly_issued' AND NEW.status IN ('issued', 'closed'))
  ) THEN
    RAISE EXCEPTION 'An indent cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stock_indents_guard_update BEFORE UPDATE ON stock_indents
  FOR EACH ROW EXECUTE FUNCTION stock_indents_guard_update();

CREATE TABLE stock_indent_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  indent_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number BETWEEN 1 AND 100),
  drug_id uuid NOT NULL,
  requested_quantity integer NOT NULL CHECK (requested_quantity BETWEEN 1 AND 1000000),
  -- Set once, on approval: up to what was asked, 0 for an item the store will not give.
  approved_quantity integer CHECK (approved_quantity IS NULL OR approved_quantity BETWEEN 0 AND requested_quantity),
  -- The sum of the voucher lines of this line, kept by their trigger.
  issued_quantity integer NOT NULL DEFAULT 0
    CHECK (issued_quantity >= 0 AND issued_quantity <= coalesce(approved_quantity, 0)),
  CONSTRAINT stock_indent_lines_indent FOREIGN KEY (tenant_id, indent_id)
    REFERENCES stock_indents (tenant_id, id),
  CONSTRAINT stock_indent_lines_drug FOREIGN KEY (tenant_id, drug_id) REFERENCES drugs (tenant_id, id),
  CONSTRAINT stock_indent_lines_number_once UNIQUE (tenant_id, indent_id, line_number),
  CONSTRAINT stock_indent_lines_drug_once UNIQUE (tenant_id, indent_id, drug_id),
  -- So a voucher line names its indent line with the indent and the item.
  CONSTRAINT stock_indent_lines_tenant_id_indent_drug UNIQUE (tenant_id, id, indent_id, drug_id)
);

CREATE INDEX stock_indent_lines_tenant_indent ON stock_indent_lines (tenant_id, indent_id, line_number);

SELECT enable_tenant_rls('stock_indent_lines', 'SELECT, INSERT, UPDATE');

-- What was asked never changes; what was approved is set once; what was issued moves only with
-- a voucher line (the trigger below, one level down) and only up.
CREATE FUNCTION stock_indent_lines_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.indent_id <> OLD.indent_id
     OR NEW.line_number <> OLD.line_number OR NEW.drug_id <> OLD.drug_id
     OR NEW.requested_quantity <> OLD.requested_quantity THEN
    RAISE EXCEPTION 'What was asked for never changes' USING ERRCODE = '42501';
  END IF;
  IF OLD.approved_quantity IS NOT NULL AND NEW.approved_quantity IS DISTINCT FROM OLD.approved_quantity THEN
    RAISE EXCEPTION 'What was approved never changes' USING ERRCODE = '42501';
  END IF;
  IF NEW.issued_quantity <> OLD.issued_quantity
     AND (pg_trigger_depth() < 2 OR NEW.issued_quantity < OLD.issued_quantity) THEN
    RAISE EXCEPTION 'Units are issued on a voucher only' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stock_indent_lines_guard_update BEFORE UPDATE ON stock_indent_lines
  FOR EACH ROW EXECUTE FUNCTION stock_indent_lines_guard_update();

CREATE TABLE stock_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  number integer NOT NULL CHECK (number >= 1),
  indent_id uuid NOT NULL,
  -- The indent's places: out of the store asked, into the place that asked.
  from_location_id uuid NOT NULL,
  to_location_id uuid NOT NULL,
  note text CHECK (note IS NULL OR (note = btrim(note) AND length(note) BETWEEN 1 AND 200)),
  issued_by uuid NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_issues_number_taken UNIQUE (tenant_id, number),
  -- The indent's own places: an indent asks from_location of to_location, so a voucher sends
  -- from the indent's to_location to its from_location.
  CONSTRAINT stock_issues_indent FOREIGN KEY (tenant_id, indent_id, to_location_id, from_location_id)
    REFERENCES stock_indents (tenant_id, id, from_location_id, to_location_id),
  CONSTRAINT stock_issues_tenant_id_indent UNIQUE (tenant_id, id, indent_id)
);

CREATE INDEX stock_issues_tenant_indent ON stock_issues (tenant_id, indent_id, issued_at, id);

SELECT enable_tenant_rls('stock_issues', 'SELECT, INSERT');

CREATE TABLE stock_issue_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  issue_id uuid NOT NULL,
  indent_id uuid NOT NULL,
  indent_line_id uuid NOT NULL,
  drug_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000000),
  -- The entry that took the units out of the store, and the one that brought them in.
  out_entry_id uuid NOT NULL UNIQUE,
  in_entry_id uuid NOT NULL UNIQUE,
  CONSTRAINT stock_issue_lines_issue FOREIGN KEY (tenant_id, issue_id, indent_id)
    REFERENCES stock_issues (tenant_id, id, indent_id),
  CONSTRAINT stock_issue_lines_indent_line FOREIGN KEY (tenant_id, indent_line_id, indent_id, drug_id)
    REFERENCES stock_indent_lines (tenant_id, id, indent_id, drug_id),
  CONSTRAINT stock_issue_lines_batch FOREIGN KEY (tenant_id, batch_id, drug_id)
    REFERENCES stock_batches (tenant_id, id, drug_id),
  CONSTRAINT stock_issue_lines_out FOREIGN KEY (tenant_id, out_entry_id, batch_id)
    REFERENCES stock_ledger (tenant_id, id, batch_id),
  CONSTRAINT stock_issue_lines_in FOREIGN KEY (tenant_id, in_entry_id, batch_id)
    REFERENCES stock_ledger (tenant_id, id, batch_id),
  CONSTRAINT stock_issue_lines_batch_once UNIQUE (tenant_id, issue_id, batch_id)
);

-- A voucher line is issued only while its indent waits to be issued, and its two entries are the
-- voucher's own: of the source 'issue' and this voucher, one out of the voucher's store by its
-- units and one into the place that asked by the same units.
CREATE FUNCTION stock_issue_lines_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  issue record;
  entries integer;
BEGIN
  SELECT s.from_location_id, s.to_location_id, i.status INTO issue
    FROM stock_issues s JOIN stock_indents i ON i.tenant_id = s.tenant_id AND i.id = s.indent_id
    WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.issue_id;
  IF issue.status IS NULL OR issue.status NOT IN ('approved', 'partly_issued') THEN
    RAISE EXCEPTION 'Units are issued only on an approved indent' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO entries FROM stock_ledger e
    WHERE e.tenant_id = NEW.tenant_id AND e.source = 'issue' AND e.source_id = NEW.issue_id
      AND ((e.id = NEW.out_entry_id AND e.reason = 'issue_out'
              AND e.location_id = issue.from_location_id AND e.quantity = -NEW.quantity)
        OR (e.id = NEW.in_entry_id AND e.reason = 'issue_in'
              AND e.location_id = issue.to_location_id AND e.quantity = NEW.quantity));
  IF entries <> 2 THEN
    RAISE EXCEPTION 'A voucher line names its own entries out and in' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stock_issue_lines_check BEFORE INSERT ON stock_issue_lines
  FOR EACH ROW EXECUTE FUNCTION stock_issue_lines_check();

CREATE INDEX stock_issue_lines_tenant_issue ON stock_issue_lines (tenant_id, issue_id);
CREATE INDEX stock_issue_lines_tenant_indent_line ON stock_issue_lines (tenant_id, indent_line_id);

SELECT enable_tenant_rls('stock_issue_lines', 'SELECT, INSERT');

-- A voucher line adds its units to its indent line, which refuses more than was approved
-- (`stock_indent_lines_issued_quantity_check`).
CREATE FUNCTION stock_issue_lines_count() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  UPDATE stock_indent_lines SET issued_quantity = issued_quantity + NEW.quantity
    WHERE tenant_id = NEW.tenant_id AND id = NEW.indent_line_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stock_issue_lines_count AFTER INSERT ON stock_issue_lines
  FOR EACH ROW EXECUTE FUNCTION stock_issue_lines_count();

-- Never changed or removed, to the owner too.
CREATE FUNCTION stock_issues_never_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'An issue voucher is never changed or removed' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER stock_issues_never_change BEFORE UPDATE OR DELETE ON stock_issues
  FOR EACH ROW EXECUTE FUNCTION stock_issues_never_change();
CREATE TRIGGER stock_issue_lines_never_change BEFORE UPDATE OR DELETE ON stock_issue_lines
  FOR EACH ROW EXECUTE FUNCTION stock_issues_never_change();
CREATE TRIGGER stock_indents_no_delete BEFORE DELETE ON stock_indents
  FOR EACH ROW EXECUTE FUNCTION stock_issues_never_change();
CREATE TRIGGER stock_indent_lines_no_delete BEFORE DELETE ON stock_indent_lines
  FOR EACH ROW EXECUTE FUNCTION stock_issues_never_change();
CREATE TRIGGER stock_indents_no_truncate BEFORE TRUNCATE ON stock_indents
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_no_truncate();
CREATE TRIGGER stock_indent_lines_no_truncate BEFORE TRUNCATE ON stock_indent_lines
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_no_truncate();
CREATE TRIGGER stock_issues_no_truncate BEFORE TRUNCATE ON stock_issues
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_no_truncate();
CREATE TRIGGER stock_issue_lines_no_truncate BEFORE TRUNCATE ON stock_issue_lines
  FOR EACH STATEMENT EXECUTE FUNCTION inventory_no_truncate();
