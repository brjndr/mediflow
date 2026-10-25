-- The laboratory's completed stage (#91): the hospital's completed lab orders, the newest first,
-- so a verified result can still be found and corrected.
CREATE INDEX orders_tenant_lab_completed ON orders (tenant_id, status_changed_at DESC, id DESC)
  WHERE type = 'lab' AND status = 'completed';
