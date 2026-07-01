-- Adds worker employment/spouse fields and student sponsorship/collateral fields.
-- Safe to run more than once on PostgreSQL.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS workers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text UNIQUE,
  full_name text,
  phone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS spouse_name text,
  ADD COLUMN IF NOT EXISTS spouse_contact text,
  ADD COLUMN IF NOT EXISTS place_of_work text,
  ADD COLUMN IF NOT EXISTS employer_contact_number text,
  ADD COLUMN IF NOT EXISTS income_date integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workers_income_date_check'
  ) THEN
    ALTER TABLE workers
      ADD CONSTRAINT workers_income_date_check
      CHECK (income_date IS NULL OR income_date BETWEEN 1 AND 31);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text UNIQUE,
  full_name text,
  phone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE students
  ADD COLUMN IF NOT EXISTS year_of_study text,
  ADD COLUMN IF NOT EXISTS sponsorship_status text,
  ADD COLUMN IF NOT EXISTS collateral_type text,
  ADD COLUMN IF NOT EXISTS collateral_description text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'students_year_of_study_check'
  ) THEN
    ALTER TABLE students
      ADD CONSTRAINT students_year_of_study_check
      CHECK (
        year_of_study IS NULL
        OR year_of_study IN ('Year 1', 'Year 2', 'Year 3', 'Year 4', 'Post-grad')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'students_sponsorship_status_check'
  ) THEN
    ALTER TABLE students
      ADD CONSTRAINT students_sponsorship_status_check
      CHECK (
        sponsorship_status IS NULL
        OR sponsorship_status IN ('Sponsored', 'Self-Sponsored')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'students_collateral_type_check'
  ) THEN
    ALTER TABLE students
      ADD CONSTRAINT students_collateral_type_check
      CHECK (
        collateral_type IS NULL
        OR collateral_type IN (
          'Electronics (Smartphone, Laptop, Tablet)',
          'Valuable Personal Item',
          'Other Asset'
        )
      );
  END IF;
END $$;
