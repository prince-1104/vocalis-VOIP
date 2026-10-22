# Dialog CRM Connect — Integration Guide

> **Version**: 1.0 | **Last Updated**: June 2026
> **For**: External CRM developers who want to integrate their CRM with Dialog AI Voice Platform

---

## Table of Contents

1. [What is Dialog?](#what-is-dialog)
2. [Architecture Overview](#architecture-overview)
3. [Integration Capabilities](#integration-capabilities)
4. [Prerequisites — What You Need Before Starting](#prerequisites)
5. [Step-by-Step Integration Guide](#step-by-step-integration-guide)
6. [API Reference](#api-reference)
7. [Webhook Events Reference](#webhook-events-reference)
8. [WebSocket Real-Time Streaming](#websocket-real-time-streaming)
9. [Transfer Rules & Intent System](#transfer-rules--intent-system)
10. [Campaign Management from CRM](#campaign-management-from-crm)
11. [Security & Authentication](#security--authentication)
12. [Example Integration Flows](#example-integration-flows)
13. [FAQ & Troubleshooting](#faq--troubleshooting)

---

## What is Dialog?

Dialog is an AI-powered voice calling platform that handles inbound and outbound phone calls using AI agents. It can:

- **Answer inbound calls** with an AI agent that understands caller intent
- **Make outbound calls** to contacts/leads with AI-driven conversations  
- **Detect caller intent** (pricing query, complaint, interested, etc.) in real-time
- **Auto-transfer calls** to human specialists based on detected intent
- **Stream live transcripts** during calls
- **Generate call summaries** with AI after calls end
- **Support 6 Indian languages** (English, Hindi, Kannada, Tamil, Telugu, Marathi)

Your CRM can integrate with Dialog to trigger calls, receive real-time events, and manage transfers — all through a REST API + Webhooks + WebSocket.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          YOUR CRM SYSTEM                                │
│                                                                         │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────┐  ┌──────────────┐  │
│  │  Lead     │  │  Call Trigger │  │  Webhook       │  │  WebSocket   │  │
│  │  Records  │  │  Module      │  │  Receiver      │  │  Client      │  │
│  └──────────┘  └──────┬───────┘  └───────▲────────┘  └──────▲───────┘  │
│                       │                  │                   │          │
└───────────────────────┼──────────────────┼───────────────────┼──────────┘
                        │                  │                   │
                   REST API             Webhooks           WebSocket
                  (HTTPS)              (HTTPS POST)         (WSS)
                        │                  │                   │
┌───────────────────────▼──────────────────┴───────────────────┴──────────┐
│                       DIALOG AI PLATFORM                                │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    API Gateway (Port 3003)                       │   │
│  │  • Bearer Token Authentication (dk_live_xxx)                    │   │
│  │  • Scope-based Authorization                                    │   │
│  │  • Rate Limiting                                                │   │
│  └─────────┬────────────┬────────────┬────────────┬────────────────┘   │
│            │            │            │            │                     │
│  ┌─────────▼──┐  ┌──────▼─────┐  ┌──▼──────────┐ ┌▼──────────────┐   │
│  │ Call       │  │ Agent      │  │ Campaign    │ │ Webhook       │   │
│  │ Manager   │  │ Registry   │  │ Engine      │ │ Dispatcher    │   │
│  │           │  │            │  │             │ │               │   │
│  │ • Dial    │  │ • Register │  │ • Create    │ │ • 3 retries   │   │
│  │ • Transfer│  │ • Route    │  │ • Bulk dial │ │ • HMAC sign   │   │
│  │ • End     │  │ • Load bal │  │ • Track     │ │ • Exp backoff │   │
│  └─────┬─────┘  └──────┬─────┘  └─────────────┘ └───────────────┘   │
│        │               │                                               │
│  ┌─────▼───────────────▼──────────────────────────────────────────┐   │
│  │                     AI Voice Engine                             │   │
│  │  • LLM: GPT-4o-mini / DeepSeek / Sarvam-M                    │   │
│  │  • TTS: OpenAI TTS-1 / Sarvam Bulbul v3                      │   │
│  │  • STT: Twilio Speech / Sarvam Saaras v3                     │   │
│  │  • Intent Classifier (GPT-4o-mini)                            │   │
│  └─────────────────────┬──────────────────────────────────────────┘   │
│                        │                                               │
│  ┌───────────────────────────────▼────────────────────────────────┐   │
│  │                     Twilio (Telephony)                          │   │
│  │  • PSTN calls (inbound + outbound)                             │   │
│  │  • Conference rooms for transfers                              │   │
│  │  • Call recording                                              │   │
│  └────────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────────┘
```

### Data Flow During a Call

```
1. CRM sends POST /api/crm/calls → Dialog initiates Twilio call
2. Caller picks up → AI greets caller
3. Each conversation turn:
   a. Caller speaks → Twilio STT → text
   b. AI generates response → Twilio TTS → audio
   c. Intent classifier runs → detects intent
   d. Dialog emits webhook event → Your CRM receives it
   e. If intent matches transfer rule → call transferred to human agent
4. Call ends → Dialog emits call.ended webhook with full transcript + summary
5. CRM queries GET /api/crm/calls/:id → gets complete call record
```

---

## Integration Capabilities

| Capability | Description | Method |
|---|---|---|
| **Trigger outbound calls** | Start AI calls from your CRM to any phone number | REST API |
| **Receive call events** | Get notified of every call turn, intent, transfer, end | Webhooks |
| **Live transcript streaming** | Watch the conversation happen in real-time | WebSocket |
| **Transfer to human agents** | Route calls to specialists based on intent | REST API + Auto |
| **Bulk campaigns** | Create calling campaigns with contact lists | REST API |
| **Get call records** | Retrieve transcripts, summaries, recordings, costs | REST API |
| **Manage agent availability** | Set agents online/offline for transfers | REST API |

---

## Prerequisites

Before your CRM can connect to Dialog, the Dialog tenant admin needs to:

### 1. Have a Dialog Account with Twilio Configured
- Dialog must have an active tenant with Twilio credentials (Account SID, Auth Token, Phone Number)
- The AI Agent should be configured (personality, greeting, language, model)

### 2. Generate a CRM API Key
This is done from Dialog's admin panel:
1. Go to **Dialer → API Integration** tab
2. Click **"Generate Key"**
3. Enter a name (e.g., "Salesforce Production")
4. **Copy the key immediately** — it's shown only once!

The key format is: `dk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

### 3. Share These Details With Your CRM Developer

| Detail | Value | Example |
|---|---|---|
| **Base URL** | Dialog server URL | `https://dialog.yourdomain.com` |
| **API Key** | The generated key | `dk_live_a1b2c3d4...` |
| **Webhook Secret** | Auto-generated with the key | `e5f6g7h8...` (for verifying webhook payloads) |

---

## Step-by-Step Integration Guide

### Step 1: Generate API Key

The Dialog tenant admin generates this for you from their dashboard. You'll receive:
- `API_KEY` — for authenticating all API requests
- `WEBHOOK_SECRET` — for verifying webhook payloads

### Step 2: Register Your Webhook URL

Tell Dialog where to send call events:

```bash
curl -X POST https://dialog.yourdomain.com/api/crm/webhooks \
  -H "Authorization: Bearer dk_live_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "webhookUrl": "https://your-crm.com/api/dialog-webhook"
  }'
```

**Response:**
```json
{
  "webhookUrl": "https://your-crm.com/api/dialog-webhook",
  "webhookSecret": "abc123def456...",
  "message": "Webhook configured. Use X-Dialog-Signature header to verify payloads."
}
```

### Step 3: Register Human Agents (for Call Transfers)

Register the human agents in your organization who can receive transferred calls:

```bash
curl -X POST https://dialog.yourdomain.com/api/crm/agents \
  -H "Authorization: Bearer dk_live_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "crmAgentId": "agent-billing-1",
    "name": "Priya Sharma",
    "phone": "+919876543210",
    "specialization": "Billing & Accounts",
    "intents": ["billing", "complaint", "pricing_query"],
    "maxConcurrentCalls": 3
  }'
```

**What each field means:**

| Field | Required | Description |
|---|---|---|
| `crmAgentId` | ✅ | Your CRM's unique ID for this agent |
| `name` | ✅ | Agent's display name |
| `phone` | ⚠️ | Agent's phone number — **required for call transfers** |
| `specialization` | ❌ | Description of what this agent handles |
| `intents` | ❌ | List of intents that should route to this agent (see [Intent System](#transfer-rules--intent-system)) |
| `maxConcurrentCalls` | ❌ | Max simultaneous calls this agent can handle (default: 3) |

### Step 4: Build Your Webhook Receiver

Your CRM needs an HTTP endpoint that receives POST requests from Dialog:

```python
# Python/Flask example
from flask import Flask, request, jsonify
import hmac, hashlib

app = Flask(__name__)
WEBHOOK_SECRET = "your_webhook_secret_from_step_2"

@app.route("/api/dialog-webhook", methods=["POST"])
def handle_dialog_event():
    # 1. Verify signature
    signature = request.headers.get("X-Dialog-Signature", "")
    expected = "sha256=" + hmac.new(
        WEBHOOK_SECRET.encode(), request.data, hashlib.sha256
    ).hexdigest()
    
    if not hmac.compare_digest(signature, expected):
        return jsonify({"error": "Invalid signature"}), 401
    
    # 2. Process the event
    event = request.json
    event_type = event["event"]
    call_id = event["callId"]
    data = event["data"]
    metadata = event.get("metadata", {})  # Your CRM metadata echoed back
    
    if event_type == "call.ringing":
        # Update CRM: call is being placed
        update_lead_status(metadata.get("leadId"), "calling")
    
    elif event_type == "call.turn":
        # Real-time conversation turn
        role = data["role"]       # "user" or "assistant"
        content = data["content"] # What was said
        save_transcript_entry(call_id, role, content)
    
    elif event_type == "call.intent":
        # AI detected caller's intent
        intent = data["intent"]         # e.g., "pricing_query"
        confidence = data["confidence"] # 0.0 - 1.0
        needs_human = data["needsHuman"]
        update_lead_intent(metadata.get("leadId"), intent)
    
    elif event_type == "call.transferring":
        # Call is being transferred to a human agent
        transfer_to = data["transferTo"]
        reason = data["reason"]
        log_transfer(call_id, transfer_to, reason)
    
    elif event_type == "call.ended":
        # Call completed
        outcome = data["outcome"]       # "answered", "no_answer", "busy"
        duration = data["duration"]
        transcript = data.get("transcript")
        ai_summary = data.get("aiSummary")
        cost = data.get("estimatedCostUsd")
        
        update_lead_call_result(
            metadata.get("leadId"),
            outcome=outcome,
            duration=duration,
            transcript=transcript,
            summary=ai_summary,
            cost=cost,
        )
    
    return jsonify({"received": True}), 200
```

```javascript
// Node.js/Express example
const crypto = require('crypto');
const express = require('express');
const app = express();

const WEBHOOK_SECRET = 'your_webhook_secret_from_step_2';

app.post('/api/dialog-webhook', express.json(), (req, res) => {
  // 1. Verify signature
  const signature = req.headers['x-dialog-signature'] || '';
  const expected = 'sha256=' + crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(JSON.stringify(req.body))
    .digest('hex');
  
  if (signature !== expected) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  // 2. Process the event
  const { event, callId, data, metadata } = req.body;
  
  switch (event) {
    case 'call.ringing':
      console.log(`Call ${callId} is ringing`);
      break;
    case 'call.turn':
      console.log(`[${data.role}]: ${data.content}`);
      break;
    case 'call.intent':
      console.log(`Intent: ${data.intent} (${data.confidence})`);
      break;
    case 'call.ended':
      console.log(`Call ended: ${data.outcome}, ${data.duration}s`);
      // Save transcript and summary to your CRM
      break;
  }
  
  res.json({ received: true });
});
```

### Step 5: Trigger Calls from Your CRM

```bash
curl -X POST https://dialog.yourdomain.com/api/crm/calls \
  -H "Authorization: Bearer dk_live_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+919876543210",
    "crmContactId": "lead-12345",
    "metadata": {
      "leadId": "lead-12345",
      "leadName": "Rajesh Kumar",
      "dealStage": "qualification",
      "product": "Enterprise Plan"
    },
    "transferRules": {
      "intents": ["pricing_query", "complaint", "escalation"],
      "maxAiTurns": 8,
      "transferTo": "+919999888877"
    }
  }'
```

**Response:**
```json
{
  "callId": 42,
  "callSid": "CA1234567890abcdef",
  "status": "dialing",
  "streamUrl": "wss://dialog.yourdomain.com/ws/crm/calls/42"
}
```

---

## API Reference

All API requests require:
```
Authorization: Bearer dk_live_your_key_here
Content-Type: application/json
```

### Calls

| Method | Endpoint | Description | Scopes Required |
|---|---|---|---|
| `POST` | `/api/crm/calls` | Initiate an outbound AI call | `calls:write` |
| `GET` | `/api/crm/calls/:id` | Get call details + transcript | `calls:read` |
| `GET` | `/api/crm/calls/:id/transcript` | Get live/final transcript | `calls:read` |
| `POST` | `/api/crm/calls/:id/transfer` | Transfer an active call to agent | `calls:write` |
| `POST` | `/api/crm/calls/:id/end` | Force-end an active call | `calls:write` |

### Agents

| Method | Endpoint | Description | Scopes Required |
|---|---|---|---|
| `GET` | `/api/crm/agents` | List all registered agents | `calls:read` |
| `POST` | `/api/crm/agents` | Register/update a CRM agent | `calls:write` |
| `PATCH` | `/api/crm/agents/:agentId/availability` | Set agent online/offline | `calls:write` |

### Webhooks

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/crm/webhooks` | Register/update webhook URL |
| `GET` | `/api/crm/webhooks/deliveries` | View recent webhook delivery logs |

### Campaigns

| Method | Endpoint | Description | Scopes Required |
|---|---|---|---|
| `POST` | `/api/crm/campaigns` | Create a calling campaign | `campaigns:write` |
| `POST` | `/api/crm/campaigns/:id/start` | Activate a campaign | `campaigns:write` |
| `GET` | `/api/crm/campaigns/:id/status` | Get campaign progress | `campaigns:read` |

---

### Detailed API: POST /api/crm/calls

**Request Body:**
```json
{
  "phone": "+919876543210",           // REQUIRED: Phone number to call
  "crmContactId": "lead-12345",       // Optional: Your CRM's contact/lead ID
  "campaignId": 5,                    // Optional: Link to a Dialog campaign
  "metadata": {                       // Optional: Echoed back in all webhooks
    "leadId": "lead-12345",
    "dealStage": "qualification",
    "customField": "anything you want"
  },
  "transferRules": {                  // Optional: Auto-transfer configuration
    "intents": ["pricing_query"],     // Transfer when these intents are detected
    "maxAiTurns": 8,                  // Transfer after N AI turns if unresolved
    "transferTo": "+919999888877",    // Specific phone to transfer to
    "crmAgentId": "agent-sales-1"    // Or route to a registered CRM agent
  }
}
```

**Response:**
```json
{
  "callId": 42,                       // Dialog's internal call ID
  "callSid": "CA1234567890abcdef",    // Twilio Call SID
  "status": "dialing",
  "streamUrl": "wss://host/ws/crm/calls/42"  // WebSocket URL for live events
}
```

---

### Detailed API: GET /api/crm/calls/:id

**Response (after call completes):**
```json
{
  "callId": 42,
  "callSid": "CA1234567890abcdef",
  "phone": "+919876543210",
  "direction": "outbound",
  "status": "completed",
  "outcome": "answered",
  "duration": 145,
  "transcript": "Full conversation transcript...",
  "liveTranscript": [
    { "role": "assistant", "content": "Hi, this is Dialog AI...", "timestamp": "..." },
    { "role": "user", "content": "Yes, I'm interested...", "timestamp": "..." }
  ],
  "aiSummary": "The caller expressed interest in the Enterprise plan...",
  "recordingUrl": "https://...",
  "crmContactId": "lead-12345",
  "crmMetadata": { "leadId": "lead-12345", "dealStage": "qualification" },
  "transferredTo": "+919999888877",
  "transferReason": "Intent pricing_query matched transfer rule",
  "transferredAt": "2026-06-07T10:30:00Z",
  "estimatedCostUsd": "0.032",
  "billedCostUsd": "0.035",
  "startedAt": "2026-06-07T10:28:00Z",
  "endedAt": "2026-06-07T10:30:25Z"
}
```

---

### Detailed API: POST /api/crm/calls/:id/transfer

**Request Body:**
```json
{
  "crmAgentId": "agent-sales-1",      // Registered agent ID (auto-resolves phone)
  // OR
  "transferTo": "+919999888877",      // Direct phone number
  
  "reason": "Pricing negotiation requires human",
  "transferType": "cold",             // "cold" (default) or "warm"
  "briefingMessage": "The caller is asking about Enterprise pricing..."  // For warm transfers
}
```

---

### Detailed API: POST /api/crm/campaigns

**Request Body:**
```json
{
  "name": "Q3 Sales Outreach",
  "description": "Contact qualified leads for enterprise demo",
  "contacts": [
    { "phone": "+919876543210", "firstName": "Rajesh", "lastName": "Kumar" },
    { "phone": "+919876543211", "firstName": "Priya", "lastName": "Sharma" },
    { "phone": "+919876543212", "firstName": "Amit", "company": "TechCorp" }
  ],
  "startTime": "09:00",
  "endTime": "17:00",
  "timezone": "Asia/Kolkata",
  "maxConcurrentCalls": 2
}
```

---

## Webhook Events Reference

When you register a webhook URL, Dialog POSTs JSON events to it. Every payload includes:

```json
{
  "event": "call.turn",                 // Event type
  "callId": 42,                         // Dialog's call ID
  "callSid": "CA1234567890abcdef",      // Twilio Call SID
  "data": { ... },                      // Event-specific data
  "metadata": { "leadId": "lead-12345" }, // Your CRM metadata echoed back
  "timestamp": "2026-06-07T10:28:15Z"
}
```

**Headers sent with each webhook:**
| Header | Description |
|---|---|
| `Content-Type` | `application/json` |
| `X-Dialog-Signature` | HMAC-SHA256 signature for verification |
| `X-Dialog-Event` | Event type (e.g., `call.turn`) |
| `X-Dialog-Delivery-Id` | Unique delivery ID for deduplication |

### Event Types

#### `call.ringing`
Fired when Dialog starts dialing the phone number.
```json
{ "data": { "phone": "+919876543210", "campaignId": 5 } }
```

#### `call.turn`
Fired for every conversation turn (what was said by caller and AI).
```json
{
  "data": {
    "role": "user",           // "user" (caller) or "assistant" (AI)
    "content": "I want to know about pricing",
    "turnIndex": 3,
    "language": "en-US"       // Detected language
  }
}
```

#### `call.intent`
Fired when AI classifies the caller's intent.
```json
{
  "data": {
    "intent": "pricing_query",   // See intent list below
    "confidence": 0.92,          // 0.0 - 1.0
    "needsHuman": false,
    "turnCount": 4
  }
}
```

#### `call.transferring`
Fired when a call transfer begins.
```json
{
  "data": {
    "transferTo": "+919999888877",
    "reason": "Intent \"pricing_query\" matched transfer rule (confidence: 0.92)",
    "intent": "pricing_query",
    "crmAgentId": "agent-sales-1"
  }
}
```

#### `call.transferred`
Fired when the transfer call connects.
```json
{
  "data": {
    "conferenceSid": "crm-transfer-42-1717123456",
    "agentCallSid": "CA0987654321fedcba",
    "transferTo": "+919999888877"
  }
}
```

#### `call.ended`
Fired when the call is completed. Contains the complete transcript and AI summary.
```json
{
  "data": {
    "outcome": "answered",         // "answered", "no_answer", "busy"
    "duration": 145,               // seconds
    "transcript": "Full text...",
    "aiSummary": "The caller...",
    "estimatedCostUsd": "0.032",
    "billedCostUsd": "0.035",
    "liveTranscript": [
      { "role": "assistant", "content": "Hi...", "timestamp": "..." },
      { "role": "user", "content": "I need...", "timestamp": "..." }
    ]
  }
}
```

#### `call.error`
Fired if an error occurs during the call.
```json
{ "data": { "error": "Transfer failed: Agent phone not reachable" } }
```

### Webhook Delivery & Retries

- **3 delivery attempts** with exponential backoff: 10s → 60s → 5 minutes
- Your endpoint must return HTTP `2xx` within **10 seconds** to be considered successful
- Failed deliveries are logged and can be inspected via `GET /api/crm/webhooks/deliveries`

---

## WebSocket Real-Time Streaming

For lower-latency event streaming (ideal for live call dashboards in your CRM):

### Connection

```javascript
// Connect to stream events for a specific call
const ws = new WebSocket(
  "wss://dialog.yourdomain.com/ws/crm/calls/42?apiKey=dk_live_your_key_here"
);

// OR stream ALL call events for your tenant
const ws = new WebSocket(
  "wss://dialog.yourdomain.com/ws/crm/calls?apiKey=dk_live_your_key_here"
);

ws.onopen = () => console.log("Connected to Dialog live stream");

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  if (data.type === "connected") {
    console.log("Streaming started:", data.message);
    return;
  }
  
  // Same event format as webhooks
  switch (data.type) {
    case "call.turn":
      console.log(`[${data.data.role}]: ${data.data.content}`);
      break;
    case "call.intent":
      console.log(`Intent detected: ${data.data.intent}`);
      break;
    case "call.ended":
      console.log("Call completed:", data.data.outcome);
      break;
  }
};
```

### WebSocket vs Webhooks

| Feature | WebSocket | Webhook |
|---|---|---|
| Latency | ~50ms (real-time) | ~200ms-2s |
| Reliability | No retries, connection can drop | 3 retries with backoff |
| Use case | Live dashboards, real-time UIs | Backend processing, logging |
| Recommendation | Use for **live features** | Use for **data persistence** |

**Best Practice:** Use **both** — WebSocket for live UI updates, webhooks for reliable data sync.

---

## Transfer Rules & Intent System

### Supported Intents

Dialog's AI classifier can detect these caller intents:

| Intent | Description | Example Caller Statement |
|---|---|---|
| `greeting` | Initial greeting | "Hello, hi" |
| `product_inquiry` | Asking about products/services | "What do you offer?" |
| `pricing_query` | Asking about pricing | "How much does it cost?" |
| `complaint` | Filing a complaint | "I'm unhappy with the service" |
| `technical_support` | Technical issues | "The app isn't working" |
| `billing` | Billing/payment questions | "I was charged twice" |
| `appointment` | Scheduling a meeting | "Can I book a demo?" |
| `interested` | Expressing buying interest | "I'd like to sign up" |
| `not_interested` | Declining | "Not interested, thanks" |
| `callback_request` | Asking for a callback | "Can someone call me back?" |
| `escalation` | Demanding a manager | "Let me speak to your manager" |
| `general_question` | General inquiry | "Where are you located?" |
| `follow_up` | Following up on previous interaction | "I called yesterday about..." |
| `objection_handling` | Raising objections | "It's too expensive" |

### Auto-Transfer Logic (AI-First Approach)

Dialog uses an **AI-first approach** to call routing. When a caller's intent is classified as matching one of the transfer rules, the AI does **not** transfer immediately. Instead, it first attempts to resolve the caller's request using **intent-specific training data** (configured in the Dialog Admin Panel). 

The call is only transferred to a human agent when one of the following safety/transfer thresholds is met:

1. **Explicit Human Request**: If the caller explicitly asks to speak to a human or agent (e.g. *"let me talk to a real person"* or *"connect me to an agent"*) **2 or more times** (or the configured threshold), Dialog initiates the transfer immediately.
2. **Per-Intent Turn Limit**: Each intent has a `maxTurns` limit (default: `8`). If the AI and caller have exchanged `maxTurns` number of utterances for that specific intent, and the issue remains unresolved, Dialog auto-transfers the call.
3. **Classifier Escalation**: If the AI classifier determines that the request is highly complex (e.g. billing disputes, severe complaints) and indicates `needsHuman` with a confidence score of $\ge 0.8$, the transfer is triggered.
4. **Global Safety Net**: If the call duration reaches the global `maxAiTurns` (configured in the API call), the call is auto-transferred as a fallback.

#### Twilio Native Hold Music during Transfer
When a transfer is initiated, the caller hears a native-telephony transfer message, and is then placed into a Twilio Conference room with a looping, localized queue message and hold music (powered by Twilio `<Say>` and Polly TTS). 
* **Zero TTS Cost**: Because hold music is played natively through Twilio's telephony infrastructure, it **does not consume any external TTS API charges** (e.g. OpenAI/Sarvam TTS) while the caller waits in the queue.
* **Multi-Language Support**: The hold message automatically matches the detected language of the call (English, Hindi, Kannada, Tamil, Telugu, Marathi).

### Transfer Rules Configuration

```json
{
  "transferRules": {
    "intents": ["complaint", "escalation", "billing"],
    "maxAiTurns": 8,
    "humanRequestThreshold": 2,       // Optional: Default 2
    "transferTo": "+919999888877",    // Specific phone override to transfer to
    "crmAgentId": "agent-billing-1"   // Or route to a specific registered CRM agent
  }
}
```

| Field | Description |
|---|---|
| `intents` | Intents that can trigger a transfer after AI tries using intent training data first |
| `maxAiTurns` | Global safety net: transfer after N total AI turns if the issue isn't resolved |
| `humanRequestThreshold` | Transfer immediately if caller explicitly asks for a human N times (default: 2) |
| `transferTo` | Specific phone number to transfer to (overrides agent routing) |
| `crmAgentId` | Registered CRM Agent ID — Dialog looks up their phone number and specializes routing |

**Priority:** If both `transferTo` and `crmAgentId` are specified, `transferTo` takes precedence. If neither is specified, Dialog uses the `findBestAgent` algorithm to pick from registered agents whose specializations match the caller's detected intent.

---

## Campaign Management from CRM

Create bulk calling campaigns directly from your CRM:

```bash
# 1. Create campaign with contacts
curl -X POST https://dialog.yourdomain.com/api/crm/campaigns \
  -H "Authorization: Bearer dk_live_your_key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "June Sales Drive",
    "contacts": [
      { "phone": "+919876543210", "firstName": "Rajesh" },
      { "phone": "+919876543211", "firstName": "Priya" }
    ],
    "startTime": "09:00",
    "endTime": "17:00",
    "timezone": "Asia/Kolkata",
    "maxConcurrentCalls": 2
  }'

# Response: { "campaignId": 5, "status": "draft" }

# 2. Start the campaign
curl -X POST https://dialog.yourdomain.com/api/crm/campaigns/5/start \
  -H "Authorization: Bearer dk_live_your_key"

# 3. Check progress
curl https://dialog.yourdomain.com/api/crm/campaigns/5/status \
  -H "Authorization: Bearer dk_live_your_key"

# Response:
# { "stats": { "total": 50, "called": 23, "answered": 18, "interested": 7 } }
```

---

## Security & Authentication

### API Key Authentication

All requests must include:
```
Authorization: Bearer dk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- Keys are **hashed with SHA-256** before storage — Dialog never stores plaintext keys
- Keys can be **revoked** from Dialog's admin panel
- Each key has **scopes** that limit what it can do:
  - `calls:read` — read call data and transcripts
  - `calls:write` — initiate calls, transfers, agent registration
  - `campaigns:read` — read campaign status
  - `campaigns:write` — create and start campaigns

### Webhook Signature Verification

Every webhook POST includes an `X-Dialog-Signature` header:

```
X-Dialog-Signature: sha256=a1b2c3d4e5f6...
```

**Verification formula:**
```
expected = "sha256=" + HMAC-SHA256(webhook_secret, raw_request_body)
```

⚠️ **Always verify the signature** before processing webhook data.

---

## Example Integration Flows

### Flow 1: Simple Outbound Call with Callback

```
CRM                                  Dialog
 │                                     │
 ├── POST /api/crm/calls ───────────►  │  (Start call)
 │   { phone, metadata }               │
 │                                     │
 │  ◄──── webhook: call.ringing ───────┤
 │  ◄──── webhook: call.turn ──────────┤  (AI: "Hi, I'm calling about...")
 │  ◄──── webhook: call.turn ──────────┤  (Caller: "Tell me more")
 │  ◄──── webhook: call.intent ────────┤  (intent: product_inquiry, 0.85)
 │  ◄──── webhook: call.turn ──────────┤  (AI: "Our product...")
 │  ◄──── webhook: call.ended ─────────┤  (transcript, summary, cost)
 │                                     │
 ├── GET /api/crm/calls/42 ──────────► │  (Fetch full record)
 │                                     │
```

### Flow 2: Call with Auto-Transfer

```
CRM                                  Dialog
 │                                     │
 ├── POST /api/crm/calls ───────────►  │
 │   { phone, transferRules:           │
 │     { intents: ["complaint"] } }    │
 │                                     │
 │  ◄──── webhook: call.turn ──────────┤  (AI greets)
 │  ◄──── webhook: call.turn ──────────┤  (Caller: "I have a complaint!")
 │  ◄──── webhook: call.intent ────────┤  (intent: complaint, 0.95)
 │  ◄──── webhook: call.transferring ──┤  (→ agent-billing-1)
 │                                     │  🔔 Agent's phone rings!
 │  ◄──── webhook: call.transferred ───┤  (Agent picked up)
 │  ◄──── webhook: call.ended ─────────┤  (After agent finishes)
 │                                     │
```

### Flow 3: Manual Transfer (CRM-Initiated)

```
CRM                                  Dialog
 │                                     │
 ├── POST /api/crm/calls ───────────►  │  (Start call)
 │                                     │
 │  ◄──── WebSocket: call.turn ────────┤  (Live transcript)
 │  ◄──── WebSocket: call.intent ──────┤  
 │                                     │
 │  [CRM agent clicks "Transfer"       │
 │   in their dashboard]               │
 │                                     │
 ├── POST /api/crm/calls/42/transfer ► │
 │   { crmAgentId: "agent-sales-1",    │
 │     reason: "Close the deal" }      │
 │                                     │  🔔 Agent's phone rings!
 │  ◄──── webhook: call.transferred ───┤
 │                                     │
```

---

## FAQ & Troubleshooting

### Q: What changes do I need to make in my CRM?

You need to build **3 components** in your CRM:

1. **API Client Module** — Makes HTTP requests to Dialog's REST API (to trigger calls, transfers)
2. **Webhook Receiver** — An HTTPS POST endpoint that receives and processes Dialog's events
3. **UI Integration** (optional) — Display live transcripts, call status, and transfer buttons in your CRM's contact/lead view

### Q: Can I use Dialog with Salesforce / Zoho / HubSpot?

Yes! Dialog's API is CRM-agnostic. Any system that can make HTTP requests and receive webhooks can integrate. Use your CRM's workflow automation or custom code to:
- Trigger calls when leads reach a certain stage
- Log call transcripts as activities in lead records
- Update lead scores based on detected intents

### Q: What if my webhook endpoint is down?

Dialog retries webhook deliveries **3 times** with exponential backoff (10s, 60s, 5 minutes). After 3 failures, the delivery is marked as `failed`. You can inspect delivery logs via `GET /api/crm/webhooks/deliveries?status=failed`.

### Q: What languages does the AI support?

English (en-US), Hindi (hi-IN), Kannada (kn-IN), Tamil (ta-IN), Telugu (te-IN), and Marathi (mr-IN). The AI can auto-detect the caller's language and switch automatically.

### Q: What if I don't want auto-transfer?

Don't include `transferRules` in your call request. You can still manually transfer active calls via `POST /api/crm/calls/:id/transfer`.

### Q: How much does each call cost?

Costs are calculated per-call and include Twilio telephony charges + AI model usage (LLM + TTS). Exact costs are returned in the `call.ended` webhook and in `GET /api/crm/calls/:id` response.

### Q: Can I pass custom data that gets returned in webhooks?

Yes! Use the `metadata` field when initiating a call. This is an opaque JSON object that Dialog echoes back in **every webhook event** for that call. Use it to pass your lead IDs, deal IDs, or any other CRM-specific data.

---

## Quick Reference — Required CRM Changes

| Component | What to Build | Complexity |
|---|---|---|
| **HTTP Client** | Send REST API requests to Dialog | Low |
| **Webhook Endpoint** | Receive POST events from Dialog | Medium |
| **Signature Verifier** | HMAC-SHA256 webhook verification | Low |
| **WebSocket Client** | Optional: real-time transcript streaming | Medium |
| **UI Components** | Optional: call buttons, live transcript, transfer controls | High |
| **Data Mapping** | Map Dialog fields to your CRM fields | Low |

### Minimum Viable Integration

For the simplest integration, you only need:

1. ✅ Store the API key securely
2. ✅ Build one API call to trigger outbound calls
3. ✅ Build one webhook endpoint to receive `call.ended` events
4. ✅ Save transcript + summary to your CRM's contact record

**That's it!** You can add real-time streaming, auto-transfers, and campaigns later.
