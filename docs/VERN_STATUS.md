# Vern Project Status

**Last Updated:** 2026-06-19
**Status:** PRODUCTION LIVE
**Latest commit:** `5e5a30f` — "Wire GitHub Actions to trigger /cadence/daily at 9am ET daily" (2026-06-19 11:47 ET)

---

## Section 1: Overview

**What Vern is:** Vern is a lead lifecycle automation agent for real estate. It connects to Lofty (the CRM) to ingest leads and lead activity, qualifies each lead's status (hot/warm/ghost), enforces compliance and frequency rules, and sends personalized SMS/email outreach without a human touching every lead every day. It runs as the always-on follow-up layer underneath Navjot's CRM.

**Core thesis:** Generic CRM "AI assistant" follow-up reads as a bot — it doesn't know the agent's voice, market, or relationship history with a specific lead. Vern's bet is that giving a CRM's automation an agent's actual local voice (Navjot's name, market language, real listings the lead viewed) — instead of a templated marketing blast — is what makes automated outreach get treated as a real follow-up instead of spam.

**Current status:** PRODUCTION LIVE. Deployed to Railway, processing Navjot's full assigned-lead roster from Lofty, sending real SMS/email to leads (TEST_MODE is off), and triggered automatically once daily via GitHub Actions.

---

## Section 2: Architecture

| Component | File | Role |
|---|---|---|
| **LeadProfile schema** | `src/schemas/leadProfile.ts` | Normalized lead shape built from 5 Lofty endpoints fetched in parallel: lead record, notes, call history, email history, activity timeline (+ text history) — see `fetchLeadProfile()` in `src/handlers/loftyWebhookHandler.ts`. |
| **Qualification engine** | `src/engines/qualificationEngine.ts` | Signal-based (not pure timeline) status decisioning: **hot** (phone + ≤90d engagement + intake/engagement signal), **warm** (phone + partial signal), **ghost** (180+ days since real human contact) + **win-back** detection (hot lead, 30–90d since last human touch). Produces a 0–100 score that ranks within status but never gates it. |
| **Compliance rules** | `src/config/compliance.ts` | DNC/opt-out detection, buyer/listing-agent and under-contract checks, manual-block tag checks, plus timing rules: SMS frequency caps (3d hot / 7d warm), email cap (7d), 24h blanket cooldown across channels, and SMS business-hours window (8am–8pm ET, Mon–Fri). A `COMPLIANCE-OVERRIDE` tag bypasses all of it for a manually-cleared lead. |
| **State machine** | `src/engines/stateEngine.ts` | Tracks Vern's own state directly as Lofty tags (no separate DB): `VERN-STATE:<hot\|warm\|ghost>`, `VERN-LAST-SMS:<iso>`, `VERN-LAST-EMAIL:<iso>`, `VERN-CONTACTED-TODAY`. All writes are idempotent (replace-by-prefix, not append). |
| **SMS/email executors + templates** | `src/outreach/smsExecutor.ts`, `src/outreach/emailExecutor.ts`, `src/config/templates.ts` | Sends via Lofty's messaging API (`/v1.0/message/sms/send`, `/v1.0/message/email/send`). Templates are keyed by source + intent + status (`website_buyer_hot`, `facebook_buyer_warm`, `ghost_reactivation`, plus generic hot/warm/cold fallbacks) and reference real signals (property address, city) rather than generic openers. Email appends Navjot's signature, matching IDX Stalker's existing sign-off. |
| **Cadence manager** | `src/engines/cadenceManager.ts` | `buildCadenceDetailed()` does one pass per lead: qualify → check hard violations (skip) → check timing violations (delay, not skip) → pick channel → compute `sendAfter`. `executeCadence()` re-fetches each scheduled lead right before sending (avoids acting on stale data) and only sends if `sendAfter` has actually arrived. |
| **Event listener** | `src/handlers/eventListener.ts` | Single webhook entry point (`POST /webhook`) for non-lead-update events. Detects inbound SMS "STOP" replies and email-unsubscribe events, tags the lead `DNC` + `VERN-STATE:ghost`. Call/note/stage events are logged only (cadence rebuild on event is not yet wired). |
| **Daily command center report** | `src/engines/dailyCommandCenter.ts` | Human-readable report (`GET /daily-report`): today's hot-call queue (top 5 by score), warm/ghost queue counts, and an actions-needed list of hard skips/failures. Built from the same `buildCadenceDetailed()` pass — no second lead fetch. |
| **GitHub Actions cron** | `.github/workflows/daily-cadence.yml` | Schedules `0 13 * * *` (9am ET / 13:00 UTC) daily, `POST`s to `/cadence/daily`, logs the HTTP status and response body, fails the job on a non-2xx response. Added in commit `5e5a30f`. |

**Request flow for the daily run:** GitHub Actions cron → `POST /cadence/daily` (`src/app.ts`) → `fetchAssignedLeadIds()` (`GET /v1.0/leads?assignedUserId=844770719757219&limit=500` on Lofty) → `executeCadence(leadIds)` → per-lead qualify/compliance/send → `{ executed, skipped }` JSON response.

---

## Section 3: What's Built & Tested

- **All Lofty API endpoints fixed** — auth header format (`Authorization: token <key>`, not `Bearer`), call/text history endpoints, SMS send, email send, tag read/write (commit `b757abc`).
- **API key sanitization** — strips non-ASCII characters (e.g. Unicode line separators from copy-paste) before building the auth header, fixing a recurring `ByteString` header error (commit `4203a97`).
- **SMS/email confirmed working end-to-end on a real lead** (Navjot's own test lead/phone/email, gated by `TEST_MODE`).
- **Frequency caps enforced and verified**: 3-day cap for hot-lead SMS, 7-day cap for warm-lead SMS and for email, 24-hour blanket cross-channel cooldown — verified via `test/compliance.smoke.ts` (`getNextValidSendTime` cases) and `test/cadenceManager.smoke.ts` (frequency-capped lead `E` stays scheduled with a delayed `sendAfter` rather than being dropped).
- **Tags persist to Lofty** — `VERN-STATE`, `VERN-LAST-SMS`, `VERN-LAST-EMAIL`, `VERN-CONTACTED-TODAY` read/write verified idempotent in `test/stateEngine.smoke.ts` (re-running `recordOutreach`/opt-out handling does not duplicate tags; original CRM tags are preserved untouched).
- **`executeCadence` respects `sendAfter` timing** — a frequency-capped lead is not sent early even if otherwise eligible (commit `27fd68f`).
- **TEST_MODE disabled in production** (`TEST_MODE=false` on Railway) — outreach goes live to all qualifying hot/warm/ghost leads, not just Navjot's own test contact.
- **6 test suites passing** (run via `npx ts-node <file>`, no `npm test` script defined yet):
  - `test/qualificationEngine.suite.ts` — 9/9 cases passing ("ALL TESTS PASSED"): Navjot lead, DNC, buyer agent, under contract, assigned-to-another-agent, ghost, win-back, warm (partial intake).
  - `test/compliance.smoke.ts` — hard/timing violation checks, `COMPLIANCE-OVERRIDE` bypass, `getNextValidSendTime` (clean lead, hot-lead SMS cap, no-phone-on-file sentinel), opt-out detection (`STOP`, unsubscribe).
  - `test/stateEngine.smoke.ts` — tag read/write/idempotency, daily-marker clearing, original-tag preservation.
  - `test/cadenceManager.smoke.ts` — full-batch qualify/compliance/schedule pass, priority ordering (hot > warm > ghost, score desc within status), simulated Lofty network failure isolated to one lead without aborting the batch.
  - `test/eventListener.smoke.ts` — SMS STOP opt-out, non-opt-out SMS (no action), email unsubscribe, re-run idempotency (no duplicate DNC tags).
  - `test/dailyCommandCenter.smoke.ts` — full report generation against a mixed hot/warm/ghost/DNC batch.
- **Typecheck clean** — `npx tsc --noEmit` passes with zero errors as of commit `5e5a30f`.

---

## Section 4: Production Deployment

- **GitHub:** [github.com/navjotschahal30-ai/vern](https://github.com/navjotschahal30-ai/vern) (branch `main`)
- **Railway:** `vern-production.up.railway.app` — project `remarkable-renewal`, service `vern`, environment `production`
- **Daily cron:** GitHub Actions, `.github/workflows/daily-cadence.yml`, `0 13 * * *` UTC (9am ET) → `POST https://vern-production.up.railway.app/cadence/daily`
- **Environment variables set on Railway** (`vern` service, `production` environment):
  - `LOFTY_API_KEY` — set
  - `LOFTY_TEAM_ID` = `844770719757219`
  - `TEST_MODE` = `false`
  - `NODE_ENV` = `production`
  - (plus Railway-managed vars: `RAILWAY_PUBLIC_DOMAIN`, `RAILWAY_PROJECT_NAME`, `PORT`, etc.)
- **Port handling:** app listens on `process.env.PORT || 3000` (standard Railway convention, replacing the old `VERN_PORT`). Railway auto-injects `PORT` at runtime; the service domain's target port must match it (currently `8080` — fixed 2026-06-21 after a target-port mismatch with the stale `3000` value caused a 502 on `/health`).

**Known operational note:** Railway also shows a native Cron Schedule attached to the `vern` service (`0 13 * * *`, "next run" tracked separately from deploys). Because the service's deploy command (`npm run start`) just boots the Express listener rather than exiting, that Railway-native schedule does not by itself guarantee `/cadence/daily` gets called — the GitHub Actions workflow above is the verified trigger mechanism for the daily run. The Railway dashboard's Cron Schedule command field should be checked/cleared to avoid relying on it as a second, unverified trigger path.

---

## Section 5: What's NOT Built (Post-Pilot)

- **LLM-generated SMS/email copy** — current templates are static, keyed by source + intent + status (`src/config/templates.ts`), not generated per-lead by a model.
- **Intake Agent** — for leads that don't originate from the website form (e.g. phone-in, referral, open-house sign-in); Vern currently assumes Lofty-normalized lead data is already present.
- **WhatsApp broadcast strategy** — no WhatsApp channel exists yet; SMS and email via Lofty are the only outreach channels.
- **Voice input for Mosaic Intelligence** — no voice/call-transcript ingestion path exists; touch history only reflects what Lofty logs from calls/notes, not live voice interaction.

---

## Section 6: Pilot Readiness

- **Recruitment target:** 4 agents for the pilot cohort.
- **Soak period:** 1 week of live operation per recruited agent before evaluating results.
- **Metrics collection:** baseline (pre-Vern) outreach/response metrics captured before activation, then post-pilot metrics captured after the 1-week soak, for a direct before/after comparison.
- **Case study rights:** a signed agreement with each pilot agent permitting use of their results as a case study is required before publishing any pilot outcomes.
