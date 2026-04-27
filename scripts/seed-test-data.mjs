/**
 * ════════════════════════════════════════════════════════════════
 *  Dialog Test Seed — Sets up a complete demo environment
 * ════════════════════════════════════════════════════════════════
 *
 * This script authenticates as admin@demo.com, then creates:
 *   1. A calling script (default)
 *   2. Training data (product info + FAQ)
 *   3. AI Agent config update
 *   4. Contacts (3 sample contacts)
 *   5. A campaign linked to the script + contacts
 *
 * Usage:
 *   node scripts/seed-test-data.mjs
 *
 * Requires the dev server to be running on localhost:5173
 * ════════════════════════════════════════════════════════════════
 */

const BASE_URL = "http://localhost:5173";

// ── Colors for console output ──
const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

async function api(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }

  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function main() {
  console.log(c.bold("\n🚀 Dialog Test Seed\n"));
  console.log(c.dim("─".repeat(60)));

  // ═══════════════════════════════════════
  // Step 0: Login
  // ═══════════════════════════════════════
  console.log(c.cyan("\n📌 Step 0: Logging in..."));

  const loginRes = await api("POST", "/api/auth/login", {
    email: "admin@demo.com",
    password: "Admin1234",
    tenantSlug: "demo",
  });

  const token = loginRes.token;
  console.log(c.green(`   ✔ Authenticated as ${loginRes.user.email} (${loginRes.user.role})`));
  console.log(c.dim(`     Tenant: ${loginRes.user.tenantName} (slug: ${loginRes.user.tenantSlug})`));

  // ═══════════════════════════════════════
  // Step 1: Create a Calling Script
  // ═══════════════════════════════════════
  console.log(c.cyan("\n📌 Step 1: Creating calling script..."));

  const script = await api("POST", "/api/scripts", {
    name: "Product Demo — Enterprise CRM",
    description: "A sales pitch script for our AI-powered CRM solution targeted at mid-size businesses.",
    openingLine: "Hi, this is Alex from NoeticMinds. I'm reaching out because we've helped companies like yours increase sales by 40% using our AI-powered CRM. Do you have a quick moment?",
    pitchPoints: [
      "AI-powered lead scoring saves 10+ hours per week",
      "Automated follow-ups increase close rates by 35%",
      "Real-time analytics dashboard for sales managers",
      "Seamless integration with existing tools (Slack, Gmail, HubSpot)",
    ],
    closingLine: "I'd love to set up a 15-minute demo to show you exactly how this would work for your team. Would Tuesday or Thursday work better for you?",
    fullScript: `Opening:
"Hi, this is Alex from NoeticMinds. I'm reaching out because we've helped companies like yours increase sales by 40% using our AI-powered CRM. Do you have a quick moment?"

If YES → Pitch:
"Great! So our platform uses AI to automatically score and prioritize your leads — our customers save over 10 hours a week on manual prospecting. Plus, it handles automated follow-ups so no lead ever falls through the cracks. We've seen teams increase their close rates by about 35%."

Handle Objections:
- "Too expensive" → "I understand budget is important. Our plans start at just $49/month per seat, and most teams see ROI within the first month."
- "Already have a CRM" → "That's great! We actually integrate seamlessly with tools like HubSpot and Salesforce. Most clients use us as an AI layer on top of their existing setup."
- "Not interested" → "I completely understand. Would it be okay if I sent over a quick one-pager so you have it when the timing is right?"

Closing:
"I'd love to set up a 15-minute demo to show you exactly how this would work for your team. Would Tuesday or Thursday work better for you?"`,
    isDefault: true,
  }, token);

  console.log(c.green(`   ✔ Script created: "${script.name}" (id: ${script.id})`));
  console.log(c.dim(`     Default: ${script.isDefault} | Opening: "${script.openingLine.substring(0, 60)}..."`));

  // ═══════════════════════════════════════
  // Step 2: Add Training Data
  // ═══════════════════════════════════════
  console.log(c.cyan("\n📌 Step 2: Uploading training data..."));

  const training1 = await api("POST", "/api/training", {
    type: "product_info",
    title: "NoeticMinds AI CRM — Product Overview",
    content: `NoeticMinds AI CRM is an intelligent customer relationship management platform.
Key Features:
- AI Lead Scoring: Automatically ranks leads by likelihood to convert
- Smart Follow-ups: Sends personalized emails/SMS at optimal times
- Sales Pipeline: Visual drag-and-drop deal management
- Analytics: Real-time dashboards showing team and individual performance
- Integrations: Native connectors for Gmail, Outlook, Slack, HubSpot, Salesforce
Pricing: Starter ($49/mo), Professional ($99/mo), Enterprise (custom)
Founded: 2023 | HQ: Bangalore, India | 500+ customers`,
  }, token);
  console.log(c.green(`   ✔ Training: "${training1.title}" (type: ${training1.type})`));

  const training2 = await api("POST", "/api/training", {
    type: "faq",
    title: "Common Customer Questions",
    content: `Q: How long does setup take?
A: Most teams are up and running within 24 hours. We provide free onboarding support.

Q: Do you offer a free trial?
A: Yes, we offer a 14-day free trial with full access to all features. No credit card required.

Q: What about data security?
A: We are SOC 2 Type II certified. All data is encrypted at rest and in transit. We support SSO and RBAC.

Q: Can I import my existing data?
A: Absolutely. We support CSV import, and have native migration tools for HubSpot, Salesforce, and Pipedrive.`,
  }, token);
  console.log(c.green(`   ✔ Training: "${training2.title}" (type: ${training2.type})`));

  const training3 = await api("POST", "/api/training", {
    type: "objection_handling",
    title: "Objection Response Guide",
    content: `"Too expensive" → Highlight ROI: "Most customers see 3x ROI within 60 days. Our starter plan is just $49/month — less than one hour of a sales rep's time."

"We already use [Competitor]" → "That's great! Many of our customers came from [Competitor] because they wanted AI-powered features like automated lead scoring and smart follow-ups that aren't available there."

"Not the right time" → "I completely understand. Can I send you a quick case study so you have it when timing is better? What's the best email?"

"Need to check with my manager" → "Of course! Would it help if I prepared a one-page ROI summary for your manager? I can include industry benchmarks specific to your company size."`,
  }, token);
  console.log(c.green(`   ✔ Training: "${training3.title}" (type: ${training3.type})`));

  // ═══════════════════════════════════════
  // Step 3: Update AI Agent Config
  // ═══════════════════════════════════════
  console.log(c.cyan("\n📌 Step 3: Configuring AI Agent..."));

  const agent = await api("PUT", "/api/agents", {
    agentName: "Alex",
    voice: "nova",
    personality: "professional",
    greeting: "Hi, thank you for calling NoeticMinds! This is Alex, your AI assistant. How can I help you today?",
    voicemailMessage: "Hi, this is Alex from NoeticMinds. I was calling about our AI-powered CRM solution. Please call us back at your convenience. Thank you!",
    maxCallDuration: 300,
    businessHoursOnly: true,
  }, token);
  console.log(c.green(`   ✔ Agent configured: "${agent.agentName}" (voice: ${agent.voice}, personality: ${agent.personality})`));

  // ═══════════════════════════════════════
  // Step 4: Add Contacts
  // ═══════════════════════════════════════
  console.log(c.cyan("\n📌 Step 4: Adding contacts..."));

  const contacts = [];
  const sampleContacts = [
    { firstName: "Rahul", lastName: "Sharma", phone: "+919876543210", email: "rahul@techcorp.in", company: "TechCorp India" },
    { firstName: "Priya", lastName: "Patel", phone: "+919876543211", email: "priya@startupxy.com", company: "StartupXY" },
    { firstName: "Amit", lastName: "Kumar", phone: "+919876543212", email: "amit@globalsoft.in", company: "GlobalSoft Solutions" },
  ];

  for (const c_data of sampleContacts) {
    const contact = await api("POST", "/api/contacts", c_data, token);
    contacts.push(contact);
    console.log(c.green(`   ✔ Contact: ${contact.firstName} ${contact.lastName} (${contact.phone})`));
  }

  // ═══════════════════════════════════════
  // Step 5: Create a Campaign
  // ═══════════════════════════════════════
  console.log(c.cyan("\n📌 Step 5: Creating campaign..."));

  const campaign = await api("POST", "/api/campaigns", {
    name: "Q2 Enterprise CRM Outreach",
    description: "Outbound campaign targeting mid-size tech companies for AI CRM demo.",
    scriptId: script.id,
    contactIds: contacts.map(c_item => c_item.id),
    startTime: "09:00",
    endTime: "18:00",
    timezone: "Asia/Kolkata",
    maxConcurrentCalls: 1,
  }, token);
  console.log(c.green(`   ✔ Campaign: "${campaign.name}" (id: ${campaign.id})`));
  console.log(c.dim(`     Status: ${campaign.status} | Contacts: ${campaign.totalContacts} | Script: #${campaign.scriptId}`));

  // ═══════════════════════════════════════
  // Verify everything
  // ═══════════════════════════════════════
  console.log(c.cyan("\n📌 Verification: Fetching all data..."));

  const allScripts = await api("GET", "/api/scripts", null, token);
  const allTraining = await api("GET", "/api/training", null, token);
  const allContacts = await api("GET", "/api/contacts", null, token);
  const allCampaigns = await api("GET", "/api/campaigns", null, token);
  const agentConfig = await api("GET", "/api/agents", null, token);

  console.log(c.dim("─".repeat(60)));
  console.log(c.bold("\n📊 Summary:"));
  console.log(`   Scripts:      ${c.green(allScripts.length)} created`);
  console.log(`   Training:     ${c.green(allTraining.length)} entries`);
  console.log(`   Contacts:     ${c.green(allContacts.total)} added`);
  console.log(`   Campaigns:    ${c.green(allCampaigns.length)} created`);
  console.log(`   AI Agent:     ${c.green(agentConfig.agentName)} (${agentConfig.voice})`);

  console.log(c.dim("\n─".repeat(60)));
  console.log(c.bold("\n✅ All test data created successfully!\n"));

  console.log(c.yellow("📞 Next steps to make real calls:"));
  console.log(c.dim("   1. Configure Twilio credentials in AI Agent settings (superadmin)"));
  console.log(c.dim("   2. Set a Twilio phone number"));
  console.log(c.dim("   3. Expose your server via ngrok/tunnel for Twilio webhooks"));
  console.log(c.dim(`   4. Start the campaign: POST /api/campaigns/${campaign.id}/start`));
  console.log(c.dim(`   5. Dial next contact: POST /api/campaigns/${campaign.id}/dial-next`));
  console.log("");
}

main().catch((err) => {
  console.error(c.red(`\n❌ Error: ${err.message}`));
  process.exit(1);
});
