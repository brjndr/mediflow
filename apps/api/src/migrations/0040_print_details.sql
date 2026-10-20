-- What a printed prescription needs beyond a name (#397): the hospital's address, phone and its
-- own registration or licence number on the letterhead, and the prescriber's qualifications and
-- the council that registered them (the registration number is already on the profile). All
-- nullable: a print says what is missing rather than refusing.

ALTER TABLE tenants
  -- Several lines, as it is printed under the name.
  ADD COLUMN address text
    CHECK (address IS NULL OR (address = btrim(address) AND length(address) BETWEEN 1 AND 300)),
  ADD COLUMN phone text
    CHECK (phone IS NULL OR (phone = btrim(phone) AND length(phone) BETWEEN 1 AND 50)),
  -- The hospital's registration or licence number, under the state's clinical establishments law.
  ADD COLUMN registration_number text
    CHECK (registration_number IS NULL
           OR (registration_number = btrim(registration_number)
               AND length(registration_number) BETWEEN 1 AND 50));

ALTER TABLE doctors
  -- As printed after the name: "MBBS, MD (General Medicine)".
  ADD COLUMN qualifications text
    CHECK (qualifications IS NULL
           OR (qualifications = btrim(qualifications) AND length(qualifications) BETWEEN 1 AND 200)),
  -- The council that gave the registration number: the NMC or a state medical council.
  ADD COLUMN registration_council text
    CHECK (registration_council IS NULL
           OR (registration_council = btrim(registration_council)
               AND length(registration_council) BETWEEN 1 AND 100));

-- The same guard as 0017, with the two new fields counted as part of the profile.
CREATE OR REPLACE FUNCTION doctors_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A doctor profile''s hospital, identity and person cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  IF (NEW.department_id, NEW.specialization, NEW.registration_number, NEW.qualifications,
      NEW.registration_council, NEW.consultation_minutes, NEW.active)
     IS DISTINCT FROM
     (OLD.department_id, OLD.specialization, OLD.registration_number, OLD.qualifications,
      OLD.registration_council, OLD.consultation_minutes, OLD.active) THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  IF NEW.hours_version IS DISTINCT FROM OLD.hours_version THEN
    NEW.hours_version := OLD.hours_version + 1;
  END IF;
  RETURN NEW;
END;
$$;
