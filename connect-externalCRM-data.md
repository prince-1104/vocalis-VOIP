# Task: Build a Customer Lookup API for Dialog AI Calling Integration

## Context

We are integrating with Dialog (dialog.noeticminds.com), an AI voice calling platform.
When a customer calls us (or we call them), Dialog needs to fetch customer + order info
from our CRM in real-time so the AI agent can personalize the conversation.

Dialog will call our API with the customer's phone number and expects a JSON response
with customer details and recent orders. This happens automatically on every call —
Dialog's server makes the HTTP request, not a browser.

## What to Build

Create a single REST API endpoint:

```
GET /api/dialog/customer-lookup?phone=9004688178
```

### Requirements

1. **Accept phone number in any of these formats** (Dialog sends whatever Twilio/Exotel provides):
   - `9004688178` (10 digits)
   - `919004688178` (with country code, no +)
   - `+919004688178` (full international)
   - `09004688178` (with leading 0)

   Normalize all of these to the 10-digit format before DB lookup.
   Strip `+91`, `91`, or leading `0` prefix.

2. **Look up the customer by phone** in the customers/users table.

3. **Fetch all their orders** (sorted by placed date descending).

4. **Return JSON** in this exact structure:

```json
{
  "found": true,
  "customer": {
    "name": "Vedant Tiwari",
    "email": "v6593940@gmail.com",
    "phone": "9004688178",
    "totalOrders": 5,
    "doctor": "Dr. Priyanka Singh"
  },
  "recentOrders": [
    {
      "orderId": "25173",
      "status": "Ready to ship",
      "products": "Strawberry Relax & Reset Gummies 7% - Pack of 10",
      "total": "2899.00",
      "paymentStatus": "Paid",
      "rxStatus": "Rx exists",
      "rxValidUntil": "27-07-2026",
      "doctor": "Dr. Priyanka Singh",
      "trackingId": null,
      "placedAt": "2026-06-23"
    },
    {
      "orderId": "25100",
      "status": "Delivered",
      "products": "Mango Relax & Reset Gummies 5% - Pack of 5",
      "total": "1048.00",
      "paymentStatus": "Paid",
      "rxStatus": "Rx exists",
      "rxValidUntil": "15-08-2026",
      "doctor": "Dr. Priyanka Singh",
      "trackingId": "TRACK123456",
      "placedAt": "2026-06-15"
    }
  ]
}
```

5. **If customer not found**, return:

```json
{
  "found": false,
  "customer": null,
  "recentOrders": []
}
```

   Still return HTTP 200 (not 404). Dialog handles "not found" gracefully.

6. **Authentication**: Protect this endpoint with a static API key sent as a Bearer token.
   - Check for `Authorization: Bearer <token>` header
   - Store the token in environment variable `DIALOG_API_KEY`
   - Return 401 if missing or invalid
   - Generate a strong random token (e.g. 64-char hex string)

 7. **Performance**: This endpoint is called in real-time during phone calls.
   - Must respond in under 1 second (ideally < 500ms)
   - Use indexed queries on the phone column
   - Return all orders for the caller (do not restrict or limit to 3)
   - No heavy joins or aggregations

8. **Security**:
   - Do NOT return full addresses or sensitive medical details
   - Do NOT return passwords, internal IDs, or admin data
   - Only return what an AI phone agent would reasonably say to the customer
   - Consider IP whitelisting for Dialog's server IP if possible

9. **Products field**: If an order has multiple products, join them with ", "
   e.g. "Mango Gummies 7% x 1, Strawberry Gummies 5% x 2"

10. **Phone column index**: If the customers table doesn't already have an index
    on the phone column, add one for fast lookups.

## Fields Explained

These are the fields Dialog's AI agent will use during phone calls:

| Field | Why the AI needs it |
|-------|---------------------|
| `customer.name` | Greet the customer by name ("Hi Vedant...") |
| `customer.email` | Confirm identity if needed |
| `customer.phone` | Reference / confirmation |
| `customer.totalOrders` | Context ("I see you've ordered with us 5 times") |
| `customer.doctor` | Answer "who is my doctor?" |
| `recentOrders[].orderId` | Reference specific orders ("Your order #25173...") |
| `recentOrders[].status` | Answer "where is my order?" |
| `recentOrders[].products` | Answer "what did I order?" |
| `recentOrders[].total` | Answer payment questions |
| `recentOrders[].paymentStatus` | Answer "is my payment done?" |
| `recentOrders[].rxStatus` | Answer "do I have a prescription?" |
| `recentOrders[].rxValidUntil` | Answer "is my prescription still valid?" |
| `recentOrders[].doctor` | Answer "which doctor prescribed this?" |
| `recentOrders[].trackingId` | Answer "can I track my order?" (null if not shipped) |
| `recentOrders[].placedAt` | Answer "when did I place this order?" |

**Rule**: Whatever fields you return, the AI can talk about. Whatever is missing, the AI cannot know. Include any additional fields you want the AI to discuss (e.g. fulfillment agent, expected delivery date, discount applied, etc.).

## Example Calls

```bash
# Successful lookup
curl -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  "https://admin.rastafariwellness.com/api/dialog/customer-lookup?phone=9004688178"

# Phone with country code (should still work)
curl -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  "https://admin.rastafariwellness.com/api/dialog/customer-lookup?phone=+919004688178"

# Customer not found (returns found: false, HTTP 200)
curl -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  "https://admin.rastafariwellness.com/api/dialog/customer-lookup?phone=0000000000"
```

## Example Conversations the AI Can Have

Once this API is live, the AI agent will be able to handle calls like this:

> **Customer**: "Hi, what's the status of my order?"
> **AI**: "Hi Vedant, your most recent order #25173 for Strawberry Relax & Reset Gummies is currently ready to ship. Is there anything else you'd like to know?"

> **Customer**: "Who is my doctor?"
> **AI**: "Your prescribing doctor is Dr. Priyanka Singh."

> **Customer**: "Is my prescription still valid?"
> **AI**: "Yes, your prescription is valid until 27th July 2026."

> **Customer**: "What did I order last time?"
> **AI**: "Your last order was Mango Relax & Reset Gummies 5%, a pack of 5, placed on June 15th."

> **Customer**: "Is my payment done?"
> **AI**: "Yes, your payment of Rs 2,899 for order #25173 has been received."

> **Customer**: "Can I track my order?"
> **AI**: "Your order #25173 is currently ready to ship and hasn't been dispatched yet. Once shipped, you'll receive a tracking ID."

## Phone Number Normalization Logic

Dialog may send the phone number in any format. Here is the normalization logic to implement:

```
Input: "+919004688178"  → Strip "+91" → "9004688178"
Input: "919004688178"   → Strip "91"  → "9004688178"
Input: "09004688178"    → Strip "0"   → "9004688178"
Input: "9004688178"     → Already 10 digits → "9004688178"
```

Pseudocode:
```
function normalizePhone(phone):
    phone = phone.replace(/[^0-9]/g, '')   // remove all non-digits
    if phone.startsWith("91") and phone.length == 12:
        phone = phone.substring(2)          // strip country code
    if phone.startsWith("0") and phone.length == 11:
        phone = phone.substring(1)          // strip leading 0
    return phone                            // should be 10 digits
```

## After Implementation

Once the endpoint is live, share these with us:

1. **The full API URL** (e.g. `https://admin.rastafariwellness.com/api/dialog/customer-lookup`)
2. **The Bearer token** you generated
3. **Confirm the JSON response** matches the structure above (test with a real phone number)

We will configure it on Dialog's External CRM settings page and test with real phone numbers before going live on calls.
