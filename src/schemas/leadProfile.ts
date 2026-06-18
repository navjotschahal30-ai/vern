// ---------------------------------------------------------------------------
// LeadProfile contract
//
// This is the shared shape that every downstream agent (Aria, IDX Stalker,
// CRM Agent, etc.) reads from. It is the normalized, agent-friendly view of
// a raw Lofty lead + its notes — nobody downstream should reach back into
// the raw Lofty payload directly. If Lofty's API shape changes, only
// normalizeLeadProfile() needs to change; this interface should not.
// ---------------------------------------------------------------------------

/**
 * A single contact event pulled from Lofty (call, note, email, activity, or
 * list sync). `isHuman` distinguishes a real touch (a logged call, a manual
 * note, an inbound email reply) from automated/system activity (list syncs,
 * property views, email opens) — qualificationEngine's ghost/hot/warm rules
 * key off this distinction.
 */
export interface TouchEvent {
  type: 'call' | 'note' | 'email_reply' | 'email_open' | 'property_view' | 'list_sync';
  timestamp: string;
  isHuman: boolean;
}

export interface LeadEngagement {
  /** ISO timestamp of the most recent human touch (call/note/reply), or null if none on record. */
  lastHumanTouchAt: string | null;

  /** ISO timestamp of the most recent touch of any kind, or null if none on record. */
  lastAnyTouchAt: string | null;

  /** Count of all touch events (human + automated) in the last 60 days. */
  touchCountLast60Days: number;

  /** Count of human-only touch events in the last 60 days. */
  humanTouchCountLast60Days: number;
}

export interface LeadProfile {
  /** Lofty leadId. 64-bit — kept as `string` to avoid overflowing JS's
   *  Number range. */
  leadId: string;

  /** Lead source as reported by Lofty, e.g. "Website", "Facebook",
   *  "Realtor", "Lofty Paid Lead". */
  source: string;

  /** Lead's first name, if Lofty has one on file. */
  firstName: string | null;

  /** Lead's last name, if Lofty has one on file. */
  lastName: string | null;

  /** Lead's phone number, if Lofty has one on file. */
  phone: string | null;

  /** UTM params pulled from Lofty customAttributes, if present. */
  utmData: {
    utm_source?: string;
    utm_campaign?: string;
    utm_content?: string;
    utm_medium?: string;
  };

  /** Tag names from Lofty's tags array. */
  tags: string[];

  /** Best-guess intent classification for this lead. */
  leadIntent: 'buyer' | 'seller' | 'investor' | 'commercial' | 'unknown';

  /** Buying timeframe as reported, e.g. "1-3", "3-6", "6-12", "12+",
   *  "Just Looking", "Refinancing". Null if unknown/not applicable. */
  buyingTimeframe: string | null;

  /** Selling timeframe, same shape/semantics as buyingTimeframe. */
  sellingTimeframe: string | null;

  /** Pre-approval status, derived from Lofty's preQual field. */
  preApproved: boolean | null;

  /** Whether the lead has a current home to sell. */
  hasHouseToSell: boolean | null;

  /** Whether the lead is currently working with a buyer's agent, as reported by Lofty. */
  withBuyerAgent: 'Yes' | 'No' | null;

  /** Whether the lead is currently working with a listing agent, as reported by Lofty. */
  withListingAgent: 'Yes' | 'No' | null;

  /** Name of the Lofty team member this lead is assigned to, if any. */
  assignedUser: string | null;

  /** Current home address, if known. */
  currentHomeAddress: {
    streetAddress: string;
    city: string;
    state: string;
    zipCode: string;
  } | null;

  /** Properties the lead has viewed, from Lofty's leadPropertyList. */
  propertiesViewed: Array<{
    address: string;
    price: number;
    mls: string;
  }> | null;

  /** Aggregated search/inquiry criteria for properties the lead is
   *  interested in. */
  inquiredProperties: {
    priceMin: number;
    priceMax: number;
    bedroomsMin: number;
    propertyTypes: string[];
  } | null;

  /** Question/answer pairs parsed out of free-form lead notes (e.g. lead
   *  capture form submissions logged as notes). */
  formResponses: Array<{
    question: string;
    answer: string;
  }>;

  /** Every contact event pulled from Lofty (calls, notes, emails, activity
   *  timeline, list syncs), each flagged human vs. automated. */
  touchHistory: TouchEvent[];

  /** Derived summary of touchHistory — last-touch timestamps and 60-day counts. */
  engagement: LeadEngagement;

  /** ISO timestamp of when this lead was first captured. */
  capturedAt: string;

  /** ISO timestamp of the most recent update to this lead. */
  lastUpdatedAt: string;
}

// ---------------------------------------------------------------------------
// Raw Lofty shapes (input to the normalizer only — not part of the
// downstream contract, hence not exported).
// ---------------------------------------------------------------------------

interface LoftyCustomAttribute {
  key: string;
  value: string;
}

interface LoftyTag {
  tagName: string;
}

interface LoftyProperty {
  streetAddress: string;
  price: number;
  listingId: string;
}

interface LoftyInquiry {
  priceMin?: number;
  priceMax?: number;
  bedroomsMin?: number;
  propertyType?: string[];
}

interface LoftyLead {
  leadId: number | string;
  source: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  customAttributes?: LoftyCustomAttribute[];
  tags?: LoftyTag[];
  leadTypes?: number[];
  buyingTimeFrame?: string | null;
  sellingTimeFrame?: string | null;
  preQual?: 'Yes' | 'No' | null;
  houseToSell?: 'Yes' | 'No' | null;
  withBuyerAgent?: 'Yes' | 'No' | null;
  withListingAgent?: 'Yes' | 'No' | null;
  assignedUser?: string | null;
  streetAddress?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  leadPropertyList?: LoftyProperty[];
  leadInquiry?: LoftyInquiry;
  createTime?: string | number;
  lastUpdateTime?: string | number;
}

// GET /v1.0/notes?leadId={leadId} — `isSystemGenerated` distinguishes an
// agent-written note from an automated one (e.g. "lead imported").
interface LoftyNote {
  content: string;
  createTime?: string | number;
  isSystemGenerated?: boolean;
}

// GET /v1.0/communication/call-history?leadId={leadId}
interface LoftyCallHistoryItem {
  callTime?: string | number;
}

// GET /v1.0/communication/email?leadId={leadId}
interface LoftyEmailHistoryItem {
  sentTime?: string | number;
  isReply?: boolean;
  opened?: boolean;
}

// GET /v2.0/leads/{leadId}/activities — a generic timeline that can contain
// any of the above event kinds plus passive ones like list syncs.
interface LoftyActivityItem {
  type?: string;
  createTime?: string | number;
}

const LEAD_TYPE_TO_INTENT: Record<number, LeadProfile['leadIntent']> = {
  2: 'buyer',
  1: 'seller',
  6: 'investor',
};

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const ENGAGEMENT_WINDOW_DAYS = 60;

function toIsoString(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return '';
  // Lofty sends timestamps like "2026-06-17T16:50:40GMT" — a bare "GMT"
  // suffix with no offset, which `Date` can't parse. Normalize to "Z".
  const normalized = typeof value === 'string' ? value.replace(/GMT$/, 'Z') : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function normalizeTimeframe(value: string | null | undefined): string | null {
  if (!value || value === 'N/A') return null;
  return value;
}

function mapYesNo(value: 'Yes' | 'No' | null | undefined): boolean | null {
  if (value === 'Yes') return true;
  if (value === 'No') return false;
  return null;
}

function extractUtmData(customAttributes: LoftyCustomAttribute[] | undefined): LeadProfile['utmData'] {
  const utmKeys = ['utm_source', 'utm_campaign', 'utm_content', 'utm_medium'] as const;
  const utmData: LeadProfile['utmData'] = {};
  for (const attr of customAttributes ?? []) {
    if ((utmKeys as readonly string[]).includes(attr.key)) {
      utmData[attr.key as (typeof utmKeys)[number]] = attr.value;
    }
  }
  return utmData;
}

function parseFormResponses(notes: LoftyNote[]): LeadProfile['formResponses'] {
  const responses: LeadProfile['formResponses'] = [];
  const pairPattern = /Question:\s*([\s\S]*?)\s*Answer:\s*([\s\S]*?)(?=\s*Question:|\s*$)/g;

  for (const note of notes) {
    const content = note.content ?? '';
    for (const match of content.matchAll(pairPattern)) {
      const question = (match[1] ?? '').trim();
      const answer = (match[2] ?? '').trim();
      if (question || answer) {
        responses.push({ question, answer });
      }
    }
  }

  return responses;
}

/** Maps a generic Lofty activity-timeline `type` string onto a TouchEvent kind. */
function mapActivityType(rawType: string): TouchEvent['type'] {
  const normalized = rawType.toLowerCase();
  if (normalized.includes('call')) return 'call';
  if (normalized.includes('reply')) return 'email_reply';
  if (normalized.includes('email')) return 'email_open';
  if (normalized.includes('view') || normalized.includes('propert')) return 'property_view';
  return 'list_sync';
}

function buildTouchHistory(
  notes: LoftyNote[],
  callHistory: LoftyCallHistoryItem[],
  emailHistory: LoftyEmailHistoryItem[],
  activities: LoftyActivityItem[],
): TouchEvent[] {
  const events: TouchEvent[] = [];

  for (const note of notes) {
    const timestamp = toIsoString(note.createTime);
    if (!timestamp) continue;
    events.push({ type: 'note', timestamp, isHuman: !note.isSystemGenerated });
  }

  for (const call of callHistory) {
    const timestamp = toIsoString(call.callTime);
    if (!timestamp) continue;
    events.push({ type: 'call', timestamp, isHuman: true });
  }

  for (const email of emailHistory) {
    const timestamp = toIsoString(email.sentTime);
    if (!timestamp) continue;
    if (email.isReply) {
      events.push({ type: 'email_reply', timestamp, isHuman: true });
    } else if (email.opened) {
      events.push({ type: 'email_open', timestamp, isHuman: false });
    }
  }

  for (const activity of activities) {
    const timestamp = toIsoString(activity.createTime);
    if (!timestamp || !activity.type) continue;
    const type = mapActivityType(activity.type);
    events.push({ type, timestamp, isHuman: type === 'call' || type === 'note' || type === 'email_reply' });
  }

  return events;
}

function computeEngagement(touchHistory: TouchEvent[]): LeadEngagement {
  const now = Date.now();
  let lastHumanTouchAt: string | null = null;
  let lastAnyTouchAt: string | null = null;
  let touchCountLast60Days = 0;
  let humanTouchCountLast60Days = 0;

  for (const event of touchHistory) {
    const eventTime = new Date(event.timestamp).getTime();
    if (Number.isNaN(eventTime)) continue;

    if (lastAnyTouchAt === null || eventTime > new Date(lastAnyTouchAt).getTime()) {
      lastAnyTouchAt = event.timestamp;
    }
    if (event.isHuman && (lastHumanTouchAt === null || eventTime > new Date(lastHumanTouchAt).getTime())) {
      lastHumanTouchAt = event.timestamp;
    }

    const ageDays = (now - eventTime) / MS_PER_DAY;
    if (ageDays <= ENGAGEMENT_WINDOW_DAYS) {
      touchCountLast60Days += 1;
      if (event.isHuman) humanTouchCountLast60Days += 1;
    }
  }

  return { lastHumanTouchAt, lastAnyTouchAt, touchCountLast60Days, humanTouchCountLast60Days };
}

/**
 * Normalizes a raw Lofty lead plus its notes, call history, email history,
 * and activity timeline into the LeadProfile contract consumed by
 * downstream agents.
 */
export function normalizeLeadProfile(
  loftyLead: LoftyLead,
  notes: LoftyNote[],
  callHistory: LoftyCallHistoryItem[] = [],
  emailHistory: LoftyEmailHistoryItem[] = [],
  activities: LoftyActivityItem[] = [],
): LeadProfile {
  const hasAddress =
    loftyLead.streetAddress || loftyLead.city || loftyLead.state || loftyLead.zipCode;

  const touchHistory = buildTouchHistory(notes, callHistory, emailHistory, activities);

  return {
    leadId: String(loftyLead.leadId),
    source: loftyLead.source,
    firstName: loftyLead.firstName || null,
    lastName: loftyLead.lastName || null,
    phone: loftyLead.phone || null,
    utmData: extractUtmData(loftyLead.customAttributes),
    tags: (loftyLead.tags ?? []).map((tag) => tag.tagName),
    leadIntent: LEAD_TYPE_TO_INTENT[loftyLead.leadTypes?.[0] as number] ?? 'unknown',
    buyingTimeframe: normalizeTimeframe(loftyLead.buyingTimeFrame),
    sellingTimeframe: normalizeTimeframe(loftyLead.sellingTimeFrame),
    preApproved: mapYesNo(loftyLead.preQual),
    hasHouseToSell: mapYesNo(loftyLead.houseToSell),
    withBuyerAgent: loftyLead.withBuyerAgent ?? null,
    withListingAgent: loftyLead.withListingAgent ?? null,
    assignedUser: loftyLead.assignedUser ?? null,
    currentHomeAddress: hasAddress
      ? {
          streetAddress: loftyLead.streetAddress ?? '',
          city: loftyLead.city ?? '',
          state: loftyLead.state ?? '',
          zipCode: loftyLead.zipCode ?? '',
        }
      : null,
    propertiesViewed: loftyLead.leadPropertyList?.length
      ? loftyLead.leadPropertyList.map((property) => ({
          address: property.streetAddress,
          price: property.price,
          mls: property.listingId,
        }))
      : null,
    inquiredProperties: loftyLead.leadInquiry
      ? {
          priceMin: loftyLead.leadInquiry.priceMin ?? 0,
          priceMax: loftyLead.leadInquiry.priceMax ?? 0,
          bedroomsMin: loftyLead.leadInquiry.bedroomsMin ?? 0,
          propertyTypes: loftyLead.leadInquiry.propertyType ?? [],
        }
      : null,
    formResponses: parseFormResponses(notes),
    touchHistory,
    engagement: computeEngagement(touchHistory),
    capturedAt: toIsoString(loftyLead.createTime),
    lastUpdatedAt: toIsoString(loftyLead.lastUpdateTime),
  };
}
