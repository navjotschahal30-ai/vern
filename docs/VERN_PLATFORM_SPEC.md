# Vern Platform Specification

**Vern** is a multi-tenant SaaS platform that gives real estate brokerages and teams an AI agent ("Vern") that converses with inbound/outbound leads over SMS (and later voice/email), qualifies them, and syncs activity into the brokerage's existing CRM (Lofty, Follow Up Boss, Pipedrive). Each human real estate agent on a tenant gets their own scoped AI persona, lead pool, and conversation history.

This document is the canonical architecture reference. It should be detailed enough to build the system from scratch and stable enough to link back to during implementation.

---

## 1. System Architecture Overview

### 1.1 Components

```
                                   ┌─────────────────────┐
                                   │   Web Dashboard      │
                                   │ (Next.js, tenant UI)  │
                                   └─────────┬────────────┘
                                             │ HTTPS (JWT)
                                   ┌─────────▼────────────┐
                                   │     API Gateway       │
                                   │ (Auth, rate limit,    │
                                   │  tenant resolution)   │
                                   └─────────┬────────────┘
              ┌──────────────────────────────┼──────────────────────────────┐
              │                              │                              │
    ┌─────────▼─────────┐        ┌──────────▼──────────┐         ┌─────────▼─────────┐
    │  Agent Service     │        │ Conversation Engine  │         │  CRM Sync Service  │
    │ (CRUD agents,      │        │ (LLM orchestration,   │        │ (adapters: Lofty,  │
    │  scoping, settings)│        │  qualification FSM)   │        │  FUB, Pipedrive)   │
    └─────────┬─────────┘        └──────────┬───────────┘         └─────────┬─────────┘
              │                              │                              │
              │                   ┌──────────▼───────────┐                  │
              │                   │  Messaging Gateway     │                 │
              │                   │ (Twilio SMS/voice,     │                 │
              │                   │  SendGrid email)       │                 │
              │                   └──────────┬───────────┘                  │
              │                              │                              │
              │                   ┌──────────▼───────────┐                  │
              └──────────────────►│  Compliance Engine     │◄─────────────────┘
                                  │ (TCPA/CASL gate,        │
                                  │  consent, quiet hours)  │
                                  └──────────┬───────────┘
                                             │
                       ┌─────────────────────┼─────────────────────┐
                       │                     │                     │
              ┌────────▼────────┐  ┌─────────▼────────┐  ┌─────────▼────────┐
              │  Job Queue        │  │  Billing/Metering  │  │  Audit/Event Log  │
              │ (BullMQ + Redis)  │  │ (Stripe + usage)   │  │  (append-only)    │
              └────────┬────────┘  └─────────┬────────┘  └─────────┬────────┘
                       │                     │                     │
                       └─────────────────────┼─────────────────────┘
                                             │
                                   ┌─────────▼────────────┐
                                   │   PostgreSQL (RLS)    │
                                   │   + Redis (cache/queue)│
                                   └────────────────────────┘
```

### 1.2 Tenancy model

- **Tenant** = a brokerage or team account. Top-level billing and isolation boundary.
- **Agent** = a human real estate agent inside a tenant. Owns leads, has a Vern persona (tone, signature, working hours), and a CRM connection (or inherits the tenant's shared CRM connection).
- All domain rows carry `tenant_id`; most carry `agent_id`. Isolation is enforced at the database layer (Postgres Row-Level Security), not just in application code — see [Section 9](#9-security--data-isolation).

### 1.3 Request flow (inbound SMS example)

1. Twilio webhook hits `POST /webhooks/twilio/sms` → API Gateway resolves tenant/agent by the receiving phone number.
2. Message persisted, job enqueued (`conversation.inbound`).
3. Conversation Engine worker picks up the job, loads conversation state + lead profile, runs the qualification FSM (Section 5) through the LLM.
4. Compliance Engine gates any outbound reply (consent check, quiet hours, opt-out keyword detection) before it reaches the Messaging Gateway.
5. Reply sent via Twilio; message + any qualification state change persisted.
6. CRM Sync Service enqueues a job to push the updated lead/note/activity to the connected CRM adapter.
7. Usage event recorded for billing/metering.

### 1.4 Tech stack (assumed, for concreteness)

| Layer | Choice |
|---|---|
| API / workers | Node.js + TypeScript (NestJS or Fastify) |
| Conversation engine | Claude (Anthropic API), tool-use for qualification actions |
| Queue | BullMQ on Redis |
| DB | PostgreSQL 15+ with RLS |
| SMS/Voice | Twilio |
| Email | SendGrid or Postmark |
| Billing | Stripe (metered usage) |
| Secrets | per-tenant encrypted vault (KMS-backed) |
| Infra | Containers on ECS/Fly/Render; Terraform for IaC |

---

## 2. Data Models

All models include `tenant_id`. Timestamps (`created_at`, `updated_at`) are implicit on every model below unless noted.

### 2.1 `Agent`

Represents a human real estate agent and their Vern persona configuration.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK → Tenant |
| `user_id` | uuid | FK → User (the human's login) |
| `display_name` | string | Shown to leads, e.g. "Sarah from Acme Realty" |
| `persona_tone` | enum | `professional` \| `friendly` \| `concise` |
| `signature_block` | text | Appended to outbound messages |
| `phone_number` | string (E.164) | Twilio number assigned to this agent |
| `timezone` | string (IANA) | Used for quiet-hours enforcement |
| `working_hours` | jsonb | `{ "mon": ["09:00","18:00"], ... }` |
| `crm_connection_id` | uuid \| null | FK → CrmConnection; null = inherit tenant default |
| `qualification_template_id` | uuid | FK → QualificationTemplate |
| `status` | enum | `active` \| `paused` \| `disabled` |

### 2.2 `Lead`

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK |
| `agent_id` | uuid | FK → Agent (owning agent) |
| `crm_external_id` | string \| null | ID in the source CRM, for round-tripping |
| `crm_source` | enum | `lofty` \| `followupboss` \| `pipedrive` \| `manual` |
| `first_name`, `last_name` | string | |
| `phone` | string (E.164) | Unique per tenant |
| `email` | string \| null | |
| `source_channel` | enum | `sms` \| `email` \| `voice` \| `web_form` |
| `qualification_score` | integer 0–100 | Computed, see Section 5 |
| `qualification_tier` | enum | `hot` \| `warm` \| `cold` \| `unqualified` |
| `qualification_data` | jsonb | Structured answers: budget, timeline, financing, location, motivation |
| `consent_status` | enum | `granted` \| `revoked` \| `pending` \| `unknown` — drives Compliance Engine |
| `last_contacted_at` | timestamptz | |
| `stage` | enum | `new` \| `contacted` \| `engaged` \| `qualified` \| `handed_off` \| `lost` |

### 2.3 `Message`

Immutable record of every inbound/outbound communication. Append-only (no updates/deletes — corrections are new rows referencing `corrects_message_id`).

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK |
| `lead_id` | uuid | FK |
| `agent_id` | uuid | FK |
| `direction` | enum | `inbound` \| `outbound` |
| `channel` | enum | `sms` \| `email` \| `voice` |
| `body` | text | |
| `template_id` | uuid \| null | FK → MessageTemplate, if generated from one |
| `provider_message_id` | string | Twilio/SendGrid message SID, for delivery status correlation |
| `delivery_status` | enum | `queued` \| `sent` \| `delivered` \| `failed` \| `undelivered` |
| `compliance_check_id` | uuid \| null | FK → ComplianceCheck (outbound only) |
| `sent_at` | timestamptz | |

### 2.4 `Compliance` (consent + check records)

Two related models:

**`ComplianceConsent`** — durable record of a lead's consent state over time (append-only log, not mutated in place, to satisfy audit requirements).

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | |
| `lead_id` | uuid | FK |
| `consent_type` | enum | `tcpa_express_written` \| `tcpa_express_oral` \| `casl_express` \| `casl_implied` |
| `event` | enum | `granted` \| `revoked` (e.g. lead texted STOP) |
| `source` | string | e.g. `"web_form_field"`, `"sms_opt_in_keyword"`, `"crm_import_flag"` |
| `evidence_ref` | string \| null | Pointer to stored proof (form submission ID, recorded call URL) |
| `recorded_at` | timestamptz | |

**`ComplianceCheck`** — the gate evaluation run immediately before every outbound send.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | |
| `lead_id` | uuid | |
| `rule_set` | enum | `tcpa` \| `casl` (determined by lead's region) |
| `result` | enum | `pass` \| `blocked_no_consent` \| `blocked_quiet_hours` \| `blocked_opted_out` \| `blocked_dnc` |
| `checked_at` | timestamptz | |

---

## 3. CRM Adapter Interface + Implementations

### 3.1 Interface

All CRM integrations implement a common adapter contract so the rest of the platform never special-cases a vendor.

```typescript
// packages/crm-adapters/src/types.ts

export interface CrmLead {
  externalId: string;
  firstName: string;
  lastName?: string;
  phone?: string;
  email?: string;
  source?: string;
  notes?: string;
  customFields?: Record<string, unknown>;
}

export interface CrmActivity {
  externalLeadId: string;
  type: 'note' | 'call' | 'sms' | 'email' | 'status_change';
  body: string;
  occurredAt: string; // ISO-8601
}

export interface CrmWebhookEvent {
  type: 'lead.created' | 'lead.updated' | 'lead.deleted';
  payload: unknown; // raw vendor payload, mapped by the adapter
}

export interface CrmAdapter {
  readonly providerName: 'lofty' | 'followupboss' | 'pipedrive';

  /** Validate stored credentials still work; called on connection setup and periodically. */
  authenticate(connection: CrmConnectionConfig): Promise<boolean>;

  /** Pull leads created/updated since a cursor (timestamp or vendor cursor token). */
  fetchLeads(connection: CrmConnectionConfig, since?: string): Promise<CrmLead[]>;

  /** Create a new lead in the CRM, return the vendor's external ID. */
  pushLead(connection: CrmConnectionConfig, lead: CrmLead): Promise<string>;

  /** Update an existing lead (status, qualification fields, etc). */
  updateLead(connection: CrmConnectionConfig, externalId: string, patch: Partial<CrmLead>): Promise<void>;

  /** Log a Vern conversation/activity onto the CRM lead's timeline. */
  pushActivity(connection: CrmConnectionConfig, activity: CrmActivity): Promise<void>;

  /** Register (or verify) a webhook subscription for real-time lead events. */
  subscribeWebhook(connection: CrmConnectionConfig, callbackUrl: string): Promise<void>;

  /** Translate a raw inbound webhook payload into a normalized event. */
  parseWebhook(rawBody: unknown, headers: Record<string, string>): CrmWebhookEvent;
}

export interface CrmConnectionConfig {
  tenantId: string;
  credentials: Record<string, string>; // decrypted at call time, never logged
  vendorAccountId?: string;
}
```

Adapters are registered in a factory so the sync service is vendor-agnostic:

```typescript
// packages/crm-adapters/src/registry.ts
export const crmAdapterRegistry: Record<string, CrmAdapter> = {
  lofty: new LoftyAdapter(),
  followupboss: new FollowUpBossAdapter(),
  pipedrive: new PipedriveAdapter(),
};
```

### 3.2 Lofty adapter

- **Auth**: OAuth2 (Lofty Connect API). Store `access_token`/`refresh_token` per `CrmConnection`; refresh proactively 5 min before expiry.
- **Lead fetch**: `GET /api/v2/leads?updatedSince={cursor}` — paginated, cursor is `nextPageToken`.
- **Lead push**: `POST /api/v2/leads` — map `phone` → `phoneNumbers[0].number`, `email` → `emails[0].address`.
- **Activity log**: `POST /api/v2/leads/{id}/notes`.
- **Webhooks**: Lofty supports event subscriptions via `POST /api/v2/webhooks` with `events: ["lead.created","lead.updated"]`. Verify signature using the `X-Lofty-Signature` HMAC header against the connection's webhook secret.
- **Rate limits**: 600 req/min per account — adapter applies a token-bucket limiter shared across tenant's queue jobs.

### 3.3 Follow Up Boss adapter

- **Auth**: API key (Basic Auth, key as username, blank password). Stored encrypted; no refresh needed.
- **Lead fetch**: `GET /v1/people?sort=-updated&limit=100` (cursor via `offset`, FUB has no native "since" filter so adapter filters client-side by `updated`).
- **Lead push**: `POST /v1/people` with `source` set to `"Vern"` so FUB attribution reports stay accurate.
- **Activity log**: `POST /v1/notes` referencing `personId`.
- **Webhooks**: FUB supports `POST /v1/webhooks` registration (events: `peopleCreated`, `peopleUpdated`). Payload has no signature header — adapter validates via a shared-secret query param appended at registration time.
- **Quirk**: phone numbers must be deduped against FUB's existing person records before create, else FUB silently merges — adapter does a `GET /v1/people?phone={phone}` pre-check.

### 3.4 Pipedrive adapter

- **Auth**: OAuth2 (Pipedrive Marketplace app) or API token (simpler, used for MVP). Start with API token; add OAuth when listing on the Pipedrive marketplace.
- **Lead fetch**: Pipedrive models leads as `Persons` + `Deals`. Adapter fetches `GET /v1/persons?sort=update_time DESC` for contact data and optionally creates a `Deal` when a lead reaches `qualified` stage.
- **Lead push**: `POST /v1/persons`, then `POST /v1/deals` only on qualification (keeps Pipedrive's deal pipeline clean — Vern doesn't create a deal for every cold lead).
- **Activity log**: `POST /v1/activities` with `type: "vern_conversation"` (custom activity type registered at app install time).
- **Webhooks**: `POST /v1/webhooks` (events: `added.person`, `updated.person`). Verify via Basic Auth credentials Pipedrive sends back on the webhook request itself.

### 3.5 Sync strategy

- Webhooks are the primary path for near-real-time updates; a polling fallback (`fetchLeads(since)`) runs every 15 minutes per tenant in case webhooks are dropped, registered against a `crm_sync_cursor` stored per `CrmConnection`.
- All writes from Vern → CRM are idempotent keyed by `crm_external_id`; conflicts (CRM record changed since last sync) are resolved CRM-wins for contact fields, Vern-wins for qualification/activity fields.

---

## 4. API Endpoints (per-agent scoped)

Base path: `/api/v1`. Auth: `Authorization: Bearer <JWT>`, JWT carries `tenant_id` and `agent_id` claims (or `role: tenant_admin` for cross-agent access). Every route below is implicitly scoped — the API never accepts a tenant/agent ID from the client that doesn't match the JWT's tenant.

### Agents
| Method | Path | Description |
|---|---|---|
| GET | `/agents` | List agents in caller's tenant |
| GET | `/agents/:agentId` | Get agent config |
| POST | `/agents` | Create agent (tenant admin only) |
| PATCH | `/agents/:agentId` | Update persona/settings |
| DELETE | `/agents/:agentId` | Soft-disable agent |

### Leads (scoped to agent)
| Method | Path | Description |
|---|---|---|
| GET | `/agents/:agentId/leads` | List leads, filterable by `stage`, `tier`, `q` |
| GET | `/agents/:agentId/leads/:leadId` | Lead detail incl. qualification_data |
| POST | `/agents/:agentId/leads` | Manually create a lead |
| PATCH | `/agents/:agentId/leads/:leadId` | Update stage/owner/notes |
| POST | `/agents/:agentId/leads/:leadId/handoff` | Mark qualified, notify human agent |

### Conversations & Messages
| Method | Path | Description |
|---|---|---|
| GET | `/agents/:agentId/leads/:leadId/messages` | Full message thread |
| POST | `/agents/:agentId/leads/:leadId/messages` | Send an outbound message (goes through Compliance Engine) |
| POST | `/agents/:agentId/leads/:leadId/messages/:id/retry` | Retry a failed send |

### Compliance
| Method | Path | Description |
|---|---|---|
| GET | `/agents/:agentId/leads/:leadId/consent` | Consent history |
| POST | `/agents/:agentId/leads/:leadId/consent` | Record manual consent capture (e.g. verbal at open house) |
| POST | `/agents/:agentId/leads/:leadId/opt-out` | Manually mark opted out |

### CRM connections (tenant-level, agent inherits unless overridden)
| Method | Path | Description |
|---|---|---|
| GET | `/crm-connections` | List tenant CRM connections |
| POST | `/crm-connections` | Create connection (provider + credentials) |
| POST | `/crm-connections/:id/test` | Run `authenticate()` |
| DELETE | `/crm-connections/:id` | Remove connection |

### Webhooks (inbound, unauthenticated by JWT — verified per-provider)
| Method | Path | Description |
|---|---|---|
| POST | `/webhooks/twilio/sms` | Inbound SMS |
| POST | `/webhooks/twilio/status` | Delivery status callbacks |
| POST | `/webhooks/crm/:provider/:tenantId` | Inbound CRM lead events |

### Billing/usage
| Method | Path | Description |
|---|---|---|
| GET | `/billing/usage` | Current period usage (messages, qualified leads) for tenant |
| GET | `/billing/invoices` | Invoice history (proxied from Stripe) |
| POST | `/billing/portal-session` | Create a Stripe billing portal link |

---

## 5. Qualification Algorithm

### 5.1 Inputs collected

The conversation engine drives a finite-state machine to extract five fields, in priority order, asking only for what's missing and skipping anything the CRM already supplied:

1. **Motivation** — why are they buying/selling (categorical: `relocating`, `upsizing`, `downsizing`, `investment`, `first_time`, `just_browsing`)
2. **Timeline** — `0-30d`, `1-3mo`, `3-6mo`, `6mo+`, `unknown`
3. **Financing** — `pre_approved`, `needs_approval`, `cash`, `unknown`
4. **Budget** — numeric range, normalized to tenant's local currency
5. **Location/property fit** — area(s) of interest, bed/bath, matches against agent's active listings if available

### 5.2 Scoring

Weighted point model, 0–100:

| Signal | Max points | Rule |
|---|---|---|
| Timeline | 30 | `0-30d`=30, `1-3mo`=22, `3-6mo`=12, `6mo+`=4, `unknown`=0 |
| Financing | 25 | `cash`=25, `pre_approved`=25, `needs_approval`=12, `unknown`=0 |
| Budget realism | 20 | 20 if stated budget is within ±15% of median price for stated area; 10 if within ±40%; 0 if no budget or wildly mismatched |
| Engagement | 15 | response latency + message count in first exchange: replies within 5 min and ≥3 substantive replies = 15; tapering scale down to 0 for single one-word reply |
| Motivation specificity | 10 | concrete motivation stated = 10; vague/`just_browsing` = 0 |

```
score = timeline_pts + financing_pts + budget_pts + engagement_pts + motivation_pts
```

### 5.3 Tiers

| Score | Tier | Action |
|---|---|---|
| 75–100 | `hot` | Immediate handoff notification to human agent (SMS/push), CRM stage set to "Hot Lead" |
| 45–74 | `warm` | Added to nurture drip (Section 6), re-qualification attempted in 14 days |
| 20–44 | `cold` | Long-cycle drip (monthly check-in), no handoff |
| 0–19 | `unqualified` | One soft follow-up, then marked `lost` after 2 non-responses |

### 5.4 Re-qualification

Score is recomputed after every substantive new answer (not every message) — a lead can move tiers mid-conversation. A move into `hot` triggers handoff regardless of where the conversation currently sits in the FSM.

### 5.5 FSM sketch

```
new ──(first outbound sent)──► contacted ──(lead replies)──► engaged
engaged ──(all 5 fields captured OR 2 follow-up attempts exhausted)──► qualified
qualified ──(tier == hot, on capture)──► handed_off
qualified ──(tier in {warm, cold})──► nurture loop (re-enters engaged on reply)
any state ──(no reply after N attempts per Section 6 cadence)──► lost
```

---

## 6. Message Templates

Templates live in `MessageTemplate` (tenant-overridable, with a global default set). Variables use `{{snake_case}}` interpolation; the rendering layer enforces a fallback for any missing variable.

| Template key | Trigger | Body |
|---|---|---|
| `initial_outreach` | New lead, first contact | `Hi {{first_name}}, this is {{agent_display_name}} with {{brokerage_name}} — I saw you were interested in {{listing_or_area}}. Mind if I ask a couple quick questions to help find the right fit? Reply STOP to opt out anytime.` |
| `qualify_timeline` | FSM needs timeline | `Got it! Are you hoping to move in the next month, or is this more of a 3–6 month plan?` |
| `qualify_financing` | FSM needs financing | `Are you already pre-approved with a lender, or would it help if I connected you with one?` |
| `qualify_budget` | FSM needs budget | `What price range are you comfortable targeting?` |
| `qualify_motivation` | FSM needs motivation | `What's prompting the move — relocation, more space, investment, something else?` |
| `follow_up_no_reply_1` | 24h no reply after outreach | `Hi {{first_name}}, just following up in case my last text got buried — happy to help whenever you're ready!` |
| `follow_up_no_reply_2` | 72h no reply | `No pressure at all, {{first_name}} — I'll check back in a bit. Feel free to reach out anytime in the meantime.` |
| `hot_handoff_to_lead` | Score crosses into `hot` | `Great talking with you, {{first_name}}! I'm going to have {{human_agent_name}} reach out directly to get you moving — talk soon.` |
| `nurture_warm_14d` | Warm lead, 14-day check-in | `Hi {{first_name}}, checking back in — has anything changed on your search timeline?` |
| `nurture_cold_monthly` | Cold lead, monthly check-in | `Hi {{first_name}}, hope you're doing well — still here whenever the timing's right for you.` |
| `opt_out_confirmation` | Lead replies STOP/UNSUBSCRIBE | `You've been unsubscribed and won't receive further messages from {{agent_display_name}}. Reply START to opt back in.` |
| `consent_request` | Lead from a source without prior express consent | `Hi, this is {{agent_display_name}} with {{brokerage_name}}. Reply YES if it's okay to text you about your home search, or STOP to opt out.` |

All outbound templates other than `opt_out_confirmation` pass through the Compliance Engine before send (Section 7).

---

## 7. Compliance Rules (TCPA, CASL)

The Compliance Engine is a hard gate: every outbound `Message` is evaluated by a `ComplianceCheck` before it reaches the Messaging Gateway. A `blocked_*` result aborts the send and surfaces in the agent dashboard for manual review — it never fails silently.

### 7.1 TCPA (US, Telephone Consumer Protection Act)

- **Consent**: Marketing SMS to a lead requires *prior express written consent* (`tcpa_express_written`) before any automated/templated message is sent. Inbound leads who text in first are treated as having initiated contact (implied consent for that thread only) but a `consent_request` template is still sent before any qualification/marketing content if no recorded consent exists.
- **Quiet hours**: No outbound message between 9:00 PM and 8:00 AM in the **lead's local timezone** (derived from area code / address; default to tenant timezone if unknown). Engine checks `quiet_hours` before every send, not just at conversation start.
- **Opt-out**: `STOP`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT` (case-insensitive, exact-word match) immediately sets `consent_status = revoked`, sends `opt_out_confirmation`, and blocks all future sends to that lead until a `START`/`UNSTOP` reply.
- **DNC registry**: Tenant-level optional National DNC scrub job runs nightly against numbers added in the last 24h for any tenant doing outbound *voice* (DNC applies to calls; SMS has separate carrier-level rules but the engine still flags it for agent awareness).
- **Recordkeeping**: Consent and revocation events are retained indefinitely (append-only `ComplianceConsent` table) — TCPA litigation lookback periods can exceed 4 years.

### 7.2 CASL (Canada, Anti-Spam Legislation)

- **Consent**: Default to *express* consent only (`casl_express`) for marketing CEMs (commercial electronic messages) sent to Canadian numbers/emails; *implied* consent (`casl_implied`, e.g. existing business relationship within 2 years) is accepted only if explicitly recorded with a source and an expiry date — the engine auto-expires implied consent and re-prompts.
- **Identification**: Every outbound message must be traceable to the sending agent/brokerage — enforced by always appending `signature_block` (agent name + brokerage) on first contact and at least once per 10-message thread.
- **Unsubscribe mechanism**: Must be available "at no cost" and processed within **10 business days** — engine processes opt-outs synchronously (effectively immediate) and logs the processing timestamp for audit.
- **Retention**: Consent records retained 3 years per CASL guidance (Vern retains indefinitely, exceeding the minimum, to also satisfy TCPA's longer lookback).

### 7.3 Engine logic (pseudocode)

```typescript
async function complianceGate(lead: Lead, message: OutboundDraft): Promise<ComplianceCheck> {
  const ruleSet = lead.region === 'CA' ? 'casl' : 'tcpa';

  if (lead.consentStatus === 'revoked') return block('blocked_opted_out');
  if (ruleSet === 'tcpa' && lead.consentStatus !== 'granted' && message.isMarketing) {
    return block('blocked_no_consent'); // falls back to sending consent_request instead
  }
  if (ruleSet === 'casl' && !hasValidCaslConsent(lead)) return block('blocked_no_consent');
  if (isWithinQuietHours(lead.timezone)) return block('blocked_quiet_hours');
  if (ruleSet === 'tcpa' && lead.channel === 'voice' && isOnDncRegistry(lead.phone)) {
    return block('blocked_dnc');
  }
  return pass();
}
```

A blocked, non-opt-out result for `blocked_quiet_hours` auto-reschedules the send for the next allowed window rather than dropping it.

---

## 8. Billing / Metering

### 8.1 Plan structure

- **Per-tenant subscription** (Stripe Subscription) with a base seat price per active `Agent`, plus metered overage on usage.
- Metered dimensions, each a Stripe Usage Record reported via a nightly aggregation job (and real-time for high-usage tenants):

| Metric | Unit | Notes |
|---|---|---|
| `messages_sent` | per outbound message | Excludes blocked/failed sends |
| `leads_qualified` | per lead reaching `qualified` stage | Counted once per lead per 90-day window (re-qualification doesn't double-bill) |
| `crm_sync_calls` | per API call to a CRM adapter | Mostly internal cost-tracking, soft-capped per plan tier |

### 8.2 Usage events

`UsageEvent` table is the source of truth; Stripe usage records are a downstream projection (never the source) so re-billing/credits/disputes can be recomputed from raw events.

```sql
CREATE TABLE usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  agent_id UUID,
  metric TEXT NOT NULL,         -- 'messages_sent' | 'leads_qualified' | 'crm_sync_calls'
  quantity INTEGER NOT NULL DEFAULT 1,
  ref_id UUID,                  -- message_id or lead_id, for audit/dedupe
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reported_to_stripe_at TIMESTAMPTZ
);
```

### 8.3 Overage & plan enforcement

- Each plan tier defines soft caps (warn at 80%, dashboard banner at 100%) and hard caps only for `crm_sync_calls` (to protect upstream CRM rate limits) — message sending is never hard-blocked by billing, since that would risk stranding an in-flight compliance-sensitive conversation (e.g. an opt-out confirmation must always be deliverable).
- Trial tenants get a hard cap on `messages_sent` (e.g. 200/mo) enforced at the Compliance Engine layer as an additional gate result (`blocked_plan_limit`).

---

## 9. Security & Data Isolation

- **Tenant isolation**: Postgres Row-Level Security on every tenant-scoped table; the application sets `SET LOCAL app.tenant_id = '<id>'` per request/transaction, and RLS policies (`USING (tenant_id = current_setting('app.tenant_id')::uuid)`) make cross-tenant reads/writes impossible even with an application bug. Connection pooler must support per-transaction `SET LOCAL` (e.g. pgbouncer in transaction mode requires care — verify or use session mode for this).
- **Credential storage**: CRM API keys/OAuth tokens encrypted at rest via envelope encryption (KMS data key per tenant); decrypted only in-process at call time, never logged. Twilio/SendGrid platform credentials are infra-level secrets, not per-tenant.
- **PII handling**: Lead phone/email are the primary PII surface. Encrypt `Lead.phone` and `Lead.email` columns at the application layer (deterministic encryption to preserve uniqueness constraints) in addition to disk-level encryption, so a DB dump alone doesn't expose contact lists.
- **RBAC**: Roles are `platform_admin` (Vern staff), `tenant_admin`, `agent` (scoped to own leads only). API layer enforces scope on every handler; agents can never query another agent's leads even within the same tenant unless `tenant_admin`.
- **Audit log**: Append-only `audit_logs` table records every write to `Lead`, `ComplianceConsent`, `CrmConnection`, and billing-affecting rows, with actor, before/after diff, and request ID — required both for compliance defense and for CRM-sync conflict debugging.
- **Webhook verification**: every inbound webhook (Twilio, CRM providers) is signature/secret verified before any DB write; unverified payloads are logged to a dead-letter queue, not processed.
- **Transport**: TLS everywhere; internal service-to-service calls inside a private VPC.

---

## 10. Database Schema

Core DDL (abbreviated; full migration set lives in `packages/db/migrations`).

```sql
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'trial',
  stripe_customer_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('platform_admin','tenant_admin','agent')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  user_id UUID NOT NULL REFERENCES users(id),
  display_name TEXT NOT NULL,
  persona_tone TEXT NOT NULL DEFAULT 'professional',
  signature_block TEXT,
  phone_number TEXT NOT NULL UNIQUE,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  working_hours JSONB NOT NULL DEFAULT '{}',
  crm_connection_id UUID,
  qualification_template_id UUID,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE crm_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  provider TEXT NOT NULL CHECK (provider IN ('lofty','followupboss','pipedrive')),
  encrypted_credentials BYTEA NOT NULL,
  webhook_secret TEXT,
  sync_cursor TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  crm_external_id TEXT,
  crm_source TEXT NOT NULL DEFAULT 'manual',
  first_name TEXT NOT NULL,
  last_name TEXT,
  phone TEXT NOT NULL,
  email TEXT,
  region TEXT NOT NULL DEFAULT 'US',
  source_channel TEXT NOT NULL,
  qualification_score INTEGER NOT NULL DEFAULT 0,
  qualification_tier TEXT NOT NULL DEFAULT 'unqualified',
  qualification_data JSONB NOT NULL DEFAULT '{}',
  consent_status TEXT NOT NULL DEFAULT 'unknown',
  stage TEXT NOT NULL DEFAULT 'new',
  last_contacted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone)
);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  lead_id UUID NOT NULL REFERENCES leads(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  channel TEXT NOT NULL DEFAULT 'sms',
  body TEXT NOT NULL,
  template_id UUID,
  provider_message_id TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'queued',
  compliance_check_id UUID,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE compliance_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  lead_id UUID NOT NULL REFERENCES leads(id),
  consent_type TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('granted','revoked')),
  source TEXT NOT NULL,
  evidence_ref TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE compliance_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  lead_id UUID NOT NULL REFERENCES leads(id),
  rule_set TEXT NOT NULL,
  result TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  agent_id UUID,
  metric TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  ref_id UUID,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reported_to_stripe_at TIMESTAMPTZ
);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  actor_user_id UUID,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  diff JSONB,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Example RLS policy (repeat per tenant-scoped table)
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON leads
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

Indexes of note: `leads(tenant_id, agent_id, stage)`, `messages(tenant_id, lead_id, sent_at)`, `usage_events(tenant_id, metric, occurred_at)` for billing aggregation queries.

---

## 11. Implementation Roadmap

### Phase 0 — Foundations (2–3 wks)
- Tenant/user/agent models, auth (JWT + RBAC), Postgres + RLS setup.
- Twilio SMS send/receive wired end-to-end (no AI yet — echo bot to validate pipeline).
- Compliance Engine skeleton: consent model, opt-out keyword handling, quiet hours.

### Phase 1 — MVP single-CRM (4–6 wks)
- Conversation Engine v1: LLM-driven qualification FSM (Section 5), one CRM adapter (Follow Up Boss — simplest auth).
- Message templates (Section 6), manual lead creation, basic dashboard (lead list, thread view).
- Billing: flat per-seat Stripe subscription, no metering yet.

### Phase 2 — Multi-CRM + compliance hardening (4 wks)
- Lofty + Pipedrive adapters, webhook-based sync with polling fallback.
- CASL rule set, region detection, consent expiry handling.
- Audit log, encrypted PII columns, security review.

### Phase 3 — Billing automation + scale (3–4 wks)
- Usage metering pipeline → Stripe usage records, billing portal, overage UX.
- Re-qualification loop, nurture drip scheduling (warm/cold cadences).
- Observability: structured logging, per-tenant usage dashboards, alerting on compliance block spikes.

### Phase 4 — Voice + advanced qualification (ongoing)
- Voice channel (Twilio Voice + transcription), DNC registry scrub job.
- ML-assisted budget realism scoring using live MLS comps instead of static medians.
- Multi-channel handoff (email) and agent-configurable qualification templates per listing type.

---

## 12. Code Directory Structure

```
vern/
├── apps/
│   ├── api/                      # Public REST API (NestJS/Fastify)
│   │   ├── src/
│   │   │   ├── agents/
│   │   │   ├── leads/
│   │   │   ├── messages/
│   │   │   ├── compliance/
│   │   │   ├── billing/
│   │   │   ├── webhooks/
│   │   │   └── auth/
│   │   └── test/
│   ├── worker/                   # BullMQ workers: conversation engine, CRM sync, billing aggregation
│   │   ├── src/
│   │   │   ├── conversation/
│   │   │   ├── crm-sync/
│   │   │   ├── billing/
│   │   │   └── compliance-jobs/
│   │   └── test/
│   └── dashboard/                # Next.js tenant-facing web app
│       └── src/
├── packages/
│   ├── db/                       # Drizzle/Prisma schema + migrations, RLS setup scripts
│   │   ├── migrations/
│   │   └── schema/
│   ├── crm-adapters/              # CrmAdapter interface + lofty/, followupboss/, pipedrive/
│   │   └── src/
│   │       ├── lofty/
│   │       ├── followupboss/
│   │       ├── pipedrive/
│   │       └── types.ts
│   ├── compliance/                # TCPA/CASL rule engine, quiet-hours calc, consent model
│   │   └── src/
│   ├── qualification/             # Scoring algorithm, FSM, template renderer
│   │   └── src/
│   ├── messaging/                 # Twilio/SendGrid clients, delivery status normalization
│   │   └── src/
│   └── shared/                    # Types, tenant context middleware, error classes
│       └── src/
├── infra/
│   ├── terraform/
│   └── docker/
└── docs/
    └── VERN_PLATFORM_SPEC.md      # this file
```
