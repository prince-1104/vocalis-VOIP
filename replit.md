# Workspace

## Overview

**SalesSutra** — AI Voice Agent + Auto-Dialer SaaS platform for small businesses.

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Frontend**: React + Vite, Tailwind CSS, shadcn/ui, React Query, Recharts

## SalesSutra Features

- **Dashboard** — Key metrics (total calls, answer rate, leads, callbacks), recent calls, quick actions
- **Contacts** — Full CRUD, CSV import, status tracking (pending/called/interested/not_interested/callback)
- **Campaigns** — Create and manage outbound call campaigns with start/pause controls
- **Call Logs** — Complete history of inbound & outbound calls with outcomes and AI summaries
- **AI Agent** — Configure agent name, voice (OpenAI TTS voices), personality, Twilio integration
- **Training** — Add product info, FAQs, objection handling, competitor info to train the AI agent
- **Scripts** — Create and manage calling scripts with opening lines, pitch points, closing lines
- **Analytics** — Charts (calls by day, outcome breakdown), conversion funnel, key metrics

## Auth Strategy

Uses Replit Auth in production (reads `x-replit-user-id` and `x-replit-user-name` headers).
Falls back to a "demo-user" in development/preview mode for easy testing.
Multi-tenant: each user gets isolated data.

## Calling Integration

Full **Twilio + OpenAI** AI voice agent implemented end-to-end:

### Inbound Calls (TwiML webhook flow)
1. Twilio POSTs to `POST /api/twilio/inbound` → responds with TwiML greeting + `<Gather input="speech">`
2. Caller speaks → Twilio STT transcribes → POSTs to `POST /api/twilio/voice?userId=&callLogId=&history=`
3. OpenAI `gpt-5.2` generates a contextual response using agent config + training data + calling scripts
4. Response returned as TwiML `<Say>` + next `<Gather>` for continued conversation loop
5. Call ends → Twilio POSTs to `POST /api/twilio/status` → call log updated in DB

### Outbound Calls (REST API trigger)
- `POST /api/contacts/:id/dial` — triggers a single call to a specific contact
- `POST /api/campaigns/:id/dial-next` — dials the next pending contact in a campaign
- Twilio REST API creates the call; webhook handles conversation via `POST /api/twilio/outbound-voice`
- Campaign completion auto-detected: marks campaign `completed` when all contacts dialed

### Voice Mapping
OpenAI voices (alloy/echo/fable/onyx/nova/shimmer) are mapped to Amazon Polly voices for TwiML `<Say>`.

### Multi-tenant Webhook Resolution
Inbound calls are routed to the correct user account by matching the Twilio `To` phone number
against stored `agent_configs.phone_number`. Falls back to `demo-user` if no match.

### Webhook URLs (shown in-app on AI Agent page)
- Voice URL: `{baseUrl}/api/twilio/inbound`
- Status Callback: `{baseUrl}/api/twilio/status`

Users configure Twilio Account SID + Auth Token + Phone Number in AI Agent settings.
Google Voice users are instructed to forward their GV number to the Twilio number.

### OpenAI Integration
Uses `@workspace/integrations-openai-ai-server` (Replit AI Integrations proxy).
AI system prompt is dynamically built from: agent persona + training data + default calling script.

## Structure

```text
artifacts-monorepo/
├── artifacts/
│   ├── api-server/         # Express API server (all routes)
│   └── sales-sutra/        # React + Vite frontend (SalesSutra UI)
├── lib/
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── scripts/                # Utility scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json
└── package.json
```

## Database Schema

- `users` — Multi-tenant users (linked to Replit user IDs)
- `contacts` — Phone contact lists per user
- `campaigns` — Outbound calling campaigns
- `campaign_contacts` — Junction table linking campaigns to contacts
- `call_logs` — All call history (inbound + outbound)
- `agent_configs` — AI agent configuration per user
- `training_data` — Product info, FAQs, scripts used to train the AI
- `calling_scripts` — Saved calling scripts per user

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references.

- **Always typecheck from the root** — run `pnpm run typecheck`
- **`emitDeclarationOnly`** — we only emit `.d.ts` files during typecheck
- **Project references** — when package A depends on package B, A's `tsconfig.json` must list B in its `references` array

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages that define it
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API client + Zod schemas
- `pnpm --filter @workspace/db run push` — push DB schema changes to PostgreSQL
