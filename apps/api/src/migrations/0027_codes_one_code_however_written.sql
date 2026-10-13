-- Diagnosis and procedure codes (BE-17e): a set holds a code once, however it is written.
--
-- 0026 made a code unique as written, so A09 and a09, or E11.9 and E119, could both be loaded,
-- and a set loaded again from a file with other capitals would have been added whole beside the
-- first. Nothing removes a code, so that could never be put right. The search already compares
-- the code without its dot and in lower case (`code_plain`): that is now what is unique.
--
-- It replaces the index of the same columns, and serves the same search: a code typed from its
-- start.
DROP INDEX codes_by_code_plain;
CREATE UNIQUE INDEX codes_by_code_plain ON codes (system, code_plain text_pattern_ops);
