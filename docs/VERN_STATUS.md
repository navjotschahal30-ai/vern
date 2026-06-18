# Vern Project Status

**Last Updated:** 2026-06-17
**Status:** Core qualification engine complete, ready for state machine + cadence

## Completed ✅

### Schema & Data Model
- LeadProfile interface (leadId, firstName, lastName, source, intent, timeline, properties, form responses)
- phone field (from Lofty lead)
- touchHistory array (calls, notes, emails, property views, with isHuman flag)
- engagement object (lastHumanTouchAt, lastAnyTouchAt, 60-day counts)

### Handlers & Normalization
- loftyWebhookHandler() — fetches 5 Lofty endpoints in parallel (lead, notes, calls, emails, activities)
- normalizeLeadProfile() — builds full LeadProfile with touch history from all sources
- Compliance checks — DNC, agent assigned, under contract detection

### Qualification Engine
- qualifiesForHot() — phone + ≤90d human touch + (≥2 intake fields OR 60d engagement)
- qualifiesForWarm() — phone + (≥1 intake field OR engagement OR never called)
- qualifiesForGhost() — 180+ days no human touch (or 180+ days in CRM if never touched)
- Win-back detection — hot leads in 30-90d window flagged for reactivation
- Scoring 0-100 (ranks within status, never gates)
- 9/9 tests passing (Navjot lead, DNC, buyer agent, contract, assigned, ghost, win-back, warm)

### Outreach Foundation
- smsExecutor.ts (Lofty SMS API)
- emailExecutor.ts (Lofty email API + signature)
- templates.ts (SMS/email by source + intent + status)
- selectTemplateKey() (picks template)

## In Progress 🔄

None — ready to move forward

## Not Started ⬜

### Critical Path
- **State Machine** — track lead lifecycle (new → qualified → engaged → contacted → dormant → ghost)
- **Cadence Manager** — enforce frequency caps (1 SMS/3d hot, 1 email/week, etc.), schedule outreach
- **Event Listener** — subscribe to all Lofty webhooks (not just lead updates)
- **Daily Command Center** — report hot/warm/ghost lists, why-calling reasons, opening lines

### Deployment
- GitHub repo setup (navjot/vern)
- Railway deployment config (.env secrets, startup)
- First commit

## Data Dependencies

- **LOFTY_API_KEY** (production only)
- **LOFTY_TEAM_ID** = 400919269340348

## Next Steps (Priority Order)

1. Build state machine (lead lifecycle tracking)
2. Build cadence manager (outreach frequency + scheduling)
3. Build event listener (all webhook types)
4. Build daily command center output
5. Create GitHub repo + commit everything
6. Set up Railway deployment
7. Deploy and test against real leads

## Architecture Notes

- LeadProfile is the contract all agents consume
- Qualification is signal-based (not timeline-based) — matches CRM Agent proven logic
- Touch history distinguishes human from automated activity
- Score ranks within status but never gates it
- All outreach via Lofty API (SMS, email)
