import { qualifyLead, LeadQualification } from './qualificationEngine';
import { getLeadState, tagLeadByQualification, recordOutreach, syncActivityNote } from './stateEngine';
import { checkHardViolations, checkTimingViolations, getNextValidSendTime, logComplianceSkip, OutreachHistory } from '../config/compliance';
import { fetchLeadProfile } from '../handlers/loftyWebhookHandler';
import { LeadProfile, resolveLeadAreaCity } from '../schemas/leadProfile';
import { MarketSnapshot } from '../schemas/marketSnapshot';
import { TemplateKey } from '../config/templates';
import { sendEmail } from '../outreach/emailExecutor';
import { logEmailAttempt } from '../store/emailLog';

/**
 * Fetches market data from Content Agent for dynamic message generation.
 * Response shape must match MarketSnapshot (src/schemas/marketSnapshot.ts)
 * — update that file, not this one, if Content Agent's actual payload
 * (VOW today, VOW + Cornerstone soon) differs.
 */
async function fetchMarketData(
  city: string | null,
  neighborhood: string | null = null,
  propertyType: string | null = null,
): Promise<MarketSnapshot | null> {
  if (!city) {
    console.warn('[market] No resolvable city for lead — skipping market data fetch, template will use placeholder copy');
    return null;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(
   `${process.env.CONTENT_AGENT_URL || 'https://renewed-gratitude-production-0fb3.up.railway.app'}/market/analyze`,
    {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ city, neighborhood, propertyType }),
    signal: controller.signal,
    },
    );
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`[market] Content Agent failed: ${response.status}`);
      return null;
    }

    // Content Agent's response doesn't include the city it was asked
    // about — attach it here so templates can reference it.
    const data = (await response.json()) as Omit<MarketSnapshot, 'city'>;
    return { ...data, city };
  } catch (error) {
    console.warn(`[market] Failed to fetch market data:`, error);
    return null;
  }
}

export interface CadenceDecision {
  leadId: string;
  channel: 'sms' | 'email';
  sendAfter: Date;
  reason: string;
}

export interface SkippedLead {
  leadId: string;
  reason: string;
}

export interface CadenceResult {
  scheduled: CadenceDecision[];
  skipped: SkippedLead[];
}

// Richer per-lead shapes — same single pass over leadIds, just retaining
// the qualification/state context that the public CadenceResult strips
// out. dailyCommandCenter.ts builds its report from these instead of
// re-fetching every lead a second time or re-deriving status/score from
// reason strings.
export interface DetailedDecision extends CadenceDecision {
  status: LeadQualification['status'];
  score: number;
  firstName: string | null;
  phone: string | null;
  leadIntent: LeadProfile['leadIntent'];
  buyingTimeframe: string | null;
  personalizedMessage?: string;
  lastTouchAt: string | null;
  lastSmsAt: string | null;
  lastEmailAt: string | null;
  /** Timing violations (frequency cap/cooldown) that pushed sendAfter into the future — null if sending now. Not a skip reason. */
  timingNote: string | null;
}

export interface DetailedSkip extends SkippedLead {
  /** null only when the lead failed before it could be qualified (a FAILED entry). */
  status: LeadQualification['status'] | null;
  lastSmsAt: string | null;
  lastEmailAt: string | null;
}

export interface DetailedCadenceResult {
  scheduled: DetailedDecision[];
  skipped: DetailedSkip[];
}

const STATUS_PRIORITY: Record<LeadQualification['status'], number> = {
  hot: 0,
  warm: 1,
  ghost: 2,
  blocked: 3, // never appears below — blocked leads always get skipped as a violation
};

/**
 * qualifyLead's nextAction includes 'call' (warm) and 'wait' (disqualified),
 * neither of which Vern can send automatically — 'wait' leads are filtered
 * out before this runs, and 'call' falls back to email, the gentler
 * always-available channel, while the warm bucket still implies a human
 * call is the better follow-up.
 */
function resolveChannel(nextAction: LeadQualification['nextAction']): 'sms' | 'email' {
  return nextAction === 'sms' ? 'sms' : 'email';
}

function mostRecentTimestamp(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function sortByPriority<T extends { status: LeadQualification['status']; score: number }>(decisions: T[]): T[] {
  return [...decisions].sort((a, b) => {
    const statusDiff = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
    return statusDiff !== 0 ? statusDiff : b.score - a.score;
  });
}

/**
 * Does the actual per-lead work: qualify, check compliance, and either
 * schedule a send or record a skip reason. A single lead failing never
 * aborts the batch — it's logged and recorded in `skipped` so it can be
 * retried manually; only a real pattern (many failures) is meant to stand
 * out in the logs.
 */
export async function buildCadenceDetailed(leadIds: string[]): Promise<DetailedCadenceResult> {
  const decisions: DetailedDecision[] = [];
  const skipped: DetailedSkip[] = [];

  for (const leadId of leadIds) {
    try {
      const leadProfile = await fetchLeadProfile(leadId);
      const qualification = qualifyLead(leadProfile);
      const leadState = await getLeadState(leadId);
      const lastOutreach: OutreachHistory = { lastSmsAt: leadState.lastSmsAt, lastEmailAt: leadState.lastEmailAt };
      const lastTouchAt = mostRecentTimestamp(leadProfile.engagement.lastAnyTouchAt, leadProfile.lastUpdatedAt);

      const hardViolations = checkHardViolations(leadProfile, lastOutreach, qualification.status);
      if (!qualification.shouldContact) {
        hardViolations.push(`Disqualified: ${qualification.reason}`);
      }

      if (hardViolations.length) {
        logComplianceSkip(leadProfile, hardViolations);
        skipped.push({
          leadId,
          reason: hardViolations.join('; '),
          status: qualification.status,
          lastSmsAt: leadState.lastSmsAt,
          lastEmailAt: leadState.lastEmailAt,
        });
        continue;
      }

      // Timing violations (frequency cap/cooldown) don't disqualify the
      // lead — getNextValidSendTime() already accounts for them and
      // returns a future time, so the lead stays scheduled, just delayed.
      const timingViolations = checkTimingViolations(leadProfile, lastOutreach, qualification.status);
      const timingNote = timingViolations.length ? timingViolations.join('; ') : null;

      const channel = resolveChannel(qualification.nextAction);
      const sendAfter = getNextValidSendTime(leadProfile, channel, lastOutreach, qualification.status);

      console.log(
        `[cadence] leadId=${leadId} status=${qualification.status} score=${qualification.score} -> ` +
          `${channel} at ${sendAfter.toISOString()} (${qualification.reason})` +
          (timingNote ? ` [delayed: ${timingNote}]` : ''),
      );

      decisions.push({
        leadId,
        channel,
        sendAfter,
        reason: qualification.reason,
        status: qualification.status,
        score: qualification.score,
        firstName: leadProfile.firstName,
        phone: leadProfile.phone,
        leadIntent: leadProfile.leadIntent,
        buyingTimeframe: leadProfile.buyingTimeframe,
        personalizedMessage: qualification.personalizedMessage,
        lastTouchAt,
        lastSmsAt: leadState.lastSmsAt,
        lastEmailAt: leadState.lastEmailAt,
        timingNote,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[cadence] leadId=${leadId} FAILED: ${reason} — skipping this lead`);
      skipped.push({ leadId, reason: `FAILED: ${reason}`, status: null, lastSmsAt: null, lastEmailAt: null });
    }
  }

  return { scheduled: sortByPriority(decisions), skipped };
}

/**
 * Builds today's outreach cadence for a batch of leads. Public contract:
 * just enough to act on (leadId, channel, sendAfter, reason) or to retry
 * (leadId, reason) — see buildCadenceDetailed() for the richer per-lead
 * data the daily command center report is built from.
 */
export async function buildCadence(leadIds: string[]): Promise<CadenceResult> {
  const detailed = await buildCadenceDetailed(leadIds);
  return {
    scheduled: detailed.scheduled.map(({ leadId, channel, sendAfter, reason }) => ({ leadId, channel, sendAfter, reason })),
    skipped: detailed.skipped.map(({ leadId, reason }) => ({ leadId, reason })),
  };
}

export interface ExecutedEntry {
  leadId: string;
  channel: 'sms' | 'email';
  sent: boolean;
  reason: string;
  // Populated only for email-channel entries that actually got rendered —
  // lets a caller review exactly what was sent (or would have sent under
  // TEST_MODE) without going to Lofty's UI per lead.
  templateKey?: TemplateKey;
  subject?: string;
  emailBody?: string;
}

export interface ExecuteCadenceResult {
  executed: ExecutedEntry[];
  skipped: SkippedLead[];
}

/**
 * Same qualification/compliance pass as buildCadenceDetailed, but actually
 * sends. Re-fetches each scheduled lead's profile right before sending
 * (rather than reusing buildCadenceDetailed's copy) so a send can't act on
 * data that's gone stale between scheduling and execution. recordOutreach
 * always runs after a real send attempt, even when emailExecutor skips the
 * actual send under TEST_MODE — Vern's own tags must reflect what the
 * cadence *decided* regardless of whether TEST_MODE suppressed delivery.
 *
 * Email-only rollout: SMS stays paused (leads still get tagged/scheduled
 * on the SMS channel by qualificationEngine, but executeCadence never
 * calls sendSMS) until SMS is deliberately turned back on. See
 * docs/VERN_STATUS.md for the outreach-pause history.
 *
 * A frequency-capped lead stays in buildCadenceDetailed's `scheduled` list
 * with a future sendAfter rather than moving to `skipped` (see
 * DetailedDecision.timingNote) — so this still has to check sendAfter
 * itself before sending, or every cap would be bypassed on execution.
 */
/**
 * Renders Vern's current tag-tracked state (status, last-contact
 * timestamps) plus this run's specific action into a single note, so the
 * lead's timeline shows one up-to-date summary instead of a note per
 * cadence run. Best-effort — syncActivityNote already swallows its own
 * errors rather than throwing, so a Lofty notes-API hiccup can't fail an
 * otherwise-successful send.
 */
async function syncLeadActivityNote(leadId: string, status: LeadQualification['status'], lastAction: string): Promise<void> {
  const state = await getLeadState(leadId);
  await syncActivityNote(leadId, [
    `Status: ${status.toUpperCase()}`,
    `Last email: ${state.lastEmailAt ?? 'never'}`,
    `Last SMS: ${state.lastSmsAt ?? 'never'}`,
    `Most recent action: ${lastAction}`,
  ]);
}

export async function executeCadence(leadIds: string[]): Promise<ExecuteCadenceResult> {
  const { scheduled, skipped } = await buildCadenceDetailed(leadIds);

  const executed: ExecutedEntry[] = [];
  const allSkipped: SkippedLead[] = skipped.map(({ leadId, reason }) => ({ leadId, reason }));

  const now = new Date();

  for (const decision of scheduled) {
    try {
      const leadProfile = await fetchLeadProfile(decision.leadId);
      const qualification = qualifyLead(leadProfile);

      // Refresh this lead's hot/warm/ghost tag regardless of whether it's
      // also eligible to send today — a CASL cooldown should delay
      // outreach, not leave the lead's classification stale in Lofty until
      // its next cooldown-free cycle.
      await tagLeadByQualification(decision.leadId, qualification);

      if (decision.sendAfter.getTime() > now.getTime()) {
        allSkipped.push({
          leadId: decision.leadId,
          reason: `Delayed until ${decision.sendAfter.toISOString()}${decision.timingNote ? ` (${decision.timingNote})` : ''}`,
        });
        continue;
      }

      if (decision.channel === 'sms') {
        executed.push({
          leadId: decision.leadId,
          channel: decision.channel,
          sent: false,
          reason: 'Tagged only (SMS outreach paused — email-only rollout)',
        });
        await syncLeadActivityNote(
          decision.leadId,
          qualification.status,
          'SMS tagged only (SMS outreach paused — email-only rollout)',
        );
        continue;
      }

      const marketData = await fetchMarketData(resolveLeadAreaCity(leadProfile));
      const result = await sendEmail(leadProfile, qualification, marketData ?? undefined);

      if ('noData' in result) {
        // Nothing was rendered or sent — don't record this as an outreach
        // touch (that would push the lead's next eligible send further out
        // via the frequency cap) and don't log a fabricated subject/body.
        // Treat it like a timing skip so the lead is picked up again next
        // cycle once real data resolves.
        allSkipped.push({ leadId: decision.leadId, reason: `No data: ${result.reason}` });
        continue;
      }

      const reason = result.sent ? decision.reason : 'Test mode: skipped — not Navjot';

      await recordOutreach(decision.leadId, 'email');
      logEmailAttempt({
        leadId: decision.leadId,
        sent: result.sent,
        templateKey: result.templateKey,
        subject: result.subject,
        body: result.body,
        reason,
      });
      await syncLeadActivityNote(decision.leadId, qualification.status, `Email ${result.sent ? 'sent' : 'not sent'} — ${reason}`);

      executed.push({
        leadId: decision.leadId,
        channel: decision.channel,
        sent: result.sent,
        reason,
        templateKey: result.templateKey,
        subject: result.subject,
        emailBody: result.body,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[cadence] leadId=${decision.leadId} execution FAILED: ${reason}`);
      allSkipped.push({ leadId: decision.leadId, reason: `FAILED: ${reason}` });
    }
  }

  return { executed, skipped: allSkipped };
}
