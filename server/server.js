/**
 * Kapture Finance Collections Voicebot — Mock Tool/Function Server
 * Implements: verify_customer, get_account_details, log_promise_to_pay,
 *             send_payment_link, escalate_to_agent, mark_disposition
 *
 * Run:   npm install && node server.js
 * Then expose it publicly (ngrok, Render, Railway, Replit) and paste the
 * public URL into each tool's "server.url" in the Vapi dashboard, e.g.
 *   https://<your-host>/tools/verify_customer
 *
 * This is intentionally a mock: one hard-coded customer record, in-memory
 * "database" (Maps), and simulated SMS/WhatsApp sends logged to console.
 * Swap the MOCK_DB / send* functions for real LMS/CRM/SMS integrations.
 */

const express = require("express");
const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------
const MOCK_DB = {
  cust_rahul_001: {
    customer_id: "cust_rahul_001",
    full_name: "Rahul Sharma",
    dob: { day: 23, month: 5, year: 1990 }, // 23 May 1990 — the ONLY DOB that verifies
    phone_last4: "4521",
    loan_type: "Personal Loan",
    overdue_amount: 8499,
    days_past_due: 12,
    account_number: "KF-PL-778821",
  },
};

// ---------------------------------------------------------------------------
// Strict DOB parsing/matching
// Accepts many natural formats (spoken or written) but requires an EXACT
// day + month + year match against the record — no partial credit, since
// this gates a real security check (auth-before-disclosure).
// ---------------------------------------------------------------------------
const MONTH_NAMES = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function parseDob(input) {
  if (!input) return null;
  const raw = String(input).toLowerCase().trim();
  // Strip ordinal suffixes: 23rd -> 23, 1st -> 1, 2nd -> 2, 4th -> 4
  const cleaned = raw.replace(/(\d+)(st|nd|rd|th)/g, "$1");

  // Numeric formats: DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD, DD.MM.YYYY
  let m = cleaned.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/); // YYYY-MM-DD
  if (m) return { year: +m[1], month: +m[2], day: +m[3] };

  m = cleaned.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/); // DD-MM-YYYY or MM-DD-YYYY (assume DD-MM)
  if (m) return { day: +m[1], month: +m[2], year: +m[3] };

  // Textual month formats: "23 May 1990", "May 23 1990", "23 May, 1990"
  const monthPattern = Object.keys(MONTH_NAMES).join("|");
  m = cleaned.match(new RegExp(`(\\d{1,2})\\s+(${monthPattern})\\.?,?\\s+(\\d{4})`));
  if (m) return { day: +m[1], month: MONTH_NAMES[m[2]], year: +m[3] };

  m = cleaned.match(new RegExp(`(${monthPattern})\\.?\\s+(\\d{1,2})\\.?,?\\s+(\\d{4})`));
  if (m) return { month: MONTH_NAMES[m[1]], day: +m[2], year: +m[3] };

  return null; // couldn't parse a full day+month+year — treat as not verified
}

function dobMatches(input, recordDob) {
  const parsed = parseDob(input);
  if (!parsed) return false;
  return (
    parsed.day === recordDob.day &&
    parsed.month === recordDob.month &&
    parsed.year === recordDob.year
  );
}

const callLogs = [];      // every tool invocation, for observability
const ptpLog = [];        // logged promises to pay
const dispositions = [];  // final call outcomes

function logEvent(event) {
  const entry = { ts: new Date().toISOString(), ...event };
  callLogs.push(entry);
  console.log("[EVENT]", JSON.stringify(entry));
}

// ---------------------------------------------------------------------------
// Vapi webhook envelope helpers
// Vapi POSTs: { message: { type: "tool-calls", toolCallList: [{ id, name, arguments }, ...] } }
// (Shape has varied across Vapi versions — this handler accepts the modern
// toolCallList shape, the older toolCalls[].function shape, AND a flat body
// for easy manual/curl testing, so it degrades gracefully.)
// Expected response: { results: [{ toolCallId, result }, ...] }
// ---------------------------------------------------------------------------
function extractArgs(req) {
  const body = req.body || {};
  const msg = body.message || {};
  const list = msg.toolCallList || msg.toolCalls || null;
  if (Array.isArray(list) && list.length > 0) {
    const call = list[0];
    const args = call.arguments || (call.function && call.function.arguments) || {};
    const toolCallId = call.id || call.toolCallId || "unknown-id";
    return { args: typeof args === "string" ? JSON.parse(args) : args, toolCallId, isVapiEnvelope: true };
  }
  // Flat body fallback for curl/manual testing
  return { args: body, toolCallId: "manual-test", isVapiEnvelope: false };
}

function respond(res, toolCallId, isVapiEnvelope, resultObj) {
  if (isVapiEnvelope) {
    return res.json({ results: [{ toolCallId, result: JSON.stringify(resultObj) }] });
  }
  return res.json(resultObj);
}

// ---------------------------------------------------------------------------
// 1. verify_customer
// ---------------------------------------------------------------------------
app.post("/tools/verify_customer", (req, res) => {
  const { args, toolCallId, isVapiEnvelope } = extractArgs(req);
  const { full_name = "", dob_or_last4_id = "" } = args;

  const record = Object.values(MOCK_DB).find(
    (c) => c.full_name.toLowerCase() === String(full_name).toLowerCase().trim()
  );

  const providedRaw = String(dob_or_last4_id).trim();
  const verified =
    !!record &&
    providedRaw !== "" &&
    (dobMatches(providedRaw, record.dob) || providedRaw === record.phone_last4);

  logEvent({ tool: "verify_customer", args, verified });

  if (!record) {
    return respond(res, toolCallId, isVapiEnvelope, {
      verified: false,
      reason: "no_matching_account",
    });
  }

  return respond(res, toolCallId, isVapiEnvelope, {
    verified,
    customer_id: verified ? record.customer_id : undefined,
    reason: verified ? "match" : "id_mismatch",
  });
});

// ---------------------------------------------------------------------------
// 2. get_account_details
// ---------------------------------------------------------------------------
app.post("/tools/get_account_details", (req, res) => {
  const { args, toolCallId, isVapiEnvelope } = extractArgs(req);
  const record = MOCK_DB[args.customer_id];

  logEvent({ tool: "get_account_details", args, found: !!record });

  if (!record) {
    return respond(res, toolCallId, isVapiEnvelope, { found: false, error: "unknown_customer_id" });
  }

  return respond(res, toolCallId, isVapiEnvelope, {
    found: true,
    loan_type: record.loan_type,
    overdue_amount: record.overdue_amount,
    days_past_due: record.days_past_due,
    account_number_masked: record.account_number.replace(/\d(?=\d{4})/g, "•"),
  });
});

// ---------------------------------------------------------------------------
// 3. log_promise_to_pay
// ---------------------------------------------------------------------------
app.post("/tools/log_promise_to_pay", (req, res) => {
  const { args, toolCallId, isVapiEnvelope } = extractArgs(req);

  // Safety net: never accept a commitment date in the past. The prompt tells
  // the model today's date, but this catches any miscalculation server-side
  // rather than trusting the LLM's arithmetic alone (defense in depth, same
  // pattern as the auth gate).
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const ptpDate = new Date(args.ptp_date);
  if (isNaN(ptpDate.getTime()) || ptpDate < today) {
    logEvent({ tool: "log_promise_to_pay", args, rejected: true, reason: "ptp_date_invalid_or_past" });
    return respond(res, toolCallId, isVapiEnvelope, {
      success: false,
      error: "ptp_date_invalid_or_past",
      message: "ptp_date must be a valid, present-or-future date (YYYY-MM-DD).",
    });
  }

  const entry = { ...args, logged_at: new Date().toISOString() };
  ptpLog.push(entry);

  logEvent({ tool: "log_promise_to_pay", args });

  return respond(res, toolCallId, isVapiEnvelope, {
    success: true,
    ptp_id: `ptp_${ptpLog.length}`,
  });
});

// ---------------------------------------------------------------------------
// 4. send_payment_link
// ---------------------------------------------------------------------------
app.post("/tools/send_payment_link", (req, res) => {
  const { args, toolCallId, isVapiEnvelope } = extractArgs(req);
  const record = MOCK_DB[args.customer_id];
  const link = `https://pay.kapturefinance.example/${args.customer_id}?amt=${args.amount || ""}`;

  // Mock send — replace with a real SMS/WhatsApp API (e.g. Twilio, Gupshup) in production.
  logEvent({
    tool: "send_payment_link",
    args,
    simulated_message: record
      ? `[MOCK ${args.channel || "sms"} to ${record.full_name}] Pay ₹${args.amount} here: ${link}`
      : `[MOCK send] unknown customer`,
  });

  return respond(res, toolCallId, isVapiEnvelope, { success: true, link });
});

// ---------------------------------------------------------------------------
// 5. escalate_to_agent
// ---------------------------------------------------------------------------
app.post("/tools/escalate_to_agent", (req, res) => {
  const { args, toolCallId, isVapiEnvelope } = extractArgs(req);

  logEvent({ tool: "escalate_to_agent", args });

  // In production: trigger a SIP REFER/transfer via Vapi's transferCall mechanism,
  // or push to a human-agent queue (e.g. a CRM ticket / Slack alert) here.
  return respond(res, toolCallId, isVapiEnvelope, {
    success: true,
    queued_for: "human_collections_queue",
    reason: args.reason,
  });
});

// ---------------------------------------------------------------------------
// 6. mark_disposition
// ---------------------------------------------------------------------------
app.post("/tools/mark_disposition", (req, res) => {
  const { args, toolCallId, isVapiEnvelope } = extractArgs(req);
  const entry = { ...args, ts: new Date().toISOString() };
  dispositions.push(entry);

  logEvent({ tool: "mark_disposition", args });

  return respond(res, toolCallId, isVapiEnvelope, { success: true });
});

// ---------------------------------------------------------------------------
// Observability endpoints (bonus: quick way to eyeball what happened)
// ---------------------------------------------------------------------------
app.get("/observability/logs", (req, res) => res.json(callLogs));
app.get("/observability/ptps", (req, res) => res.json(ptpLog));
app.get("/observability/dispositions", (req, res) => res.json(dispositions));
app.get("/observability/metrics", (req, res) => {
  const total = dispositions.length;
  const ptpCount = dispositions.filter((d) => d.disposition === "ptp_confirmed").length;
  const escalated = dispositions.filter((d) => d.disposition === "escalated_to_human").length;
  res.json({
    total_calls: total,
    ptp_rate: total ? (ptpCount / total).toFixed(2) : null,
    containment_rate: total ? (1 - escalated / total).toFixed(2) : null,
    dispositions_breakdown: dispositions.reduce((acc, d) => {
      acc[d.disposition] = (acc[d.disposition] || 0) + 1;
      return acc;
    }, {}),
  });
});

app.get("/", (req, res) => res.send("Kapture collections voicebot mock tool server is running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Kapture mock tool server listening on port ${PORT}`));
