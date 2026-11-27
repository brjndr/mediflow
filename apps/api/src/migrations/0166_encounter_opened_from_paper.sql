-- #1214: marks a visit opened from the paper OPD sheet (#1202), the only kind
-- encounter:recordPaper may cancel, and only while empty. Set when the visit is opened and never
-- changed (encounters_guard_update compares every column it does not list). Additive: visits
-- opened before this read false.
ALTER TABLE encounters ADD COLUMN opened_from_paper boolean NOT NULL DEFAULT false;
