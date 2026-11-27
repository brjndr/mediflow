-- Work reported for a visit after it was cancelled (#1222): the charge is posted void with the
-- flag 'visit_cancelled', so the ledger keeps what was done and a cancelled visit is never billed.
ALTER TABLE charges DROP CONSTRAINT charges_flag_check;
ALTER TABLE charges ADD CONSTRAINT charges_flag_check
  CHECK (flag IS NULL OR flag IN ('service_archived', 'no_price', 'return_review', 'package_covered',
    'relink_review', 'visit_cancelled'));
