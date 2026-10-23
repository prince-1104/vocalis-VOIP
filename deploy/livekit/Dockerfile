FROM node:24-bookworm@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a AS dependencies
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY artifacts/api-server/package.json artifacts/api-server/package.json
COPY artifacts/livekit-agent/package.json artifacts/livekit-agent/package.json
COPY artifacts/sales-sutra/package.json artifacts/sales-sutra/package.json
COPY artifacts/mockup-sandbox/package.json artifacts/mockup-sandbox/package.json
COPY lib/db/package.json lib/db/package.json
COPY lib/api-spec/package.json lib/api-spec/package.json
COPY lib/api-client-react/package.json lib/api-client-react/package.json
COPY lib/api-zod/package.json lib/api-zod/package.json
COPY lib/observability/package.json lib/observability/package.json
COPY lib/integrations-openai-ai-server/package.json lib/integrations-openai-ai-server/package.json
COPY lib/integrations-openai-ai-react/package.json lib/integrations-openai-ai-react/package.json
COPY scripts/package.json scripts/package.json
RUN --mount=type=cache,id=dialog-voice-pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --ignore-scripts
# CPU ONNX binaries ship in the package. Never invoke its optional CUDA downloader.
RUN cd artifacts/livekit-agent && node -e "const r=require('node:module').createRequire(require.resolve('@livekit/agents-plugin-silero'));if(!r('onnxruntime-node').InferenceSession)process.exit(1)"
FROM dependencies AS runtime
COPY . .
RUN pnpm --filter @workspace/livekit-agent build
CMD ["node", "artifacts/livekit-agent/dist/server.js"]

