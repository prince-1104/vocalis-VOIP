import { build } from "esbuild";
import path from "node:path";
await build({ entryPoints: ['logger', 'operational-metrics'].map(name => path.resolve('../../lib/observability/src', name + '.ts')),
  outdir: '../../lib/observability/dist', bundle: true, packages: 'external', platform: 'node', target: 'node24', format: 'esm' });
await build({ entryPoints: ["src/server.ts", "src/agent.ts"], outdir: "dist", bundle: true,
  platform: "node", target: "node24", format: "esm", packages: "external", sourcemap: true });
