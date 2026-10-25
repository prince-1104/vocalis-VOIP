// Local mock-only Phase 1R-G populations. Never reads or forwards provider credentials.
import { spawn, execFile } from 'node:child_process';
import { mkdir, appendFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reliabilityResults, lifecyclePassed } from './voice-reliability-results.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const group = process.argv[2];
if (!['normal', 'stressed', 'cold', 'regression', 'outage', 'lease-expiry'].includes(group)) throw new Error('Expected normal, stressed, cold, regression, outage or lease-expiry');
const config = async name => new Map((await readFile(path.join(root, '.local/livekit', name), 'utf8')).split(/\r?\n/).filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const apiConfig = await config('api.env'), workerConfig = await config('worker.env');
if (apiConfig.get('LIVEKIT_PROVIDER_MODE') !== 'mock' || apiConfig.get('DIALOG_LOCAL_VOICE') !== '1'
  || workerConfig.get('LIVEKIT_URL') !== 'ws://livekit:7880' || workerConfig.get('DIALOG_API_URL') !== 'http://fixture-api:3003'
  || workerConfig.get('MOCK_PROVIDER_URL') !== 'http://mock-providers:8090'
  || workerConfig.get('DIALOG_LOCAL_VOICE_PROFILE') === 'manual-live') throw new Error('Isolated mock fixture configuration required');
const safeEnv = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'HOME', 'TEMP', 'TMP', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'APPDATA', 'LOCALAPPDATA'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const compose = ['compose', '--project-name', 'dialog-voice-local', '--env-file', '.local/livekit/compose.env', '--file', 'deploy/livekit/compose.yaml', '--profile', 'fixture'];
const directory = path.join(root, '.local/livekit/bench');
await mkdir(directory, { recursive: true });
const ledger = path.join(directory, `phase-1rg-${group}-${Date.now()}.jsonl`);
async function record(value) { await appendFile(ledger, JSON.stringify(value) + '\n'); }
async function workerEvidence() {
  // Never persist raw container logs. Keep only the fixed diagnostic schema.
  const raw = await new Promise(resolve => execFile('docker', [...compose, 'logs', '--no-color', '--no-log-prefix', '--tail', '2000', 'worker'],
    { cwd: root, env: safeEnv, windowsHide: true, timeout: 15000, maxBuffer: 2_000_000 }, (error, stdout) => resolve(error ? '' : stdout)));
  const events = new Set(['livekit_process_initializing', 'livekit_process_ready', 'livekit_process_failed', 'livekit_job_process_unavailable', 'livekit_job_accepted', 'livekit_job_entry', 'livekit_job_claimed',
    'audio_track_created', 'publication_started', 'publication_resolved', 'publication_rejected', 'publication_timeout', 'subscription_timeout', 'subscription_ready', 'livekit_server_media_state', 'livekit_session_closing', 'livekit_session_closed']);
  const retained = [];
  for (const line of raw.split('\n')) {
    try {
      const parsed = JSON.parse(line);
      if (!events.has(parsed.event)) continue;
      const value = { event: parsed.event };
      if (/^[0-9a-f-]{36}$/.test(parsed.diagnosticId ?? '')) value.diagnosticId = parsed.diagnosticId;
      for (const key of ['pid', 'elapsedMs', 'cleanupMs', 'vadLoadMs', 'registrationMs', 'uptimeMs', 'claimMs', 'participantCount', 'agentPublicationCount'])
        if (Number.isFinite(parsed[key]) && parsed[key] >= 0) value[key] = parsed[key];
      for (const key of ['agentPresent', 'unavailable', 'started', 'published']) if (typeof parsed[key] === 'boolean') value[key] = parsed[key];
      if (['heartbeat', 'room_disconnected', 'session_closed', 'session_error', 'shutdown', 'start_failed', 'connection_timeout', 'media_timeout', 'publication_rejected', 'media_cancelled'].includes(parsed.reason)) value.reason = parsed.reason;
      retained.push(value);
    } catch { /* Non-diagnostic build output and malformed lines are discarded. */ }
  }
  return retained;
}
async function retainWorkerEvidence() {
  for (const value of await workerEvidence()) await record({ worker: value });
}
function run(program, args, extra = {}, timeoutMs = 180000) {
  return new Promise(resolve => {
    const child = spawn(program, args, { cwd: root, env: { ...safeEnv, ...extra }, stdio: 'inherit', windowsHide: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once('error', () => { clearTimeout(timer); resolve({ code: -1, timedOut }); });
    child.once('exit', code => { clearTimeout(timer); resolve({ code: code ?? -1, timedOut }); });
  });
}
async function ready() {
  const start = performance.now();
  while (performance.now() - start < 90000) {
    const result = await run('docker', [...compose, 'exec', '-T', 'worker', 'node', '-e', "fetch('http://127.0.0.1:8082/readyz',{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], {}, 5000);
    if (result.code === 0) return { ready: true, readinessMs: Math.round(performance.now() - start) };
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return { ready: false, readinessMs: Math.round(performance.now() - start) };
}
async function bench(label, attempts, regression = false, timeoutMs = 7200000) {
  const before = new Set(await readdir(directory));
  const result = await run(process.execPath, ['scripts/voice-local.mjs', 'bench'], {
    VOICE_BENCH_LABEL: label, VOICE_BENCH_FIRST_TURN: String(attempts), VOICE_BENCH_WARMUP: '0',
    VOICE_BENCH_ITERATIONS: regression ? '2' : '0', VOICE_BENCH_REPEAT_SESSIONS: regression ? '1' : '0', VOICE_BENCH_FAILURE_RUNS: regression ? '1' : '0',
  }, timeoutMs);
  const reportFile = (await readdir(directory)).find(name => !before.has(name) && name.startsWith(label + '-') && name.endsWith('.json'));
  if (!reportFile) return { ...result, reportMissing: true, unaccounted: attempts };
  const report = JSON.parse(await readFile(path.join(directory, reportFile), 'utf8'));
  return { ...result, reportFile, ...reliabilityResults(report.records, attempts, regression) };
}
const loadName = 'dialog-voice-1rg-controlled-load';
let loadStarted = false;
try {
  if (group === 'stressed') {
    const result = await run('docker', ['run', '-d', '--rm', '--name', loadName, '--cpus', '3.5', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      'node:24-bookworm@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a', 'node', '-e', "const {Worker}=require('node:worker_threads');for(let i=0;i<4;i++)new Worker('for(;;){}',{eval:true})"]);
    await record({ event: 'controlled_load', cpus: 3.5, loops: 4, ...result });
    if (result.code !== 0) throw new Error('Controlled CPU load did not start');
    loadStarted = true;
  }
  const rounds = group === 'cold' ? 10 : 1;
  for (let round = 1; round <= rounds; round++) {
    const start = performance.now();
    if (group === 'cold') {
      const restartingAt = performance.now();
      const restarted = await run('docker', [...compose, 'restart', 'worker']);
      await record({ event: 'restart', round, restartMs: Math.round(performance.now() - restartingAt), ...restarted });
      if (restarted.code !== 0) { process.exitCode = 1; continue; }
    }
    const readiness = await ready();
    await record({ event: 'readiness', round, ...readiness });
    if (!readiness.ready) { process.exitCode = 1; continue; }
    if (group === 'outage' || group === 'lease-expiry') {
      const previous = new Set((await workerEvidence()).filter(value => value.event === 'subscription_ready').map(value => value.diagnosticId));
      const population = bench(`1rg-${group}-${round}`, 1, false, 180000);
      let diagnosticId, injected = false, restored = false;
      try {
        const deadline = performance.now() + 45000;
        while (performance.now() < deadline) {
          const events = await workerEvidence();
          const current = events.find(value => value.event === 'subscription_ready' && value.diagnosticId && !previous.has(value.diagnosticId));
          if (current && !events.some(value => value.diagnosticId === current.diagnosticId && value.event === 'livekit_session_closing')) { diagnosticId = current.diagnosticId; break; }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (diagnosticId) {
          const action = group === 'outage' ? ['stop', '--timeout', '5', 'livekit'] : ['pause', 'worker'];
          const fault = await run('docker', [...compose, ...action], {}, 15000);
          injected = fault.code === 0;
          await record({ event: 'lifecycle_fault', group, diagnosticId, injected, ...fault });
          if (injected) await new Promise(resolve => setTimeout(resolve, group === 'outage' ? 5000 : 18000));
        }
      } finally {
        const action = group === 'outage' ? ['start', 'livekit'] : ['unpause', 'worker'];
        const restoration = await run('docker', [...compose, ...action], {}, 30000);
        restored = restoration.code === 0 && !restoration.timedOut;
        await record({ event: 'lifecycle_restore', group, ...restoration });
      }
      const result = await population;
      const closed = (await workerEvidence()).find(value => value.diagnosticId === diagnosticId && value.event === 'livekit_session_closed');
      const passed = lifecyclePassed(result, injected, Boolean(closed), restored);
      await record({ event: 'lifecycle_result', group, injected, restored, cleanupConfirmed: Boolean(closed), lifecyclePassed: passed, reason: closed?.reason ?? null, ...result });
      if (!passed) process.exitCode = 1;
      continue;
    }
    const attempts = group === 'normal' ? 100 : group === 'stressed' ? 50 : group === 'cold' ? 1 : 0;
    const result = await bench(`1rg-${group}-${round}`, attempts, group === 'regression');
    await record({ event: 'population', group, round, plannedAttempts: attempts, elapsedMs: Math.round(performance.now() - start), ...result });
    if (result.code !== 0 || result.reportMissing || !result.populationPassed) process.exitCode = 1;
    if (result.harnessErrors || result.reportMissing || result.unaccounted) break; // Host/harness failure leaves a visibly incomplete run.
  }
} finally {
  if (loadStarted) await record({ event: 'controlled_load_cleanup', ...await run('docker', ['stop', '--timeout', '1', loadName]) });
  await retainWorkerEvidence();
}
