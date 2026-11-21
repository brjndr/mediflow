// tsc compiles TypeScript only. The SQL migrations and their journal are copied next to the
// compiled migrator so `node dist/core/db/migrate-cli.js` finds them in the image. The list of
// leaked passwords (#1083) goes next to the compiled password module for the same reason.
import { cpSync } from 'node:fs';

cpSync('src/migrations', 'dist/migrations', { recursive: true });
cpSync('src/core/auth/breached-passwords.txt', 'dist/core/auth/breached-passwords.txt');
