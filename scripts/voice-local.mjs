import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, access, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const local = path.join(root, '.local', 'livekit');
const command = process.argv[2];
// Only named, non-secret tuning/benchmark settings pass through; provider keys never do.
const tuning = ['DIALOG_VOICE_STT_ENDPOINTING_MS', 'DIALOG_VOICE_ENDPOINTING_MIN_MS', 'DIALOG_VOICE_ENDPOINTING_MAX_MS', 'DIALOG_VOICE_PREEMPTIVE_LLM', 'DIALOG_VOICE_TTS_IDLE_TIMEOUT_MS'];
const bench = ['VOICE_BENCH_LABEL', 'VOICE_BENCH_ITERATIONS', 'VOICE_BENCH_REPEAT_SESSIONS', 'VOICE_BENCH_WARMUP', 'VOICE_BENCH_FAILURE_RUNS'];
const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'HOME', 'TEMP', 'TMP', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'APPDATA', 'LOCALAPPDATA', ...tuning].filter(k => process.env[k]).map(k => [k, process.env[k]]));
function docker(args, capture = false, overlays = []) {
  const result = spawnSync('docker', ['compose', '--project-name', 'dialog-voice-local', '--env-file', path.join(local, 'compose.env'),
    '--file', path.join(root, 'deploy/livekit/compose.yaml'), ...overlays.flatMap(f => ['--file', path.join(root, f)]), '--profile', 'fixture', ...args],
    { cwd: root, env, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Local Docker operation failed; check Docker availability and service health.');
  return result.stdout;
}
async function generate() {
  await mkdir(local, { recursive: true, mode: 0o700 });
  try { await access(path.join(local, 'api.env')); return; } catch {}
  const secret = () => randomBytes(32).toString('base64url');
  const key = 'local_' + randomBytes(12).toString('hex'), apiSecret = secret(), workerSecret = secret(), dbPassword = secret();
  const db = new URL('postgresql://fixture-db:5432/dialog_test_livekit'); db.username = 'dialog_test'; db.password = dbPassword;
  const write = (name, text) => writeFile(path.join(local, name), text, { mode: 0o600, flag: 'wx' });
  await write('compose.env', '# Intentionally empty: never read the repository .env\n');
  await write('database.env', `POSTGRES_DB=dialog_test_livekit\nPOSTGRES_USER=dialog_test\nPOSTGRES_PASSWORD=${dbPassword}\n`);
  await write('api.env', `NODE_ENV=development\nDIALOG_LOCAL_VOICE=1\nLIVEKIT_PROVIDER_MODE=mock\nDATABASE_URL=${db.href}\nJWT_SECRET=${secret()}\nMEDIA_SESSION_SIGNING_KEY=${randomBytes(32).toString('base64')}\nENCRYPTION_KEY=${randomBytes(32).toString('hex')}\nLIVEKIT_URL=http://livekit:7880\nLIVEKIT_BROWSER_URL=ws://localhost:7880\nLIVEKIT_API_KEY=${key}\nLIVEKIT_API_SECRET=${apiSecret}\nLIVEKIT_WORKER_SECRET=${workerSecret}\nLOG_LEVEL=warn\n`);
  await write('worker.env', `NODE_ENV=production\nLIVEKIT_URL=ws://livekit:7880\nLIVEKIT_API_KEY=${key}\nLIVEKIT_API_SECRET=${apiSecret}\nLIVEKIT_WORKER_SECRET=${workerSecret}\nDIALOG_API_URL=http://fixture-api:3003\nMOCK_PROVIDER_URL=http://mock-providers:8090\nLIVEKIT_AGENTS_PRELOAD_LOCAL_INFERENCE=0\nOTEL_SDK_DISABLED=true\n`);
  await write('login.json', JSON.stringify([1, 2].map(i => ({ email: `preview-${i}@local.invalid`, password: secret(), tenantSlug: `local-voice-${i}` })), null, 2));
  await write('livekit.yaml', `port: 7880\nbind_addresses: ["0.0.0.0"]\nrtc:\n  tcp_port: 7881\n  udp_port: 7882\n  use_external_ip: false\n  node_ip: 127.0.0.1\n  advertise_internal_ip: true\n  stun_servers: ["127.0.0.1:9"]\n  enable_loopback_candidate: true\nredis:\n  address: redis:6379\nkeys:\n  ${key}: ${apiSecret}\nlogging:\n  level: error\nwebhook:\n  api_key: ${key}\n  urls: ["http://fixture-api:3003/api/livekit/webhook"]\n`);
  await write('sip.yaml', `api_key: ${key}\napi_secret: ${apiSecret}\nws_url: ws://livekit:7880\nredis:\n  address: redis:6379\nsip_port: 5060\nrtp_port: 10000-10100\nuse_external_ip: false\nlogging:\n  level: error\n`);
}
// Values are checked for presence only and never printed.
async function envKeys(file) {
  const text = await readFile(path.join(local, file), 'utf8').catch(() => '');
  return new Set(text.split(/\r?\n/).map(line => /^\s*([A-Z0-9_]+)\s*=\s*(\S.*)$/.exec(line)).filter(Boolean).map(m => m[1]));
}
const LIVE_LIMITS = { VOICE_BENCH_ITERATIONS: [2, 3], VOICE_BENCH_REPEAT_SESSIONS: [1, 2], VOICE_BENCH_WARMUP: [0, 1] };
async function liveBenchPlan() {
  if (process.env.DIALOG_VOICE_LIVE_BENCH !== 'paid-providers') throw new Error('Manual-live benchmark requires DIALOG_VOICE_LIVE_BENCH=paid-providers.');
  const worker = await envKeys('manual-worker.env'), apiKeys = await envKeys('manual-api.env');
  if (!worker.has('DEEPGRAM_API_KEY') || !worker.has('SARVAM_API_KEY')) throw new Error('Manual-live benchmark requires DEEPGRAM_API_KEY and SARVAM_API_KEY in .local/livekit/manual-worker.env.');
  if (!['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'SARVAM_API_KEY'].some(k => apiKeys.has(k))) throw new Error('Manual-live benchmark requires an LLM key in .local/livekit/manual-api.env.');
  const clip = await stat(path.join(local, 'bench', 'live-utterance.wav')).catch(() => null);
  if (!clip?.isFile() || clip.size < 1000 || clip.size > 5_000_000) throw new Error('Manual-live benchmark requires a recorded speech clip at .local/livekit/bench/live-utterance.wav (under 5 MB).');
  const values = {};
  for (const [name, [fallback, max]] of Object.entries(LIVE_LIMITS)) {
    const raw = process.env[name];
    if (raw !== undefined && !(/^\d+$/.test(raw) && Number(raw) <= max)) throw new Error(`${name} must be at most ${max} for manual-live runs.`);
    values[name] = raw === undefined ? fallback : Number(raw);
  }
  // Smoke turn + warm-up (2 turns each) + repeat sessions (6 turns) + mixed sessions (5 cases, interruption adds one).
  const maxTurns = 1 + values.VOICE_BENCH_WARMUP * 2 + values.VOICE_BENCH_REPEAT_SESSIONS * 6 + values.VOICE_BENCH_ITERATIONS * 6;
  const flags = Object.entries(values).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  if (process.env.VOICE_BENCH_LABEL) flags.push('-e', `VOICE_BENCH_LABEL=${process.env.VOICE_BENCH_LABEL}`);
  return { maxTurns, flags };
}
try {
  if (command === 'init') {
    await generate();
    docker(['build', 'worker']);
    docker(['up', '-d', '--wait', 'fixture-db', 'redis', 'gateway']);
    docker(['run', '--rm', '--no-deps', 'fixture-api', 'pnpm', '--filter', '@workspace/scripts', 'exec', 'tsx', '../artifacts/api-server/src/livekit-fixture.ts', 'init']);
    console.log('Isolated fixture initialized. Development login is in .local/livekit/login.json.');
  } else {
    await access(path.join(local, 'api.env'));
    if (command === 'up') docker(['up', '-d', '--no-build', 'gateway', 'livekit', 'sip', 'worker', 'fixture-api', 'frontend', 'mock-providers']);
    else if (command === 'down') docker(['down']);
    else if (command === 'logs') {
      // Raw SDK, PostgreSQL and HTTP logs may contain identities. Show bounded status only.
      const status = JSON.parse(docker(['ps', '--all', '--format', 'json'], true).split('\n').filter(Boolean).map(line => line.trim()).join(',').replace(/^/, '[').replace(/$/, ']'));
      for (const service of status) console.log(JSON.stringify({ service: service.Service, state: service.State, health: service.Health }));
    } else if (command === 'smoke') docker(['--profile', 'smoke', 'run', '--rm', 'smoke']); // `compose run` has no --no-build; the smoke service is image-based, so nothing builds.
    else if (command === 'bench') {
      // Mock-provider latency benchmark: same harness and stack as smoke, results in .local/livekit/bench.
      await mkdir(path.join(local, 'bench'), { recursive: true });
      const flags = bench.filter(k => process.env[k]).flatMap(k => ['-e', `${k}=${process.env[k]}`]);
      docker(['--profile', 'smoke', 'run', '--rm', '-e', 'VOICE_BENCH=1', ...flags, 'smoke']);
    } else if (command === 'bench-live') {
      // Paid providers. Every precondition is checked before any container or network action.
      const plan = await liveBenchPlan();
      console.log(`Manual-live benchmark: at most ${plan.maxTurns} user turns against real Deepgram, Sarvam and the configured LLM.`);
      const overlay = ['deploy/livekit/compose.manual-live.yaml'];
      try {
        docker(['up', '-d', '--no-build', '--wait', 'fixture-api', 'worker'], false, overlay);
        docker(['--profile', 'smoke', 'run', '--rm', '-e', 'VOICE_BENCH=1', '-e', 'VOICE_BENCH_PROVIDER_MODE=live', ...plan.flags, 'smoke'], false, overlay);
      } finally {
        // Always return the shared stack to mock providers.
        docker(['up', '-d', '--no-build', '--wait', 'fixture-api', 'worker']);
      }
    } else throw new Error('Expected init, up, smoke, bench, bench-live, logs or down. Reset is deliberately separate.');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
