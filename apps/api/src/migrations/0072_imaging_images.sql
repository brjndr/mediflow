-- Image uploads for radiology (#99): files attached to a performed study, sent to the API through
-- a signed link and checked for malware before anyone can download them. What the database
-- itself guarantees:
--
-- * An image names its study, order, encounter and patient together.
-- * The size is positive and within a hard ceiling, the type is one of a short list.
-- * Only the worker role (the upload link and the scan job, which have no session) changes the
--   state of an image, and an image is never removed.

CREATE TABLE imaging_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  study_id uuid NOT NULL,
  order_id uuid NOT NULL,
  encounter_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  -- As the person named it, tidied: shown in lists and used for the download, never in a path.
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'application/pdf', 'application/dicom')),
  -- The size announced when the upload was asked for, and checked against the file received.
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 104857600),
  -- pending: link given, nothing received. scanning: received, waiting for the scan.
  -- clean: may be downloaded. infected: the scan found something, the file is deleted.
  -- failed: the file was lost or the scan could not be done.
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'scanning', 'clean', 'infected', 'failed')),
  -- Where the file is kept in the file store; set when received.
  file_key text CHECK (file_key ~ '^imaging/[0-9a-f-]{36}/[0-9a-f-]{36}$'),
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- A code (the scanner's signature name), never text from a file.
  scan_result text CHECK (scan_result ~ '^[A-Za-z0-9._:-]{1,100}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  uploaded_at timestamptz,
  scanned_at timestamptz,
  CONSTRAINT imaging_images_study FOREIGN KEY (tenant_id, study_id, order_id, encounter_id, patient_id)
    REFERENCES imaging_studies (tenant_id, id, order_id, encounter_id, patient_id),
  CONSTRAINT imaging_images_received CHECK (
    (status = 'pending') = (uploaded_at IS NULL)
  ),
  CONSTRAINT imaging_images_tenant_id_id UNIQUE (tenant_id, id)
);

CREATE INDEX imaging_images_tenant_study ON imaging_images (tenant_id, study_id, created_at);

-- The app asks for an upload and reads; it never changes the state of an image or removes one.
SELECT enable_tenant_rls('imaging_images', 'SELECT, INSERT');

-- Background and link work as the worker role, across hospitals: receiving a file through its
-- signed link (no session, so no hospital), the scan, and serving a download link.
CREATE POLICY worker_all ON imaging_images FOR ALL TO mediflow_worker USING (true) WITH CHECK (true);
GRANT SELECT (id, tenant_id, file_name, content_type, size_bytes, status, file_key)
  ON imaging_images TO mediflow_worker;
GRANT UPDATE (status, file_key, sha256, scan_result, uploaded_at, scanned_at)
  ON imaging_images TO mediflow_worker;
