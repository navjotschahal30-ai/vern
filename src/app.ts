import { randomUUID } from 'crypto';
import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import { handleLoftyEvent } from './handlers/eventListener';
import { handleLoftyWebhook, fetchAssignedLeadIds, fetchLeadProfile, LoftyRateLimitError } from './handlers/loftyWebhookHandler';
import { executeCadence, SkippedLead } from './engines/cadenceManager';
import { qualifyLead, LeadQualification } from './engines/qualificationEngine';
import { generateDailyCommandCenter } from './engines/dailyCommandCenter';
import { updateLeadState } from './engines/stateEngine';

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

const LOFTY_USER_ID = process.env.LOFTY_USER_ID || '844770719757219';

// Mirrors CRM Agent's daily roster logic: qualify the full assigned book,
// then take only the top-scoring leads per tier rather than contacting
// everyone every day.
const DAILY_ROSTER_CAPS: Record<'hot' | 'warm' | 'ghost', number> = { hot: 10, warm: 20, ghost: 20 };

// Throttles the qualification pass — fetching+qualifying all 681 leads at
// once would fire ~4000 concurrent Lofty requests. Batches of this size run
// their fetches in parallel (Promise.all) but batches themselves run one
// after another, spaced out by INTER_BATCH_DELAY_MS so bursts don't stack.
const DAILY_ROSTER_BATCH_SIZE = Number(process.env.DAILY_ROSTER_BATCH_SIZE) || 5;
const INTER_BATCH_DELAY_MS = 500;

// Lofty 429s show up batch-wide rather than on isolated leads, so a hit gets
// retried (only the rate-limited leads, not the whole batch) with doubling
// backoff before being recorded as a permanent skip: 2s, 4s, 8s, 16s, 32s.
const BATCH_RETRY_BASE_DELAY_MS = 2000;
const MAX_BATCH_RETRIES = 5;

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
    // Sequential, not Promise.all — firing every lead in the batch at once
    // is exactly the burst that trips Lofty's per-second rate limit.
    const results: QualifyBatchResult[] = [];
    for (const leadId of pending) {
      results.push(await qualifyLeadSafe(leadId));
    }
    const rateLimited = results.filter((result) => result.rateLimited);
    settled = settled.concat(results.filter((result) => !result.rateLimited));

    if (rateLimited.length === 0 || attempt === MAX_BATCH_RETRIES) {
      return settled.concat(rateLimited);
    }

    const delay = BATCH_RETRY_BASE_DELAY_MS * 2 ** attempt;
    console.warn(
      `[cadence] 429 backoff: retrying ${rateLimited.length} lead(s), attempt ${attempt + 1}/${MAX_BATCH_RETRIES}, waiting ${delay}ms`,
    );
    await sleep(delay);
    pending = rateLimited.map((result) => result.leadId);
  }

  return settled;
}

/** Runs `batchFn` over `items` in DAILY_ROSTER_BATCH_SIZE chunks, sleeping INTER_BATCH_DELAY_MS between chunks (not after the last) so requests spread out instead of bursting. */
async function mapInBatches<T, R>(items: T[], batchFn: (batch: T[]) => Promise<R[]>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += DAILY_ROSTER_BATCH_SIZE) {
    const batch = items.slice(i, i + DAILY_ROSTER_BATCH_SIZE);
    results.push(...(await batchFn(batch)));
    if (i + DAILY_ROSTER_BATCH_SIZE < items.length) {
      await sleep(INTER_BATCH_DELAY_MS);
    }
  }
  return results;
}

/** Same chunking/spacing as mapInBatches, for batch steps with no per-item return value (e.g. tag writes). */
async function forEachInBatches<T>(items: T[], batchFn: (batch: T[]) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += DAILY_ROSTER_BATCH_SIZE) {
    const batch = items.slice(i, i + DAILY_ROSTER_BATCH_SIZE);
    await batchFn(batch);
    if (i + DAILY_ROSTER_BATCH_SIZE < items.length) {
      await sleep(INTER_BATCH_DELAY_MS);
    }
  }
}

interface RosterSelection {
  leadId: string;
  status: 'hot' | 'warm' | 'ghost';
}

/**
 * Qualifies the top 50 assigned leads — in batches of DAILY_ROSTER_BATCH_SIZE,
 * each fetched/qualified in parallel via Promise.all — then selects today's
 * roster once all batches are in: the top-scoring leads within each of the
 * hot/warm/ghost tiers (capped per DAILY_ROSTER_CAPS). Blocked/DNC leads and
 * leads that don't make a tier's cutoff are returned as skipped rather than
 * passed to executeCadence. Shared by /cadence/daily and
 * /cadence/tag-only-sample so both run the identical selection path.
 */
async function selectDailyRoster(leadIds: string[]): Promise<{ selected: RosterSelection[]; skipped: SkippedLead[] }> {
  const skipped: SkippedLead[] = [];
  const qualified: Array<{ leadId: string; qualification: LeadQualification }> = [];

  const results = await mapInBatches(leadIds, qualifyBatchWithBackoff);
  for (const result of results) {
    if (result.error !== undefined) {
      skipped.push({ leadId: result.leadId, reason: result.error });
      continue;
    }
    qualified.push({ leadId: result.leadId, qualification: result.qualification });
  }

  const byTier: Record<'hot' | 'warm' | 'ghost', RosterCandidate[]> = { hot: [], warm: [], ghost: [] };
  for (const { leadId, qualification } of qualified) {
    if (qualification.status === 'blocked' || !qualification.shouldContact) {
      skipped.push({ leadId, reason: qualification.reason });
      continue;
    }
    byTier[qualification.status].push({ leadId, score: qualification.score });
  }

  const selected: RosterSelection[] = [];
  for (const tier of Object.keys(DAILY_ROSTER_CAPS) as Array<keyof typeof DAILY_ROSTER_CAPS>) {
    const cap = DAILY_ROSTER_CAPS[tier];
    const sorted = byTier[tier].sort((a, b) => b.score - a.score);

    selected.push(...sorted.slice(0, cap).map((candidate) => ({ leadId: candidate.leadId, status: tier })));
    sorted.slice(cap).forEach((candidate, i) => {
      skipped.push({
        leadId: candidate.leadId,
        reason: `Below today's top ${cap} ${tier} cutoff (rank ${cap + i + 1}, score ${candidate.score})`,
      });
    });
  }

  return { selected, skipped };
}

async function buildDailyRoster(leadIds: string[]): Promise<{ selected: string[]; skipped: SkippedLead[] }> {
  const { selected, skipped } = await selectDailyRoster(leadIds);
  return { selected: selected.map((candidate) => candidate.leadId), skipped };
}

/**
 * Qualifies every assigned lead and writes the resulting VERN-STATE tag
 * (hot/warm/ghost/blocked) without sending any SMS/email — a dry run for
 * sanity-checking qualification + rate-limit handling against the full
 * lead book before a real /cadence/daily run.
 */
async function tagLeadsOnly(leadIds: string[]): Promise<Record<LeadQualification['status'], number>> {
  const breakdown: Record<LeadQualification['status'], number> = { hot: 0, warm: 0, ghost: 0, blocked: 0 };

  const results = await mapInBatches(leadIds, qualifyBatchWithBackoff);
  const tagged = results.flatMap((result) =>
    result.error !== undefined ? [] : [{ leadId: result.leadId, status: result.qualification.status }],
  );

  await forEachInBatches(tagged, async (batch) => {
    await Promise.all(batch.map(({ leadId, status }) => updateLeadState(leadId, status)));
    batch.forEach(({ status }) => breakdown[status]++);
  });

  return breakdown;
}

app.post('/cadence/tag-only', async (_req: Request, res: Response) => {
  try {
    const leadIds = await fetchAssignedLeadIds(LOFTY_USER_ID);
    const breakdown = await tagLeadsOnly(leadIds);
    res.json(breakdown);
  } catch (error) {
    sendError(res, error);
  }
});

interface TagOnlySampleJob {
  status: 'running' | 'completed' | 'failed';
  tagged: number;
  skipped: number;
  error?: string;
}

// Separate map from dailyCadenceJobs (see below) — same in-memory,
// lost-on-restart tradeoff, kept independent since the two job kinds
// track different fields (tagged vs executed).
const tagOnlySampleJobs = new Map<string, TagOnlySampleJob>();

/**
 * Runs the exact same selection path /cadence/daily uses (selectDailyRoster:
 * qualify top 50 leads, pick top 10 hot / 20 warm / 20 ghost), then tags just
 * those ~50 leads with VERN-STATE and skips SMS/email — a low-quota dry run
 * of tomorrow's real cadence path.
 */
async function runTagOnlySampleJob(jobId: string): Promise<void> {
  try {
    const leadIds = (await fetchAssignedLeadIds(LOFTY_USER_ID)).slice(0, 50);
    const { selected, skipped } = await selectDailyRoster(leadIds);

    await forEachInBatches(selected, (batch) =>
      Promise.all(batch.map(({ leadId, status }) => updateLeadState(leadId, status))).then(() => undefined),
    );

    tagOnlySampleJobs.set(jobId, { status: 'completed', tagged: selected.length, skipped: skipped.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[cadence/tag-only-sample] job ${jobId} failed`, error);
    tagOnlySampleJobs.set(jobId, { status: 'failed', tagged: 0, skipped: 0, error: message });
  }
}

app.post('/cadence/tag-only-sample', (_req: Request, res: Response) => {
  const jobId = randomUUID();
  tagOnlySampleJobs.set(jobId, { status: 'running', tagged: 0, skipped: 0 });

  void runTagOnlySampleJob(jobId);

  res.status(202).json({ jobId, status: 'queued' });
});

app.get('/cadence/tag-only-sample/:jobId', (req: Request<{ jobId: string }>, res: Response) => {
  const job = tagOnlySampleJobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Unknown jobId', code: 404 });
    return;
  }
  res.json(job);
});

interface DailyCadenceJob {
  status: 'running' | 'completed' | 'failed';
  executed: number;
  skipped: number;
  error?: string;
}

// In-memory only — fine for a single-instance service; a job's status is
// lost on restart/redeploy, which just means a client polling an in-flight
// job sees a 404 rather than stale state.
const dailyCadenceJobs = new Map<string, DailyCadenceJob>();

/**
 * The actual /cadence/daily work, run detached from the request so a slow
 * Lofty pass (top 50 leads, rate-limit backoff included) can't trip Railway's
 * gateway timeout. Failures are caught here and recorded on the job rather
 * than thrown — there's no request left to propagate them to.
 */
async function runDailyCadenceJob(jobId: string): Promise<void> {
  try {
    const leadIds = (await fetchAssignedLeadIds(LOFTY_USER_ID)).slice(0, 50);
    const { selected, skipped: rosterSkipped } = await buildDailyRoster(leadIds);
    const { executed, skipped: executionSkipped } = await executeCadence(selected);

    dailyCadenceJobs.set(jobId, {
      status: 'completed',
      executed: executed.length,
      skipped: rosterSkipped.length + executionSkipped.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[cadence/daily] job ${jobId} failed`, error);
    dailyCadenceJobs.set(jobId, { status: 'failed', executed: 0, skipped: 0, error: message });
  }
}

app.post('/cadence/daily', (_req: Request, res: Response) => {
  const jobId = randomUUID();
  dailyCadenceJobs.set(jobId, { status: 'running', executed: 0, skipped: 0 });

  void runDailyCadenceJob(jobId);

  res.status(202).json({ jobId, status: 'queued' });
});

app.get('/cadence/daily/:jobId', (req: Request<{ jobId: string }>, res: Response) => {
  const job = dailyCadenceJobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Unknown jobId', code: 404 });
    return;
  }
  res.json(job);
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
