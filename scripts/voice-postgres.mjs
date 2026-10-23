import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = await readFile(path.join(root, '.local/livekit/api.env'), 'utf8');
const raw = config.split('\n').find(line => line.startsWith('DATABASE_URL='))?.slice('DATABASE_URL='.length);
const url = new URL(raw ?? '');
if (url.hostname !== 'fixture-db' || url.pathname !== '/dialog_test_livekit' || url.search) throw new Error('Isolated fixture database required');
url.hostname = '127.0.0.1'; url.port = '55439';
// The application URL is never inherited or reused by the strict test suite.
const env = { ...process.env, TEST_DATABASE_URL: url.href, DIALOG_REQUIRE_POSTGRES: '1' };
delete env.DATABASE_URL;
const result = spawnSync(process.execPath, ['test/run-tests.mjs', ...process.argv.slice(2)], { cwd: path.join(root, 'artifacts/api-server'), env, stdio: 'inherit' });
if (result.error) throw new Error('Unable to start strict PostgreSQL tests');
process.exitCode = result.status ?? 1;
