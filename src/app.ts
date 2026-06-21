import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import { handleLoftyEvent } from './handlers/eventListener';
import { handleLoftyWebhook, fetchAssignedLeadIds, fetchLeadProfile, LoftyRateLimitError } from './handlers/loftyWebhookHandler';
import { executeCadence, SkippedLead } from './engines/cadenceManager';
import { qualifyLead, LeadQualification } from './engines/qualificationEngine';
import { generateDailyCommandCenter } from './engines/dailyCommandCenter';

dotenv.config();

const app = express();
app.use(express.json());

function sendError(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[app] request failed', error);
  res.status(500).json({ error: message, code: 500 });
}

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// Lofty has one webhook URL covering every event type it sends. A "lead
// updated" payload (payload.updatedLead) goes to handleLoftyWebhook, which
// returns a normalized LeadProfile; everything else (SMS replies, email
// unsubscribes, call/note/stage events — identified by payload.eventType)
// goes to handleLoftyEvent, which has no return value worth echoing back.
app.post('/webhook', async (req: Request, res: Response) => {
  try {
    const payload = req.body;

    if (payload?.updatedLead) {
      const leadProfile = await handleLoftyWebhook(payload);
      res.json({ status: 'processed', leadId: leadProfile.leadId });
      return;
    }

    await handleLoftyEvent(payload);
    res.json({ status: 'processed', eventType: payload?.eventType ?? null });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/cadence', async (req: Request, res: Response) => {
  try {
    const { leadIds } = req.body as { leadIds: string[] };
    const { executed, skipped } = await executeCadence(leadIds);
    res.json({ executed, skipped });
  } catch (error) {
    sendError(res, error);
  }
});

const NAVJOT_LOFTY_USER_ID = '844770719757219';

// Mirrors CRM Agent's daily roster logic: qualify the full assigned book,
// then take only the top-scoring leads per tier rather than contacting
// everyone every day.
const DAILY_ROSTER_CAPS: Record<'hot' | 'warm' | 'ghost', number> = { hot: 10, warm: 20, ghost: 20 };

// Throttles the qualification pass — fetching+qualifying all 681 leads at
// once would fire ~4000 concurrent Lofty requests. Batches of this size run
// their fetches in parallel (Promise.all) but batches themselves run one
// after another.
const DAILY_ROSTER_BATCH_SIZE = Number(process.env.DAILY_ROSTER_BATCH_SIZE) || 10;

// Lofty 429s show up batch-wide rather than on isolated leads, so a hit gets
// retried (only the rate-limited leads, not the whole batch) with doubling
// backoff before being recorded as a permanent skip.
const BATCH_RETRY_BASE_DELAY_MS = 2000;
const MAX_BATCH_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RosterCandidate {
  leadId: string;
  score: number;
}

type QualifyBatchResult =
  | { leadId: string; qualification: LeadQualification; error?: undefined; rateLimited?: undefined }
  | { leadId: string; qualification?: undefined; error: string; rateLimited: boolean };

async function qualifyLeadSafe(leadId: string): Promise<QualifyBatchResult> {
  try {
    const leadProfile = await fetchLeadProfile(leadId);
    return { leadId, qualification: qualifyLead(leadProfile) };
  } catch (error) {
    const rateLimited = error instanceof LoftyRateLimitError;
    const reason = error instanceof Error ? error.message : String(error);
    return { leadId, error: `FAILED: ${reason}`, rateLimited };
  }
}

async function qualifyBatchWithBackoff(batch: string[]): Promise<QualifyBatchResult[]> {
  let pending = batch;
  let settled: QualifyBatchResult[] = [];

  for (let attempt = 0; attempt <= MAX_BATCH_RETRIES; attempt++) {
    const results = await Promise.all(pending.map(qualifyLeadSafe));
    const rateLimited = results.filter((result) => result.rateLimited);
    settled = settled.concat(results.filter((result) => !result.rateLimited));

    if (rateLimited.length === 0 || attempt === MAX_BATCH_RETRIES) {
      return settled.concat(rateLimited);
    }

    await sleep(BATCH_RETRY_BASE_DELAY_MS * 2 ** attempt);
    pending = rateLimited.map((result) => result.leadId);
  }

  return settled;
}

/**
 * Qualifies every assigned lead — in batches of DAILY_ROSTER_BATCH_SIZE,
 * each fetched/qualified in parallel via Promise.all — then selects today's
 * roster once all batches are in: the top-scoring leads within each of the
 * hot/warm/ghost tiers (capped per DAILY_ROSTER_CAPS). Blocked/DNC leads and
 * leads that don't make a tier's cutoff are returned as skipped rather than
 * passed to executeCadence.
 */
async function buildDailyRoster(leadIds: string[]): Promise<{ selected: string[]; skipped: SkippedLead[] }> {
  const skipped: SkippedLead[] = [];
  const qualified: Array<{ leadId: string; qualification: LeadQualification }> = [];

  for (let i = 0; i < leadIds.length; i += DAILY_ROSTER_BATCH_SIZE) {
    const batch = leadIds.slice(i, i + DAILY_ROSTER_BATCH_SIZE);
    const results = await qualifyBatchWithBackoff(batch);

    for (const result of results) {
      if (result.error !== undefined) {
        skipped.push({ leadId: result.leadId, reason: result.error });
        continue;
      }
      qualified.push({ leadId: result.leadId, qualification: result.qualification });
    }
  }

  const byTier: Record<'hot' | 'warm' | 'ghost', RosterCandidate[]> = { hot: [], warm: [], ghost: [] };
  for (const { leadId, qualification } of qualified) {
    if (qualification.status === 'blocked' || !qualification.shouldContact) {
      skipped.push({ leadId, reason: qualification.reason });
      continue;
    }
    byTier[qualification.status].push({ leadId, score: qualification.score });
  }

  const selected: string[] = [];
  for (const tier of Object.keys(DAILY_ROSTER_CAPS) as Array<keyof typeof DAILY_ROSTER_CAPS>) {
    const cap = DAILY_ROSTER_CAPS[tier];
    const sorted = byTier[tier].sort((a, b) => b.score - a.score);

    selected.push(...sorted.slice(0, cap).map((candidate) => candidate.leadId));
    sorted.slice(cap).forEach((candidate, i) => {
      skipped.push({
        leadId: candidate.leadId,
        reason: `Below today's top ${cap} ${tier} cutoff (rank ${cap + i + 1}, score ${candidate.score})`,
      });
    });
  }

  return { selected, skipped };
}

app.post('/cadence/daily', async (_req: Request, res: Response) => {
  try {
    const leadIds = await fetchAssignedLeadIds(NAVJOT_LOFTY_USER_ID);
    const { selected, skipped: rosterSkipped } = await buildDailyRoster(leadIds);
    const { executed, skipped: executionSkipped } = await executeCadence(selected);
    res.json({ executed, skipped: [...rosterSkipped, ...executionSkipped] });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/daily-report', async (req: Request, res: Response) => {
  try {
    const leadIdsParam = req.query.leadIds;
    const leadIds = typeof leadIdsParam === 'string' ? leadIdsParam.split(',').filter(Boolean) : [];
    const report = await generateDailyCommandCenter(leadIds);
    res.json({ report });
  } catch (error) {
    sendError(res, error);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Vern listening on port ${port}`));
