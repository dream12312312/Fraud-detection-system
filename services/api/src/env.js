import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// npm workspaces run the API with cwd=services/api, so plain `dotenv/config`
// never finds the repo-root .env. Load it explicitly; a local services/api/.env
// (if someone creates one) still takes precedence because it is loaded first.
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../.env') });
dotenv.config({ path: path.resolve(here, '../../../.env') });
