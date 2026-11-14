# The practice hospital

New staff learn on invented records, never on real patients.

## What it is

The seeded sample hospital: invented departments, doctors, wards, about 250 patients, a price list, medicines with stock, lab tests, and today's queue tokens. It runs on the test environment (not the real hospital's address) with its own sign-ins. Every name is made up and every email ends in `.test`.

## Sign-ins

The seed creates the sample accounts (admin, doctor, nurse, store keeper, pharmacist and others) on a shared password. Ask your admin for the sheet. Never reuse a password from the real system.

## Rules

- Use only the test environment address for training. If the screen does not show the sample hospital, stop and sign out.
- Never type a real patient's details, even to test.
- The admin resets the data before each training week with the seed (`pnpm --filter api db:seed`).
- Mistakes cost nothing here: try the refund, the rejected sample, the wrong batch.

## For the admin

The test environment needs the cloud account (issue #149 covers onboarding). Until it exists the sample hospital runs from the repository on a laptop: see `docs/STATUS.md`, start the API (`pnpm --filter api dev`) and the web app with `VITE_API_MOCKING=disabled`.
