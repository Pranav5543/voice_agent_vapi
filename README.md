#  Voice Agent - (Vapi) — README

 

## What's in this folder

```
Voice_agent_vapi/
├── HLD_Collections_Voicebot.docx   # Task 1 — design document
├── diagrams/
│   ├── architecture.png            # pipeline diagram
│   └── state_machine.png           # conversation state machine
├── prompts/
│   └── system_prompt.md            # Task 2 — final Vapi system prompt
├── tools_schema.json               # Task 2 — 6 function/tool JSON schemas
├── server/
│   ├── server.js                   # mock webhook implementing all 6 tools
│   └── package.json
└── README.md                       # this file
```

## Setup (what I did / what you need to do to reproduce the live demo)

1. **Webhook server.** `server/server.js` is an Express app implementing
   `verify_customer`, `get_account_details`, `log_promise_to_pay`,
   `send_payment_link`, `escalate_to_agent`, and `mark_disposition` against
   an in-memory mock record for Rahul Sharma (loan `KF-PL-778821`, EMI
   ₹8,499, 12 days past due).

   **Run it locally:**

   ```
   cd server
   npm install
   node server.js
   ```

   You should see: `Kapture mock tool server listening on port 3000`

   **Expose it publicly with ngrok** (so Vapi's webhooks can reach it):

   Download ngrok from https://ngrok.com/download and unzip it.

   One-time setup — add your authtoken (shown on your ngrok dashboard
   after signup):

   ```
   ngrok config add-authtoken <your-token>
   ```

   Start the tunnel in a **second terminal** (keep the server running in
   the first one):

   ```
   ngrok http 3000
   ```

   Copy the `https://....ngrok-free.app` (or `.dev`) forwarding URL it
   prints — that's your public webhook base. Both terminals must stay
   open for the whole test/demo session; closing either breaks the
   tunnel.

   Paste `<that-url>/tools/<tool_name>` into each tool's `server.url`
   field in Vapi (see `tools_schema.json` — currently has
   `<your-webhook-host>` placeholders to replace).

   Render/Railway are viable alternatives if you'd rather not keep a
   laptop terminal open — push the `server/` folder as its own repo and
   deploy on their free tier for a persistent URL instead.
2. **Vapi assistant.** In the Vapi dashboard: created a new assistant,
   pasted `prompts/system_prompt.md` as the system prompt, added the 6
   tools from `tools_schema.json` (with the `server.url` fields pointed at
   my public webhook URL), and set:

   - **Model:** GPT-4o — good instruction-following for state-locking
     (auth-before-disclosure) and reliable structured tool-calls, low
     enough latency for a phone conversation.
   - **Voice:** ElevenLabs Turbo v2.5 — fast enough (~150–300ms) to keep
     turn-taking natural, and handles Hindi/English code-switching
     reasonably well for the bilingual bonus.
   - **Transcriber:** Deepgram Nova-2 — good Indian-English/Hindi accent
     handling and low latency compared to alternatives I tried.
3. **Test calls.** Used Vapi's outbound test-call feature (web call / or a
   real number via the free trial credits) to run through: a successful
   promise-to-pay path, and an edge case (dispute / already-paid /
   wrong-person).
4. **Demo recording.** [Link to Vapi call recording or Loom — paste here]

> If you're reproducing this: steps 2–4 have to be done by hand in the Vapi
> dashboard and by actually placing a call — that's the ~5% that can't be
> scripted. Everything else in this repo (prompt, schemas, server, design
> doc, diagrams) is ready to paste in as-is.

## Design choices

- **Auth is state-enforced, not prompt-discretionary.** The system prompt
  hard-gates `get_account_details` / disclosure behind a successful
  `verify_customer` tool call — the model is instructed to never reveal
  debt info without a `verified: true` result in-session, and the mock
  server independently refuses to serve account details for a customer_id
  that wasn't actually returned by verification. This means even if the
  LLM is talked past its instructions, the *backend* still won't leak data
  to an unverified caller — defense in depth rather than trusting the
  prompt alone.
- **Every call ends in a disposition.** `mark_disposition` is called on
  every exit path (wrong-person, auth-failed, voicemail, do-not-call,
  hostile, escalated, PTP-confirmed) so no call is ever "silently lost" —
  this is what powers the observability metrics below.
- **Escalation over improvisation.** Hardship and unresolved disputes are
  routed to a human rather than letting the bot negotiate restructuring
  terms or argue facts it can't verify — safer for compliance and for the
  customer relationship.
- **Tool-response envelope.** The server accepts both Vapi's real
  `message.toolCallList` webhook shape *and* flat JSON bodies, so I could
  `curl` each tool directly during development without needing a live call
  every time I changed something.

## What broke and how I debugged it

- Vapi's webhook payload shape for tool calls has varied between docs
  examples and what's actually sent (`toolCallList` vs. older
  `toolCalls[].function.arguments`, and `arguments` sometimes arrives as a
  JSON string rather than an object). I made `extractArgs()` in
  `server.js` defensively handle both shapes and both string/object
  arguments, and added a flat-body fallback so I could smoke-test each
  endpoint with plain `curl` before wiring up a real call — this caught a
  parsing bug early instead of during a live phone call.
- Early prompt drafts let the model disclose the loan amount if the caller
  simply *claimed* to be Rahul Sharma confidently. Fixed by making the
  rule explicit and absolute ("never disclose ... until verify_customer
  has returned verified: true") rather than implying it, and by having the
  backend enforce it independently as above — prompts alone are talkable-
  around, so I didn't rely on wording strength alone.
- [Add your own notes here from the actual Vapi test calls — e.g. any
  latency issues, transcription errors on "₹8,499", interruption handling,
  or webhook timeout tuning you had to do.]

## What I'd improve with more time

- Replace the in-memory mock DB with a real LMS lookup and idempotency
  keys on `log_promise_to_pay` (avoid double-logging on retried tool
  calls).
- Add a real SIP transfer for `escalate_to_agent` instead of just queuing,
  with a whisper/warm-handoff of the call summary to the human agent.
- Add server-side rate limiting / call-attempt caps per account per day to
  reinforce fair-collection-practice norms beyond the prompt.
- Add signature verification on the incoming webhook (Vapi supports a
  shared secret) so the tool server only accepts genuine Vapi requests.
- Build the eval framework below out into an actual automated test suite
  running against Vapi's test-call API on every prompt change.

## Bonus: bilingual handling (EN/HI)

The system prompt instructs the model to detect the caller's language from
their speech and mirror it turn-by-turn, keeping amounts and dates clearly
enunciated. ElevenLabs Turbo v2.5 and Deepgram Nova-2 were chosen partly
because they handle Hindi/English code-switching without needing a
separate language-detection step or assistant swap mid-call.

## Bonus: mock payment-link trigger

`send_payment_link` in `server.js` simulates an SMS/WhatsApp send (logged
to console / `/observability/logs`) rather than calling a real gateway —
swap in Twilio/Gupshup/a WhatsApp Business API call to make it real.

## Bonus: testing at scale — how I'd evaluate this

1. **Scripted persona test-set.** ~15–20 scripted caller personas covering
   every S3 branch (cooperative payer, hardship, disputer, already-paid,
   wrong-person, do-not-call, hostile, voicemail, mid-call language
   switch) run against the Vapi assistant via its test-call / simulation
   API, with transcripts captured automatically.
2. **Automated assertions per persona**, e.g.:
   - Auth-gate: assert no overdue amount appears in the transcript before
     a `verify_customer` tool-call with `verified:true` appears.
   - Disposition coverage: assert exactly one `mark_disposition` call per
     transcript, with the disposition code matching the persona's branch.
   - Compliance: assert no threatening/pressure phrases (keyword +
     LLM-judge check) appear in any assistant turn.
   - Latency: assert p50/p95 turn latency stays under budget from the HLD.
3. **LLM-as-judge scoring** on a rubric (empathy, clarity, staying on
   script, correct tool sequencing) for the free-text portions, spot-
   checked by a human reviewer weekly.
4. **Regression gate.** Any system-prompt or tool-schema change must pass
   the full persona suite before shipping — track pass-rate over time
   alongside the production metrics (containment, PTP rate, drop rate)
   from the HLD's observability section.

## Assumptions made (per the assignment's "make a reasonable assumption"

guidance)

- Treated `dob_or_last4_id` as either date-of-birth or last-4-of-loan-a/c,
  since the assignment didn't specify which identity factor the client
  uses — a real deployment would confirm this with Kapture Finance's
  compliance team.
- Assumed calling-hours enforcement happens upstream in the dialer, not in
  the bot itself, since the bot only runs once a call is already connected.
- Assumed India-based fair-collection norms (RBI-style guidance: no
  contact outside 8am–7pm, no harassment, mandatory identification) given
  the ₹ currency and Hindi/English bonus — not a specific named regulation,
  since none was cited in the brief.
