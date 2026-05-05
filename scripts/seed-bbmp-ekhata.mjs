/**
 * ════════════════════════════════════════════════════════════════
 *  BBMP e-Khata Seed — Sets up a complete BBMP demo environment
 * ════════════════════════════════════════════════════════════════
 *
 * This script authenticates as the BBMP admin user, then creates:
 *   1. Training data (knowledge base) — 9 entries covering all e-Khata intents
 *   2. A master calling script (default)
 *   3. AI Agent config with widget enabled
 *   4. Contacts (5 sample Bengaluru contacts)
 *   5. A campaign linked to the script + contacts
 *
 * Usage:
 *   node scripts/seed-bbmp-ekhata.mjs
 *
 * By default targets the PRODUCTION server.
 * Set BASE_URL env var to override:
 *   BASE_URL=http://localhost:5173 node scripts/seed-bbmp-ekhata.mjs
 *
 * ════════════════════════════════════════════════════════════════
 */

// ── Configuration ──
const BASE_URL = process.env.BASE_URL || "https://dialog.noeticminds.com";
const BBMP_EMAIL = process.env.BBMP_EMAIL || "admin@bbmp";
const BBMP_PASSWORD = process.env.BBMP_PASSWORD || "admin@bbmp";
const BBMP_SLUG = process.env.BBMP_SLUG || "bbmp";

// ── Colors for console output ──
const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
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
  console.log(c.bold("\n🏛️  BBMP e-Khata Demo Seed\n"));
  console.log(c.dim(`   Target: ${BASE_URL}`));
  console.log(c.dim("─".repeat(60)));

  // ═══════════════════════════════════════
  // Step 0: Login as BBMP admin
  // ═══════════════════════════════════════
  console.log(c.cyan("\n📌 Step 0: Logging in as BBMP admin..."));

  const loginRes = await api("POST", "/api/auth/login", {
    email: BBMP_EMAIL,
    password: BBMP_PASSWORD,
    tenantSlug: BBMP_SLUG,
  });

  const token = loginRes.token;
  console.log(c.green(`   ✔ Authenticated as ${loginRes.user.email} (${loginRes.user.role})`));
  console.log(c.dim(`     Tenant: ${loginRes.user.tenantName} (slug: ${loginRes.user.tenantSlug})`));

  // ═══════════════════════════════════════
  // Step 1: Training Data (Knowledge Base)
  // ═══════════════════════════════════════
  console.log(c.cyan("\n📌 Step 1: Uploading e-Khata knowledge base..."));

  const trainingEntries = [
    {
      type: "product_info",
      title: "What is e-Khata",
      content: `e-Khata is the digital version of the traditional Khata certificate issued by BBMP (Bruhat Bengaluru Mahanagara Palike).
It stores property details, ownership, and tax records in an online system instead of manual registers.

Key Benefits:
- Reduces fraud and fake documents
- Improves transparency in property records
- Allows online access anytime, anywhere
- Removes dependency on physical BBMP offices
- Records are digital, secure, and tamper-proof
- Ownership is traceable and verifiable
- Updates are synchronized across all government systems

Earlier, property records were maintained manually, leading to errors, delays, tampering, and difficulty in verification. e-Khata solves all these problems.`,
    },
    {
      type: "product_info",
      title: "How to Apply or Download e-Khata",
      content: `You can apply or download e-Khata online using the official BBMP e-Khata portal.

Portal URL: https://ekhata.bbmp.gov.in

Steps to Apply:
1. Login using your mobile number + OTP
2. Search your property using SAS ID or owner name
3. View Draft e-Khata details
4. Download Draft e-Khata or Apply for Final e-Khata
5. Upload required documents if applying for Final e-Khata
6. Track your application status online

No need to visit BBMP office in most cases. The entire process is online and paperless.`,
    },
    {
      type: "faq",
      title: "Draft vs Final e-Khata",
      content: `Draft e-Khata:
- Generated automatically from existing BBMP property tax records
- May contain incomplete or outdated information
- Not verified — it's raw data from the system
- Free to view and download
- Useful for checking if your property is in the system

Final e-Khata:
- Verified and complete record
- Includes Aadhaar verification (eKYC)
- Includes Sale Deed validation
- Contains updated and correct ownership details
- Legally usable for property transactions
- Required for building plan approvals
- Download fee: ₹125

Summary: Draft = raw unverified data, Final = verified and legally valid record.`,
    },
    {
      type: "faq",
      title: "Documents Required for Final e-Khata",
      content: `To convert Draft e-Khata to Final e-Khata, you need:

1. Aadhaar Card (for eKYC verification)
2. Sale Deed / Registered Deed (proof of ownership)
3. Property Tax Receipt with SAS ID number
4. Recent Property Photo
5. BESCOM electricity bill or connection details
6. Encumbrance Certificate (EC) — if selling property

All documents should be scanned and uploaded in PDF or image format on the e-Khata portal.
Make sure documents are clear and legible.`,
    },
    {
      type: "faq",
      title: "Property Not Found in e-Khata Portal",
      content: `If your property is not showing up in the e-Khata portal:

Step 1: Try different spellings of your name (Kannada/English variations)
Step 2: Search using previous owner's name (if recently purchased)
Step 3: Use SAS ID or PID number instead of owner name
Step 4: Use the "Unable to find property" option on the portal
Step 5: Submit your property documents for manual verification

Processing time:
- Basic cases: 10–15 working days
- New digitization cases: 1–1.5 months
- You will receive SMS updates on your registered mobile number

Contact BBMP helpline if the issue persists after 15 days.`,
    },
    {
      type: "faq",
      title: "e-Khata Fees and Charges",
      content: `Fee Structure for e-Khata Services:

1. Online Application (through portal): FREE (₹0)
2. Through Bangalore One / LPE centers: ₹45 + scanning charges
3. Final e-Khata Download: ₹125
4. Draft e-Khata Download: FREE

⚠️ Important Warning:
- Do NOT pay any unofficial or extra fees to brokers/agents
- All genuine BBMP services are available online
- If anyone asks for extra money, report to BBMP anti-corruption cell
- Receipt is generated automatically for all official payments`,
    },
    {
      type: "product_info",
      title: "Benefits of Final e-Khata and Who Can Apply",
      content: `Benefits of Final e-Khata:
- Secure, tamper-proof ownership records
- Protection against property fraud
- Easy property sale and transfer process
- Loan eligibility from banks (home loan, LAP)
- Integration with tax, electricity, and water systems
- Mandatory for building plan approvals
- Mandatory for all property transactions in Bengaluru

Who Can Apply:
- Property owner (individual)
- Joint owners (all must verify)
- Legal heirs (with succession certificate)
- Power of Attorney holders
- Company/Trust owners (with board resolution)
- Minimum age: 18 years

Any citizen who owns property within BBMP limits can apply.`,
    },
    {
      type: "faq",
      title: "e-Khata Application Status Tracking",
      content: `How to Check Your e-Khata Application Status:

1. Login to the e-Khata portal: https://ekhata.bbmp.gov.in
2. Go to "My Applications" section
3. Enter your SAS ID or Application ID
4. View current status and any pending actions

Status updates are also sent via:
- SMS to your registered mobile number
- Email (if provided during application)

Common statuses:
- "Submitted" — Application received
- "Under Review" — BBMP officer is verifying documents
- "Query Raised" — Additional documents needed (check portal for details)
- "Approved" — Final e-Khata ready for download
- "Rejected" — Check rejection reason and reapply if needed

If status hasn't changed in 15+ days, contact BBMP helpline.`,
    },
    {
      type: "objection_handling",
      title: "Common Objections and Responses",
      content: `"This process looks complicated"
→ Actually, it's much simpler than the old manual system. Everything is online and guided step-by-step. Most people complete it in 15-20 minutes.

"Do I need to visit the BBMP office?"
→ No, in most cases everything can be done online from home. Only complex cases like property disputes or missing records may require a visit.

"Is e-Khata mandatory?"
→ Yes, e-Khata is becoming mandatory for all property transactions, building plan approvals, and loan applications in BBMP jurisdiction.

"I don't trust online systems with my property details"
→ The e-Khata system is government-operated, secured with Aadhaar eKYC, and all data is encrypted. It's actually safer than paper records which can be forged or lost.

"What if my property details are wrong?"
→ You can raise a correction request through the portal itself. Upload supporting documents and the BBMP team will review and update within 10-15 days.

"I already have a physical Khata"
→ Physical Khata will eventually be phased out. Getting e-Khata now ensures your records are digitized and available when you need them for any transaction.`,
    },
  ];

  for (const entry of trainingEntries) {
    const result = await api("POST", "/api/training", entry, token);
    console.log(c.green(`   ✔ Training: "${result.title}" (${result.type})`));
  }

  // ═══════════════════════════════════════
  // Step 2: Create Master Calling Script
  // ═══════════════════════════════════════
  console.log(c.cyan("\n📌 Step 2: Creating e-Khata calling script..."));

  const script = await api("POST", "/api/scripts", {
    name: "BBMP e-Khata — Master Calling Script",
    description: "Complete AI calling script for e-Khata citizen outreach covering all intents: definition, application, draft vs final, documents, fees, status tracking, and objection handling.",
    openingLine: "Hello, I'm calling from BBMP to help you with information about e-Khata services in Bengaluru. This includes checking your property records, downloading draft e-Khata, and converting it to final e-Khata. How can I help you today?",
    pitchPoints: [
      "e-Khata is the digital version of traditional Khata — access your property records online anytime",
      "Apply and download e-Khata from home at ekhata.bbmp.gov.in — no office visit needed",
      "Draft e-Khata is free to download — Final e-Khata costs only ₹125",
      "Final e-Khata is mandatory for property transactions, building approvals, and bank loans",
      "Documents needed: Aadhaar, Sale Deed, SAS ID, Property Photo, BESCOM bill",
      "Track your application status online via SMS updates",
    ],
    closingLine: "Is there anything else about e-Khata I can help you with? You can also visit ekhata.bbmp.gov.in anytime for self-service. Thank you for calling BBMP!",
    fullScript: `OPENING:
"Hello, I'm calling from BBMP to help you with information about e-Khata services in Bengaluru. This includes checking your property records, downloading draft e-Khata, and converting it to final e-Khata."

INTENT DETECTION:
"Please tell me what you'd like help with:
- What is e-Khata
- Apply or download e-Khata
- Draft vs Final e-Khata
- Property not found in system
- Fees and charges
- Documents required
- Status or tracking"

WHAT IS e-KHATA:
"e-Khata is the digital version of the traditional Khata certificate issued by BBMP. It stores your property details, ownership, and tax records in an online system. This was introduced to reduce fraud, improve transparency, and allow online access anytime."

HOW TO APPLY:
"You can apply online at ekhata.bbmp.gov.in. Login using mobile OTP, search property using SAS ID or owner name, view Draft e-Khata, and download or apply for Final e-Khata. No office visit needed."

DRAFT vs FINAL:
"Draft e-Khata is auto-generated from tax records — it may have incomplete info. Final e-Khata is verified with Aadhaar, Sale Deed, and updated ownership details. Draft is raw data, Final is legally usable."

DOCUMENTS:
"For Final e-Khata you need: Aadhaar card, Sale Deed, Property Tax receipt with SAS ID, recent property photo, BESCOM electricity details, and Encumbrance Certificate if selling."

FEES:
"Online application is free. Through Bangalore One it's ₹45 plus scanning charges. Final e-Khata download is ₹125. Don't pay any unofficial fees."

PROPERTY NOT FOUND:
"Try different name spellings, search using previous owner name, use SAS/PID number, or use the 'Unable to find property' option. Basic cases take 10-15 days, new digitization up to 1-1.5 months."

STATUS CHECK:
"Login to the portal, go to My Applications, enter SAS/Application ID. You'll also get SMS updates on your registered number."

OBJECTION HANDLING:
- "Too complicated" → "It's simpler than the old system. Everything is online and step-by-step."
- "Need to visit office?" → "No, everything is online in most cases."
- "Is it mandatory?" → "Yes, for all property transactions and building approvals."

CLOSING:
"Is there anything else about e-Khata I can help you with? Visit ekhata.bbmp.gov.in anytime. Thank you for calling BBMP!"`,
    isDefault: true,
  }, token);

  console.log(c.green(`   ✔ Script created: "${script.name}" (id: ${script.id})`));

  // ═══════════════════════════════════════
  // Step 3: Configure AI Agent + Enable Widget
  // ═══════════════════════════════════════
  console.log(c.cyan("\n📌 Step 3: Configuring AI Agent..."));

  const agent = await api("PUT", "/api/agents", {
    agentName: "BBMP e-Khata Assistant",
    voice: "nova",
    language: "en-US",
    personality: "helpful",
    greeting: "🏛️ Namaskara! I'm the BBMP e-Khata Assistant. I can help you with e-Khata information, application process, document requirements, fees, and status tracking. How can I assist you today?",
    voicemailMessage: "Hello, this is BBMP e-Khata helpline. We called to assist you with your e-Khata query. Please visit ekhata.bbmp.gov.in or call us back. Thank you!",
    maxCallDuration: 300,
    businessHoursOnly: false,
    widgetEnabled: true,
  }, token);

  console.log(c.green(`   ✔ Agent configured: "${agent.agentName}" (voice: ${agent.voice})`));
  console.log(c.green(`   ✔ Widget: ${agent.widgetEnabled ? "ENABLED" : "disabled"}`));
  console.log(c.magenta(`   🔑 Widget API Key: ${agent.widgetApiKey}`));

  // ═══════════════════════════════════════
  // Step 4: Add Sample Contacts
  // ═══════════════════════════════════════
  console.log(c.cyan("\n📌 Step 4: Adding sample Bengaluru contacts..."));

  const contacts = [];
  const sampleContacts = [
    { firstName: "Ramesh", lastName: "Gowda", phone: "+919876543210", email: "ramesh.gowda@gmail.com", company: "Property Owner — Jayanagar" },
    { firstName: "Lakshmi", lastName: "Narayanan", phone: "+919876543211", email: "lakshmi.n@yahoo.com", company: "Property Owner — Indiranagar" },
    { firstName: "Suresh", lastName: "Babu", phone: "+919876543212", email: "suresh.babu@outlook.com", company: "Property Owner — Whitefield" },
    { firstName: "Kavitha", lastName: "Reddy", phone: "+919876543213", email: "kavitha.r@gmail.com", company: "Property Owner — Koramangala" },
    { firstName: "Manjunath", lastName: "H.R.", phone: "+919876543214", email: "manju.hr@gmail.com", company: "Property Owner — Rajajinagar" },
  ];

  for (const c_data of sampleContacts) {
    const contact = await api("POST", "/api/contacts", c_data, token);
    contacts.push(contact);
    console.log(c.green(`   ✔ Contact: ${contact.firstName} ${contact.lastName} — ${contact.company}`));
  }

  // ═══════════════════════════════════════
  // Step 5: Create Campaign
  // ═══════════════════════════════════════
  console.log(c.cyan("\n📌 Step 5: Creating e-Khata outreach campaign..."));

  const campaign = await api("POST", "/api/campaigns", {
    name: "BBMP e-Khata Awareness — Q2 2026",
    description: "Outbound calling campaign to inform Bengaluru property owners about e-Khata digitization, application process, and benefits of converting to Final e-Khata.",
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
  // Summary
  // ═══════════════════════════════════════
  console.log(c.cyan("\n📌 Verification: Fetching all data..."));

  const allScripts = await api("GET", "/api/scripts", null, token);
  const allTraining = await api("GET", "/api/training", null, token);
  const allContacts = await api("GET", "/api/contacts", null, token);
  const allCampaigns = await api("GET", "/api/campaigns", null, token);
  const agentConfig = await api("GET", "/api/agents", null, token);

  console.log(c.dim("─".repeat(60)));
  console.log(c.bold("\n📊 BBMP e-Khata Demo Summary:"));
  console.log(`   Scripts:      ${c.green(allScripts.length)} created`);
  console.log(`   Training:     ${c.green(allTraining.length)} knowledge entries`);
  console.log(`   Contacts:     ${c.green(allContacts.total)} added`);
  console.log(`   Campaigns:    ${c.green(allCampaigns.length)} created`);
  console.log(`   AI Agent:     ${c.green(agentConfig.agentName)} (${agentConfig.voice})`);
  console.log(`   Widget:       ${agentConfig.widgetEnabled ? c.green("ENABLED ✓") : c.red("DISABLED ✗")}`);

  console.log(c.dim("\n─".repeat(60)));

  console.log(c.bold("\n🔗 Widget Integration:"));
  console.log(c.yellow(`   API Key: ${agentConfig.widgetApiKey}`));
  console.log(c.dim(`\n   Embed this script on any webpage:`));
  console.log(c.magenta(`   <script src="${BASE_URL}/api/widget/loader.js?key=${agentConfig.widgetApiKey}"></script>`));

  console.log(c.dim("\n─".repeat(60)));
  console.log(c.bold("\n✅ BBMP e-Khata demo environment ready!\n"));

  console.log(c.yellow("📋 Next steps:"));
  console.log(c.dim(`   1. Test the widget: Visit ${BASE_URL}/bbmp`));
  console.log(c.dim(`   2. Ask questions like: "What is e-Khata?", "How to apply?", "What documents do I need?"`));
  console.log(c.dim(`   3. The AI will answer using the knowledge base you just seeded`));
  console.log(c.dim(`   4. Share the /bbmp URL with the client for the demo`));
  console.log("");
}

main().catch((err) => {
  console.error(c.red(`\n❌ Error: ${err.message}`));
  process.exit(1);
});
