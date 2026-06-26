# Vern Platform Status — June 25, 2026

Three agents live in Railway, all integrated with Lofty. This is the master status doc.

## Agents Deployed

### 1. Vern (Lead Lifecycle Agent)
- **Repos**: `navjot-vern`, `patty-vern` (separate Railway services)
- **URLs**: 
  - Navjot: https://navjot-vern-production.up.railway.app
  - Patty: https://patty-vern-production.up.railway.app
- **Status**: ✅ Live
- **Mode**: Tag-only (qualification + tagging, no outreach)
- **Targets**: 10 hot, 20 warm, 20 ghost per agent per day
- **Last update**: Batching logic (June 25) — loops through full roster to hit targets

### 2. Aria (Receptionist/Intake Chatbot)
- **Repo**: `navjot-receptionist-agent`
- **URL**: aria-production.up.railway.app
- **Status**: ✅ Live
- **Known issue**: Creates new Google Sheet per session (should reuse)

### 3. Content Agent (Market Intelligence)
- **Repo**: `navjot-content-agent`
- **HTTP API**: https://renewed-gratitude-production-0fb3.up.railway.app
- **Status**: ✅ Live
- **Pending**: Full TRREB board data (awaiting Lofty response on market data scope)

## Blockers (Priority Order)

### 🔴 Critical
**Market Data** — Outreach paused until Lofty provides board-wide market stats. DLA token limited to eXp Realty only. Email sent to Lofty, awaiting 24-48h response.

### 🟡 Important
**Email Domain** — `teamMosaic.ca` needs SPF/DKIM in Lofty. Awaiting Team Mosaic IT.

## Monthly Cost
~$5-10 (Railway + Lofty included)

## Next Steps (Priority Order)

1. **Lofty Market Data** (BLOCKING OUTREACH)
   - Get board-wide market stats access
   - Timeline: Awaiting response (24-48h)
   - Unblocks: Vern SMS/email outreach with accurate market messaging

2. **Email Domain Config** (COMPLIANCE)
   - Configure `teamMosaic.ca` SPF/DKIM in Lofty
   - Timeline: TBD (Team Mosaic IT)
   - Impact: Adds unsubscribe links to emails

3. **Aria Google Sheets Bug** (QUALITY)
   - Fix: Reuse existing sheet instead of creating new one per session
   - Impact: Consolidate lead logs, reduce Google Drive clutter
   - Timeline: Low priority

4. **SMS Setup** (FEATURE)
   - Wire Twilio to Aria + Vern
   - Cost: ~$0.0075/message
   - Timeline: After outreach unlocked

---
**Last Updated**: June 25, 2026
**Owner**: Navjot Singh, Team Mosaic
