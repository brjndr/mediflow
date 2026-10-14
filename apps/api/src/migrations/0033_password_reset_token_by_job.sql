-- Staff email is sent by a job (#333). The job gives a reset link its token when it sends the
-- email, so the token is never stored in the job queue: the request saves the link with a hash
-- that matches no token, and the job replaces it. Authentication may now change that one column.
GRANT UPDATE (token_hash) ON password_resets TO mediflow_auth;
