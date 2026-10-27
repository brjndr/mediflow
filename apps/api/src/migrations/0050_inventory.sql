-- Inventory (#102): where a hospital keeps stock, the batches of its drugs and consumables, how
-- much of each batch is at each place, the ledger of every change, and adjustments that wait for
-- a second person's approval. What the database itself guarantees:
--
-- * Stock changes only through the ledger. A ledger entry's trigger moves the balance of its batch
--   at its place in the same statement, and a balance refuses any other write. So every change of
--   stock is in the ledger, and the balance is the sum of the entries.
-- * A balance never goes below zero (a check), and the trigger's upsert locks the balance row, so
--   two changes of the same batch at the same place take their turn and cannot oversell.
-- * The ledger is append-only: no UPDATE or DELETE grant, and its trigger refuses either to the
--   owner as well. A correction is a new entry.
-- * A batch's number, expiry and item never change. A batch is of one item; its number is one per
--   item, whatever the capitals.
-- * An adjustment is decided once, by someone other than who asked for it.

CREATE TABLE stock_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 100),
  kind text NOT NULL CHECK (kind IN ('store', 'pharmacy', 'ward')),
  archived boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  name_lower text GENERATED ALWAYS AS (lower(name)) STORED,
  CONSTRAINT stock_locations_name_taken UNIQUE (tenant_id, name_lower),
  CONSTRAINT stock_locations_tenant_id_id UNIQUE (tenant_id, id)
);

CREATE INDEX stock_locations_tenant_list ON stock_locations (tenant_id, archived, name_lower, id);

SELECT enable_tenant_rls('stock_locations', 'SELECT, INSERT, UPDATE');

CREATE FUNCTION stock_locations_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A location''s hospital and identity cannot be changed' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stock_locations_guard_update BEFORE UPDATE ON stock_locations
  FOR EACH ROW EXECUTE FUNCTION stock_locations_guard_update();

-- So a batch names its item together with the item's hospital.
CREATE TABLE stock_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  drug_id uuid NOT NULL,
  -- As printed on the pack.
  batch_number text NOT NULL
    CHECK (batch_number = btrim(batch_number) AND length(batch_number) BETWEEN 1 AND 40),
  -- The last day the batch may be used.
  expiry_date date NOT NULL,
  -- The printed maximum retail price and the cost of one unit, in minor units. Empty: not known.
  mrp_minor bigint CHECK (mrp_minor IS NULL OR mrp_minor BETWEEN 0 AND 100000000000),
  cost_minor bigint CHECK (cost_minor IS NULL OR cost_minor BETWEEN 0 AND 100000000000),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  batch_key text GENERATED ALWAYS AS (upper(batch_number)) STORED,
  CONSTRAINT stock_batches_drug FOREIGN KEY (tenant_id, drug_id) REFERENCES drugs (tenant_id, id),
  CONSTRAINT stock_batches_number_taken UNIQUE (tenant_id, drug_id, batch_key),
  -- So a balance and an entry name a batch together with its item.
  CONSTRAINT stock_batches_tenant_id_drug UNIQUE (tenant_id, id, drug_id)
);

-- The batches that expire soonest first: the expiry alerts.
CREATE INDEX stock_batches_tenant_expiry ON stock_batches (tenant_id, expiry_date, id);

-- A batch is what is printed on the pack: never changed, never removed.
SELECT enable_tenant_rls('stock_batches', 'SELECT, INSERT');

CREATE TABLE stock_balances (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  batch_id uuid NOT NULL,
  drug_id uuid NOT NULL,
  location_id uuid NOT NULL,
  on_hand integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, batch_id, location_id),
  CONSTRAINT stock_balances_not_negative CHECK (on_hand >= 0),
  CONSTRAINT stock_balances_batch FOREIGN KEY (tenant_id, batch_id, drug_id)
    REFERENCES stock_batches (tenant_id, id, drug_id),
  CONSTRAINT stock_balances_location FOREIGN KEY (tenant_id, location_id)
    REFERENCES stock_locations (tenant_id, id)
);

-- An item's stock, at every place or one.
CREATE INDEX stock_balances_tenant_drug ON stock_balances (tenant_id, drug_id, location_id);

SELECT enable_tenant_rls('stock_balances', 'SELECT, INSERT, UPDATE');

-- Only the ledger's trigger writes a balance: a statement of its own is refused, to the owner too.
CREATE FUNCTION stock_balances_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Stock changes through the ledger only' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A balance is never removed' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id <> OLD.tenant_id OR NEW.batch_id <> OLD.batch_id
     OR NEW.drug_id <> OLD.drug_id OR NEW.location_id <> OLD.location_id) THEN
    RAISE EXCEPTION 'What a balance is of never changes' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stock_balances_guard BEFORE INSERT OR UPDATE OR DELETE ON stock_balances
  FOR EACH ROW EXECUTE FUNCTION stock_balances_guard();

CREATE TABLE stock_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  batch_id uuid NOT NULL,
  drug_id uuid NOT NULL,
  location_id uuid NOT NULL,
  -- In and out: positive in, negative out, never nothing.
  quantity integer NOT NULL CHECK (quantity <> 0 AND quantity BETWEEN -1000000 AND 1000000),
  -- The balance of the batch at the place right after this entry: set by the trigger.
  balance_after integer NOT NULL DEFAULT 0,
  -- What made the entry, and its record. Later: a goods receipt, a dispense, a transfer.
  source text NOT NULL CHECK (source IN ('adjustment')),
  source_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('opening', 'count_correction', 'damaged', 'expired', 'other')),
  actor_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_ledger_batch FOREIGN KEY (tenant_id, batch_id, drug_id)
    REFERENCES stock_batches (tenant_id, id, drug_id),
  CONSTRAINT stock_ledger_location FOREIGN KEY (tenant_id, location_id)
    REFERENCES stock_locations (tenant_id, id)
);

-- The ledger newest first, of the hospital, of an item and of a batch.
CREATE INDEX stock_ledger_tenant_at ON stock_ledger (tenant_id, at DESC, id DESC);
CREATE INDEX stock_ledger_tenant_drug ON stock_ledger (tenant_id, drug_id, at DESC, id DESC);
CREATE INDEX stock_ledger_tenant_batch ON stock_ledger (tenant_id, batch_id, at DESC, id DESC);

-- Append-only: no UPDATE or DELETE grant, and the trigger refuses either to the owner as well.
SELECT enable_tenant_rls('stock_ledger', 'SELECT, INSERT');

CREATE FUNCTION stock_ledger_post() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  balance integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A stock ledger entry never changes' USING ERRCODE = '42501';
  END IF;
  -- Either statement locks the balance row until the transaction ends; a negative result breaks
  -- stock_balances_not_negative and the whole statement fails. Stock going out only updates:
  -- Postgres checks an insert's own row before it finds the conflict, so a negative insert would
  -- be refused even where there is stock.
  IF NEW.quantity > 0 THEN
    INSERT INTO stock_balances AS b (tenant_id, batch_id, drug_id, location_id, on_hand)
      VALUES (NEW.tenant_id, NEW.batch_id, NEW.drug_id, NEW.location_id, NEW.quantity)
    ON CONFLICT (tenant_id, batch_id, location_id)
      DO UPDATE SET on_hand = b.on_hand + EXCLUDED.on_hand, updated_at = now()
    RETURNING b.on_hand INTO balance;
  ELSE
    UPDATE stock_balances SET on_hand = on_hand + NEW.quantity, updated_at = now()
    WHERE tenant_id = NEW.tenant_id AND batch_id = NEW.batch_id AND location_id = NEW.location_id
    RETURNING on_hand INTO balance;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The batch has no stock at the place' USING
        ERRCODE = '23514', TABLE = 'stock_balances', CONSTRAINT = 'stock_balances_not_negative';
    END IF;
  END IF;
  NEW.balance_after := balance;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stock_ledger_post BEFORE INSERT OR UPDATE OR DELETE ON stock_ledger
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_post();

CREATE TABLE stock_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  location_id uuid NOT NULL,
  drug_id uuid NOT NULL,
  -- The batch adjusted. Empty for opening stock of a batch the hospital does not have yet, which
  -- is made from the fields below when the adjustment is approved.
  batch_id uuid,
  batch_number text
    CHECK (batch_number IS NULL OR (batch_number = btrim(batch_number) AND length(batch_number) BETWEEN 1 AND 40)),
  expiry_date date,
  mrp_minor bigint CHECK (mrp_minor IS NULL OR mrp_minor BETWEEN 0 AND 100000000000),
  cost_minor bigint CHECK (cost_minor IS NULL OR cost_minor BETWEEN 0 AND 100000000000),
  quantity integer NOT NULL CHECK (quantity <> 0 AND quantity BETWEEN -1000000 AND 1000000),
  reason text NOT NULL CHECK (reason IN ('opening', 'count_correction', 'damaged', 'expired', 'other')),
  note text CHECK (note IS NULL OR (note = btrim(note) AND length(note) BETWEEN 1 AND 200)),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  rejection_note text
    CHECK (rejection_note IS NULL OR (rejection_note = btrim(rejection_note) AND length(rejection_note) BETWEEN 1 AND 200)),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT stock_adjustments_location FOREIGN KEY (tenant_id, location_id)
    REFERENCES stock_locations (tenant_id, id),
  CONSTRAINT stock_adjustments_drug FOREIGN KEY (tenant_id, drug_id) REFERENCES drugs (tenant_id, id),
  CONSTRAINT stock_adjustments_batch FOREIGN KEY (tenant_id, batch_id, drug_id)
    REFERENCES stock_batches (tenant_id, id, drug_id),
  -- A batch named, or a new one described in full, for opening stock only. The new batch is made
  -- when the adjustment is approved, and named here from then on.
  CONSTRAINT stock_adjustments_new_batch CHECK (
    (batch_id IS NOT NULL AND batch_number IS NULL AND expiry_date IS NULL
       AND mrp_minor IS NULL AND cost_minor IS NULL)
    OR (batch_number IS NOT NULL AND expiry_date IS NOT NULL AND reason = 'opening'
       AND (batch_id IS NOT NULL) = (status = 'approved'))
  ),
  -- Opening stock comes in; damaged and expired stock goes out.
  CONSTRAINT stock_adjustments_direction CHECK (
    (reason <> 'opening' OR quantity > 0) AND (reason NOT IN ('damaged', 'expired') OR quantity < 0)
  ),
  CONSTRAINT stock_adjustments_decided CHECK (
    (status = 'pending') = (decided_by IS NULL)
    AND (decided_by IS NULL) = (decided_at IS NULL)
    AND (rejection_note IS NULL OR status = 'rejected')
  ),
  -- Two people: whoever asked never decides.
  CONSTRAINT stock_adjustments_two_people CHECK (decided_by IS NULL OR decided_by <> requested_by)
);

-- The adjustments of a status, newest asked first.
CREATE INDEX stock_adjustments_tenant_status ON stock_adjustments (tenant_id, status, requested_at DESC, id DESC);

SELECT enable_tenant_rls('stock_adjustments', 'SELECT, INSERT, UPDATE');

CREATE FUNCTION stock_adjustments_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'A decided adjustment never changes' USING ERRCODE = '42501';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.location_id <> OLD.location_id
     OR NEW.drug_id <> OLD.drug_id OR NEW.quantity <> OLD.quantity OR NEW.reason <> OLD.reason
     OR NEW.note IS DISTINCT FROM OLD.note OR NEW.requested_by <> OLD.requested_by
     OR NEW.requested_at <> OLD.requested_at OR NEW.batch_number IS DISTINCT FROM OLD.batch_number
     OR NEW.expiry_date IS DISTINCT FROM OLD.expiry_date OR NEW.mrp_minor IS DISTINCT FROM OLD.mrp_minor
     OR NEW.cost_minor IS DISTINCT FROM OLD.cost_minor
     OR (OLD.batch_id IS NOT NULL AND NEW.batch_id IS DISTINCT FROM OLD.batch_id) THEN
    RAISE EXCEPTION 'What was asked for never changes' USING ERRCODE = '42501';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stock_adjustments_guard_update BEFORE UPDATE ON stock_adjustments
  FOR EACH ROW EXECUTE FUNCTION stock_adjustments_guard_update();
