-- A person's own choice of language for the web app (#766). Null means "follow the hospital's
-- locale". Additive; the auth role may change only this column besides what it could already.
ALTER TABLE users ADD COLUMN language text CHECK (language IN ('en', 'hi'));
GRANT UPDATE (language) ON users TO mediflow_auth;
