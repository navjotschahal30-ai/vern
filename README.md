# Vern

Vern is a lead lifecycle automation agent for real estate teams. It connects to Lofty (the CRM) to ingest leads and lead activity, applies decisioning logic to determine the right next action for each lead, and drives outreach (SMS, email) to keep leads engaged without manual follow-up.

## How it's organized

- `src/schemas/` — type definitions and validation schemas for leads, activities, and CRM payloads
- `src/handlers/` — entry points that receive events (webhooks, scheduled jobs) and route them to the right engine
- `src/engines/` — core decisioning logic: lead scoring, lifecycle stage transitions, follow-up timing
- `src/outreach/` — integrations and templates for contacting leads (SMS, email)
- `src/config/` — compliance rules, templates, environment config
- `test/` — comprehensive test suites (qualification, compliance, cadence, daily report)
- `docs/` — architecture checkpoints and status

## Setup

1. **Install dependencies:**
```bash
   npm install
```

2. **Configure environment:**
```bash
   cp .env.example .env
```
   Then edit `.env` and fill in:
   - `LOFTY_API_KEY` = your Lofty API key (from Lofty Settings > Integrations > API)
   - `LOFTY_TEAM_ID` = 400919269340348
   - `PORT` = 3000 (or your preferred port)
   - `NODE_ENV` = development

3. **Build and test:**
```bash
   npm run build
   npm test
```

4. **Run locally:**
```bash
   npm run dev
```

## Deployment (Railway)

1. Create a Railway project and connect this GitHub repo
2. Add environment variables in Railway settings:
   - `LOFTY_API_KEY` (from GitHub Secrets or set directly)
   - `LOFTY_TEAM_ID`
   - `NODE_ENV` = production

   Railway auto-injects `PORT` — no need to set it manually.
3. Railway will auto-deploy on push to `main`

## GitHub Secrets (for CI/CD)

If using GitHub Actions for automated deployment:

Go to your repo → Settings > Secrets and variables > Actions

Add:
- `LOFTY_API_KEY` = `<your-lofty-api-key>` (get this from Lofty Settings > Integrations > API — do not commit the real value)
- `LOFTY_TEAM_ID` = 400919269340348

## Architecture

- **LeadProfile** — normalized lead data from Lofty (phone, timeline, properties viewed, form responses, touch history)
- **Qualification Engine** — determines hot/warm/ghost status based on signal (phone + recency + engagement)
- **Compliance Rules** — enforces DNC, frequency caps (SMS 3d hot/7d warm, email 7d), business hours (SMS 8am-8pm ET Mon-Fri)
- **State Machine** — tracks lead state via Lofty tags (VERN-STATE:hot, VERN-LAST-SMS, VERN-LAST-EMAIL, VERN-CONTACTED-TODAY)
- **Cadence Manager** — builds daily outreach queue: schedules SMS/email respecting compliance + future send times
- **Event Listener** — handles inbound SMS replies (STOP → DNC tag), email unsubscribes
- **Daily Command Center** — reports today's hot calls, warm/ghost queues, and actions needed

## Current Status (June 25, 2026)

### Deployed
- **Navjot Vern**: https://navjot-vern-production.up.railway.app (tag-only mode)
- **Patty Vern**: https://patty-vern-production.up.railway.app (tag-only mode)
- **Mode**: Qualification + tagging only — SMS/email paused pending market data

### Qualification Targets (Per Agent, Daily)
- Hot leads: 10
- Warm leads: 20
- Ghost leads: 20
- Batching: Loops through all assigned leads until targets hit (fixed June 25)

### Tags Active
- `VERN-QUAL-HOT` / `VERN-QUAL-WARM` / `VERN-QUAL-GHOST` / `VERN-QUAL-BLOCKED`

### Blocked (Awaiting Lofty)
- **Market Data**: DLA token limited to eXp Realty listings only. VOW rejected. Awaiting Lofty support response for board-wide market data API access (24-48h ETA).
- **Outreach paused** until market data locked (ensures accurate, data-driven messaging)

### Not Yet Done
- Email domain config (`teamMosaic.ca` SPF/DKIM)
- SMS via Twilio
- Mosaic Intelligence SMS integration

## License

Proprietary — Team Mosaic, eXp Realty
