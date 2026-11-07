-- Which email job is the invitation's current attempt (#483). A resend gives the invite a new
-- id here; a job of an earlier attempt then writes nothing to it. Null until the first resend,
-- which the invitation's first job carries too (it has no attempt).
ALTER TABLE invites ADD COLUMN email_attempt uuid;
