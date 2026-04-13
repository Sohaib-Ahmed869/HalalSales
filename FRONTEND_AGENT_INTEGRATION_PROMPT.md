# Frontend Integration Prompt — AI Agent System for RFQ Platform

You are updating the frontend of an RFQ (Request for Quotation) management platform. The backend has been upgraded with a new **multi-agent AI system** that replaces the old dumb cron-based email poller. Your job is to update the frontend to expose these new capabilities.

---

## EXISTING FRONTEND CONTEXT

The frontend already has these RFQ-related pages/features:
- RFQ creation form (select items, choose vendors, set dates)
- RFQ list/table showing all RFQs with status filters
- RFQ detail page showing items, vendors contacted, status per vendor
- Vendor response recording (manual form to enter quoted prices)
- Vendor comparison table (basic price comparison)
- Send RFQ flow (select vendors → choose email/WhatsApp → send)
- PDF preview/download for RFQs

The existing API base URL pattern is `/api/rfq/...` for RFQ operations.

---

## WHAT CHANGED ON THE BACKEND

A new set of endpoints exists at `/api/agents/...`. These power an AI agent system that:

1. **Automatically checks inbox** every 5 minutes for vendor email responses
2. **Understands vendor emails** using AI — classifies as quotation, question, decline, partial quote, or out-of-office
3. **Auto-replies** to vendors intelligently (answers questions from RFQ details, asks for missing items, thanks for quotes)
4. **Discovers vendor contacts** by searching the web when email/phone is missing
5. **Generates comparison reports** with AI — ranks vendors by price, delivery, risk, and recommends a winner
6. **Sends RFQs** with personalized tone (formal for new vendors, warm for existing partners)

---

## NEW API ENDPOINTS

### 1. `POST /api/agents/trigger`
Manually trigger any agent event.

**Request body:**
```json
{
  "event": "string",
  "payload": { ... }
}
```

**Supported events:**

| Event | Payload | What it does |
|-------|---------|-------------|
| `check_inbox` | `{}` | Checks Gmail for new vendor responses, parses them with AI, auto-replies |
| `rfq_send_requested` | `{ "rfqId": "string", "vendorCodes": ["V001", "V002"], "sendMethod": "email" or "whatsapp", "customMessage": "optional" }` | Sends RFQ to vendors with AI-personalized emails |
| `rfq_created` | `{ "rfqId": "string" }` | Same as rfq_send_requested but auto-detects vendors from draft |
| `rfq_closed` | `{ "rfqId": "string" }` | Triggers comparison report generation |
| `vendor_missing_contact` | `{ "vendorName": "string", "vendorCode": "string", "country": "string", "productCategory": "string" }` | Finds vendor contact info via web search |

**Response:**
```json
{
  "success": true,
  "message": "Event \"check_inbox\" handled successfully",
  "data": {
    "agent": "inbound",
    "success": true,
    "result": {
      "activeRFQs": 5,
      "emailsProcessed": 3
    }
  }
}
```

### 2. `GET /api/agents/log`
View recent agent activity log.

**Query params:**
- `limit` (number, default 50, max 200)
- `agent` (string, optional — filter by agent name: `Inbound`, `Outbound`, `Discovery`, `Comparison`, `Orchestrator`)

**Response:**
```json
{
  "success": true,
  "data": {
    "total": 47,
    "entries": [
      {
        "timestamp": "2025-01-15T14:30:00.000Z",
        "agent": "Inbound",
        "action": "email_processed",
        "details": {
          "rfqNumber": "RFQ-202501-0042",
          "vendor": "MS FOODS LTD",
          "vendorEmail": "sales@msfoods.com"
        }
      },
      {
        "timestamp": "2025-01-15T14:29:55.000Z",
        "agent": "Inbound",
        "action": "email_classified",
        "details": {
          "classification": "quotation",
          "vendor": "MS FOODS LTD",
          "rfqNumber": "RFQ-202501-0042"
        }
      }
    ]
  }
}
```

**Possible action types in the log:**
- `check_inbox_started`, `check_inbox_completed`, `check_inbox_error`
- `email_classified`, `email_processed`, `email_processing_error`
- `reply_sent`
- `send_rfq_started`, `send_rfq_completed`, `send_rfq_error`
- `discovery_started`, `discovery_completed`, `discovery_failed`, `discovery_error`
- `comparison_started`, `comparison_completed`, `comparison_error`
- `orchestrator_started`, `orchestrator_stopped`
- `event_received`, `event_error`, `ai_routed`

### 3. `POST /api/agents/discover-contact`
Find missing vendor contact info via AI web search.

**Request body:**
```json
{
  "vendorName": "Duc Export SARL",
  "vendorCode": "V00123",
  "country": "France",
  "productCategory": "Frozen Chicken"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Contact found for Duc Export SARL",
  "data": {
    "email": "export@duc.fr",
    "phone": "+33 1 42 XX XX XX",
    "website": "https://duc.fr",
    "contactPerson": "Jean Dupont",
    "confidence": "high",
    "source": "Found on company website contact page",
    "found": true
  }
}
```

### 4. `POST /api/agents/compare/:rfqId`
Generate an AI-powered vendor comparison report.

**Response:**
```json
{
  "success": true,
  "message": "Comparison report generated",
  "data": {
    "summary": "Three vendors responded to RFQ-202501-0042. MS Foods offers the best overall value...",
    "priceRanking": [
      {
        "rank": 1,
        "vendorCode": "V001",
        "vendorName": "MS FOODS LTD",
        "totalQuoted": 8500,
        "currency": "EUR",
        "priceVsAverage": "12% below average"
      },
      {
        "rank": 2,
        "vendorCode": "V002",
        "vendorName": "EURO MEAT CO",
        "totalQuoted": 9200,
        "currency": "EUR",
        "priceVsAverage": "5% below average"
      }
    ],
    "deliveryRanking": [
      {
        "rank": 1,
        "vendorCode": "V002",
        "vendorName": "EURO MEAT CO",
        "deliveryDays": 5,
        "assessment": "Fastest delivery"
      }
    ],
    "paymentTermsAnalysis": [
      {
        "vendorCode": "V001",
        "vendorName": "MS FOODS LTD",
        "terms": "Net 30",
        "favorability": "favorable"
      }
    ],
    "riskFlags": [
      {
        "vendorCode": "V003",
        "vendorName": "NEW SUPPLIER INC",
        "riskLevel": "high",
        "flags": ["No order history", "Price 35% below market average"],
        "reasoning": "New vendor with suspiciously low pricing — recommend requesting samples first"
      }
    ],
    "recommendation": {
      "winnerCode": "V001",
      "winnerName": "MS FOODS LTD",
      "reasoning": "Best combination of competitive pricing, 50+ past orders, 95% on-time delivery, and favorable Net 30 terms",
      "alternativeCode": "V002",
      "alternativeName": "EURO MEAT CO",
      "alternativeReasoning": "Faster delivery if timeline is critical"
    },
    "potentialSavings": {
      "highestQuote": 11000,
      "lowestQuote": 8500,
      "savingsAmount": 2500,
      "savingsPercentage": "22.7%"
    }
  }
}
```

### 5. `GET /api/agents/status`
Health check for the agent system.

**Response:**
```json
{
  "success": true,
  "data": {
    "isRunning": true,
    "pollInterval": "5 minutes",
    "recentActions": [ ... ],
    "totalLogEntries": 47,
    "uptime": 3600,
    "timestamp": "2025-01-15T14:30:00.000Z"
  }
}
```

---

## EXISTING ENDPOINTS STILL IN USE (unchanged)

These endpoints still work exactly as before — the agents are an additional layer:

```
POST   /api/rfq/analyze              — Analyze items and find vendors
POST   /api/rfq/create               — Create RFQ draft
POST   /api/rfq/:rfqId/send          — Send RFQ to vendors (legacy — still works)
GET    /api/rfq                       — List all RFQs with pagination
GET    /api/rfq/:rfqId                — Get single RFQ
POST   /api/rfq/:rfqId/vendor-response — Record vendor response (manual)
POST   /api/rfq/:rfqId/select-vendor  — Select winning vendor
GET    /api/rfq/:rfqId/compare        — Basic price comparison (legacy)
POST   /api/rfq/:rfqId/cancel         — Cancel RFQ
GET    /api/rfq/:rfqId/download-pdf   — Download RFQ PDF
GET    /api/rfq/:rfqId/preview-pdf    — Preview RFQ PDF in browser
GET    /api/rfq/items                 — Search inventory items for form
```

---

## FRONTEND CHANGES NEEDED

### 1. Agent Dashboard Page (NEW PAGE)

Create a new page at route `/agents` or `/rfq/agents` showing:

**Top section — Status bar:**
- Green/red indicator showing if the agent system is running (from `GET /api/agents/status`)
- Poll interval display ("Checking inbox every 5 minutes")
- "Check Inbox Now" button → calls `POST /api/agents/trigger` with `{ "event": "check_inbox" }`
- Last check timestamp

**Main section — Activity Feed:**
- Real-time scrolling log of agent actions (from `GET /api/agents/log`)
- Each entry shows: timestamp, agent name (with color-coded badge), action description, details
- Filter tabs by agent: All | Inbound | Outbound | Discovery | Comparison
- Auto-refresh every 30 seconds (or use polling)

**Agent color coding:**
- Inbound → Blue
- Outbound → Green
- Discovery → Purple
- Comparison → Orange
- Orchestrator → Gray

**Action icon mapping:**
- `email_classified` → mail icon
- `email_processed` → check-circle icon
- `reply_sent` → send icon
- `send_rfq_started` → upload icon
- `discovery_started` → search icon
- `comparison_completed` → bar-chart icon
- `*_error` → alert-triangle icon (red)

### 2. RFQ Detail Page — Enhanced Vendor Section

On the existing RFQ detail page, enhance the vendor cards/table:

**For each vendor contacted, show:**
- Current status badge: `draft` (gray), `sent` (blue), `responded` (green), `declined` (red)
- If `responded`:
  - Show `vendor.quotationData.totalQuotedAmount` with currency
  - Show `vendor.quotationData.deliveryTimeInDays` 
  - Show `vendor.quotationData.paymentTerms`
  - Show a "View Full Quote" expandable section with `vendor.quotationData.quotedItems[]`
  - Show a "View Raw Email" expandable section with `vendor.rawEmailContent.body`
- If vendor has `whatsappHistory[]`, show a chat-style message history

**New button on the RFQ detail page:**
- "Generate AI Comparison" button → calls `POST /api/agents/compare/:rfqId`
  - Shows loading spinner while processing
  - When done, displays the comparison report inline (or in a modal)
  - The report data is also saved at `rfq.metadata.comparisonReport` so it persists on page reload

**Auto-detected responses indicator:**
- If the Inbound Agent has auto-processed a vendor email, show a small "AI Processed" badge next to the vendor
- This is detectable when `vendor.quotationData.parsingStatus === 'success'` and `vendor.rawEmailContent` exists

### 3. RFQ Send Flow — Use Agent Instead

Currently the send flow calls `POST /api/rfq/:rfqId/send`. Add an option to send via the agent system instead:

**Option A — Replace the send button action:**
Change the send button to call:
```
POST /api/agents/trigger
{
  "event": "rfq_send_requested",
  "payload": {
    "rfqId": "...",
    "vendorCodes": [...selected vendor codes...],
    "sendMethod": "email" or "whatsapp",
    "customMessage": "optional note"
  }
}
```

**Option B — Keep both (recommended for transition):**
Add a toggle/switch: "Send via AI Agent" vs "Send directly"
- AI Agent: personalized tone, auto-discovers missing contacts, logs to agent dashboard
- Direct: uses the existing `/api/rfq/:rfqId/send` endpoint

### 4. Vendor Contact Discovery (NEW FEATURE)

Add a "Find Contact" button on vendor cards where email or phone is missing:

**Trigger:**
```
POST /api/agents/discover-contact
{
  "vendorName": "Duc Export SARL",
  "vendorCode": "V00123",
  "country": "France",
  "productCategory": "Frozen Chicken"
}
```

**UI behavior:**
- Button shows on vendor cards where `vendor.email` is empty/null
- On click: show loading spinner with "Searching the web..."
- On success: show discovered email/phone with confidence badge (high/medium/low)
- "Accept" button to confirm and save (already saved by backend, this is just UX confirmation)
- "Reject" button to discard if the contact looks wrong

### 5. AI Comparison Report View (NEW COMPONENT)

Create a rich comparison report component that renders the data from `POST /api/agents/compare/:rfqId`:

**Sections to render:**

1. **Executive Summary** — `report.summary` as a paragraph at the top

2. **Price Ranking Table** — `report.priceRanking[]`
   | Rank | Vendor | Total Quoted | vs Average |
   |------|--------|-------------|------------|
   | 1    | MS FOODS | EUR 8,500 | 12% below |

3. **Delivery Ranking** — `report.deliveryRanking[]` as cards or table

4. **Payment Terms** — `report.paymentTermsAnalysis[]` with favorability color coding:
   - favorable → green
   - neutral → gray
   - unfavorable → red

5. **Risk Flags** — `report.riskFlags[]` as alert cards:
   - low risk → green border
   - medium risk → yellow border
   - high risk → red border
   - Show flags as tags/chips

6. **Recommendation Box** — `report.recommendation` as a highlighted card:
   - Winner with green highlight and reasoning
   - Alternative with blue highlight and reasoning
   - "Select Winner" button → calls `POST /api/rfq/:rfqId/select-vendor`

7. **Savings Summary** — `report.potentialSavings` as a metric card:
   - Show savings amount and percentage prominently

**If `rfq.metadata.comparisonReport` exists on the RFQ detail page, render this component automatically. Otherwise show the "Generate AI Comparison" button.**

### 6. RFQ List — Status Indicators

On the RFQ list/table page, add visual indicators:

- If an RFQ has `metadata.comparisonReport`, show a small chart icon
- If an RFQ was processed by agents (has vendor responses with `quotationData.parsingStatus === 'success'`), show an AI badge
- Show count of responded vendors vs total: "3/5 responded"

### 7. Notifications / Toast Messages

When the user triggers agent actions, show appropriate feedback:

- "Check Inbox Now" → "Checking inbox... Found 3 new responses" (poll for result)
- "Generate Comparison" → "Analyzing vendor responses..." → "Report ready!" 
- "Find Contact" → "Searching for contact..." → "Found: export@duc.fr"
- "Send via Agent" → "Sending to 5 vendors..." → "Sent successfully to 4/5 vendors"

---

## DATA SHAPE REFERENCE

### RFQ Vendor Object (from `GET /api/rfq/:rfqId`)

Each vendor in `rfq.vendorsContacted[]` now has these fields populated by agents:

```json
{
  "vendorCode": "V001",
  "vendorName": "MS FOODS LTD",
  "email": "sales@msfoods.com",
  "phone": "+44 20 XXXX XXXX",
  "status": "responded",
  "vendorSource": "SAP",
  "sentDate": "2025-01-10T10:00:00Z",
  "responseDate": "2025-01-12T14:30:00Z",
  
  "quotationData": {
    "quotedItems": [
      {
        "productName": "Frozen Chicken Breast",
        "quantity": 500,
        "unit": "kg",
        "unitPrice": 4.50,
        "totalPrice": 2250,
        "currency": "EUR"
      }
    ],
    "totalQuotedAmount": 8500,
    "currency": "EUR",
    "deliveryTimeInDays": 7,
    "paymentTerms": "Net 30",
    "validityPeriod": "30 days",
    "additionalNotes": "Free delivery for orders over EUR 5000",
    "isValidQuotation": true,
    "parsingStatus": "success"
  },
  
  "rawEmailContent": {
    "subject": "RE: RFQ-202501-0042 - Quotation",
    "body": "Dear Halal Foods team, please find our quotation...",
    "htmlBody": "<html>...",
    "pdfContent": "extracted text from attached PDF...",
    "receivedDate": "2025-01-12T14:30:00Z",
    "attachments": ["Quotation_MS_FOODS.pdf"]
  },
  
  "whatsappHistory": [
    {
      "direction": "outgoing",
      "message": "Hello MS FOODS, we are sending you RFQ...",
      "timestamp": "2025-01-10T10:00:00Z"
    },
    {
      "direction": "incoming",
      "message": "Thank you, our price is...",
      "timestamp": "2025-01-11T09:15:00Z"
    }
  ]
}
```

### Comparison Report Object (from `rfq.metadata.comparisonReport` or `POST /api/agents/compare/:rfqId`)

Full structure shown in the API response example above for the compare endpoint.

---

## IMPORTANT NOTES

- The agent system runs on the backend automatically — the frontend is mainly adding visibility and manual trigger capabilities
- All existing RFQ endpoints (`/api/rfq/...`) still work unchanged — the agents are additive
- The Inbound Agent auto-processes vendor emails, so the "Record Vendor Response" manual form should still exist as a fallback but be secondary to auto-processed data
- The agent log auto-refreshes — poll `GET /api/agents/log` every 30 seconds on the dashboard page
- Error handling: all agent endpoints return `{ success: false, error: "message" }` on failure
- The comparison report is persisted in `rfq.metadata.comparisonReport` after first generation — subsequent loads of the RFQ detail page should show it without re-generating
