// tsc compiles TypeScript only. The SQL migrations and their journal are copied next to the
// compiled migrator so `node dist/core/db/migrate-cli.js` finds them in the image.
import { cpSync } from 'node:fs';

cpSync('src/migrations', 'dist/migrations', { recursive: true });
