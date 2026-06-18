import { buildCadenceDetailed } from './cadenceManager';

const ET_TIMEZONE = 'America/New_York';
const ONE_DAY_MS = 1000 * 60 * 60 * 24;
const MAX_HOT_CALLS_SHOWN = 5;

function formatEtTimestamp(date: Date): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) map[part.type] = part.value;
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute} ${map.dayPeriod} ET`;
}

function isSameEtCalendarDay(isoTimestamp: string | null, now: Date): boolean {
  if (!isoTimestamp) return false;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date(isoTimestamp)) === formatter.format(now);
}

function daysAgoLabel(isoTimestamp: string | null, now: Date): string {
  if (!isoTimestamp) return 'unknown';
  const days = Math.floor((now.getTime() - new Date(isoTimestamp).getTime()) / ONE_DAY_MS);
  return days <= 0 ? 'today' : `${days}d ago`;
}

/** "now" if already due, else "in Xd (<timingNote>|business hours)". */
function nextSendLabel(sendAfter: Date, now: Date, timingNote: string | null): string {
  if (sendAfter.getTime() <= now.getTime()) return 'now';
  const days = Math.ceil((sendAfter.getTime() - now.getTime()) / ONE_DAY_MS);
  const reason = timingNote ? 'frequency cap' : 'business hours';
  return `in ${days}d (${reason})`;
}

/**
 * Builds the human-readable Daily Command Center report for the given
 * leads: today's hot-call queue (top 5 by score), warm/ghost queue counts,
 * and an actions-needed summary of why anything got skipped. Built
 * entirely from buildCadenceDetailed()'s single pass — no second fetch of
 * the same leads, no invented fields (no why-calling/opening-line/last-CRM
 * note columns — Vern doesn't generate those; see qualification.reason and
 * personalizedMessage instead).
 */
export async function generateDailyCommandCenter(leadIds: string[]): Promise<string> {
  const now = new Date();
  const { scheduled, skipped } = await buildCadenceDetailed(leadIds);

  const hotLeads = scheduled.filter((d) => d.status === 'hot').slice(0, MAX_HOT_CALLS_SHOWN);
  const warmScheduled = scheduled.filter((d) => d.status === 'warm');
  // A warm lead already emailed today still shows up in `scheduled` (just
  // delayed to its next valid window) rather than `skipped` now — split
  // the same pool instead of looking in skipped for it.
  const warmEmailedToday = warmScheduled.filter((d) => isSameEtCalendarDay(d.lastEmailAt, now));
  const warmQueued = warmScheduled.filter((d) => !isSameEtCalendarDay(d.lastEmailAt, now));
  const ghostQueued = scheduled.filter((d) => d.status === 'ghost');

  // Only hard violations (DNC, agent/blocked, disqualified) ever land in
  // `skipped` now — timing violations (frequency caps) no longer do, so
  // every non-FAILED entry here is a hard skip by construction.
  const hardSkips = skipped.filter((s) => !s.reason.startsWith('FAILED:'));
  const failed = skipped.filter((s) => s.reason.startsWith('FAILED:'));

  const lines: string[] = [];
  lines.push('=== DAILY COMMAND CENTER ===');
  lines.push(`Generated: ${formatEtTimestamp(now)}`);
  lines.push('');

  lines.push(`YOUR ${hotLeads.length} HOT CALLS TODAY (sorted by score)`);
  if (hotLeads.length === 0) {
    lines.push('(none)');
  } else {
    hotLeads.forEach((lead, index) => {
      lines.push(
        `[${index + 1}/${hotLeads.length}] ${lead.firstName ?? 'Unknown'} | ${lead.phone ?? 'no phone on file'} | ` +
          `${lead.leadIntent}, ${lead.buyingTimeframe ?? 'no timeframe'} | ${lead.personalizedMessage ?? lead.reason} | ` +
          `Last touch: ${daysAgoLabel(lead.lastTouchAt, now)} | Next ${lead.channel.toUpperCase()}: ` +
          `${nextSendLabel(lead.sendAfter, now, lead.timingNote)}`,
      );
      lines.push('');
    });
  }

  lines.push(`WARM LEADS (${warmQueued.length} queued, ${warmEmailedToday.length} emailed today)`);
  lines.push(`GHOST REACTIVATION (${ghostQueued.length} queued for reactivation)`);
  lines.push('');

  lines.push('ACTIONS NEEDED');
  if (hardSkips.length) {
    lines.push(`- ${hardSkips.length} lead(s) skipped (DNC/agent/blocked/disqualified) (${hardSkips.map((s) => s.leadId).join(', ')})`);
  }
  if (failed.length) {
    lines.push(`- ${failed.length} lead(s) failed to process - retry needed (${failed.map((s) => s.leadId).join(', ')})`);
  }
  if (!hardSkips.length && !failed.length) {
    lines.push('- none');
  }

  return lines.join('\n');
}
