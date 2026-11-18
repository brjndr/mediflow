-- #1063: the sweep for files stuck in scanning reads when a file was received.
GRANT SELECT (uploaded_at) ON patient_documents TO mediflow_worker;
GRANT SELECT (uploaded_at) ON imaging_images TO mediflow_worker;
