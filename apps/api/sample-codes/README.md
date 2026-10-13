# Sample code sets

Two small files for development, in the format `codes:load` reads: a first line `code,title`, then one code a line.

- `icd10.csv`: 67 common diagnosis codes, the same sample the web app's mock holds.
- `procedures.csv`: 20 procedures with made-up codes.

`pnpm --filter api db:seed` loads both. They are a sample, not a classification: a hospital's full code set is loaded by an operator from a file it has the right to use, and is never committed here.

```bash
pnpm --filter api codes:load --system=icd10 --file=/path/to/the/full/set.csv
```
