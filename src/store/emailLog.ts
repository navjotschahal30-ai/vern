import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

/**
 * Temporary review log for every email Vern attempts to send — separate
 * from Lofty (which stays the system of record for lead state/history).
 * This exists purely so a human can check "what did Vern actually send
 * today" without opening each lead in Lofty. On Railway, the filesystem is
 * ephemeral unless a Volume is mounted at DB_DIR — without one, this
 * resets on every redeploy, which is the point (temporary, not a permanent
 * store).
 *
 * Initialization is lazy and defensive: if the runtime environment can't
 * write to disk or load the native sqlite binding (e.g. a read-only
 * container filesystem with no volume mounted), this degrades to a no-op
 * logger instead of crashing the whole app at import time — a review log
 * failing open must never take down real email sending.
 */
const DB_PATH = process.env.EMAIL_LOG_DB_PATH || path.join(process.cwd(), 'data', 'email-log.db');

let db: Database.Database | null = null;
let initAttempted = false;

function getDb(): Database.Database | null {
  if (initAttempted) return db;
  initAttempted = true;

  try {
    // Required lazily (not a static import) so a failure to load the
    // native binding itself can't crash the process before this try/catch
    // even runs — a static `import` at module top-level would throw
    // synchronously during module resolution, outside any try/catch.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const BetterSqlite3: typeof Database = require('better-sqlite3');
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const instance = new BetterSqlite3(DB_PATH);
    instance.pragma('journal_mode = WAL');
    instance.exec(`
      CREATE TABLE IF NOT EXISTS sent_emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id TEXT NOT NULL,
        sent INTEGER NOT NULL,
        template_key TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sent_emails_lead_id ON sent_emails(lead_id);
      CREATE INDEX IF NOT EXISTS idx_sent_emails_created_at ON sent_emails(created_at);
    `);
    db = instance;
  } catch (error) {
    console.error('[emailLog] disabled — could not initialize SQLite log:', error);
    db = null;
  }

  return db;
}

export interface EmailLogEntry {
  leadId: string;
  sent: boolean;
  templateKey: string;
  subject: string;
  body: string;
  reason: string;
}

export interface EmailLogRow extends EmailLogEntry {
  id: number;
  createdAt: string;
}

export function logEmailAttempt(entry: EmailLogEntry): void {
  const instance = getDb();
  if (!instance) return;

  try {
    instance
      .prepare(
        `INSERT INTO sent_emails (lead_id, sent, template_key, subject, body, reason, created_at)
         VALUES (@leadId, @sent, @templateKey, @subject, @body, @reason, @createdAt)`,
      )
      .run({
        leadId: entry.leadId,
        sent: entry.sent ? 1 : 0,
        templateKey: entry.templateKey,
        subject: entry.subject,
        body: entry.body,
        reason: entry.reason,
        createdAt: new Date().toISOString(),
      });
  } catch (error) {
    console.error('[emailLog] failed to write entry (email send itself is unaffected):', error);
  }
}

interface RawRow {
  id: number;
  lead_id: string;
  sent: number;
  template_key: string;
  subject: string;
  body: string;
  reason: string;
  created_at: string;
}

function toRow(raw: RawRow): EmailLogRow {
  return {
    id: raw.id,
    leadId: raw.lead_id,
    sent: raw.sent === 1,
    templateKey: raw.template_key,
    subject: raw.subject,
    body: raw.body,
    reason: raw.reason,
    createdAt: raw.created_at,
  };
}

/** Most recent attempts first, metadata only (no body — keep the list light). */
export function getRecentEmails(limit = 50): Omit<EmailLogRow, 'body'>[] {
  const instance = getDb();
  if (!instance) return [];

  const rows = instance
    .prepare(`SELECT id, lead_id, sent, template_key, subject, reason, created_at FROM sent_emails ORDER BY id DESC LIMIT ?`)
    .all(limit) as Omit<RawRow, 'body'>[];
  return rows.map((raw) => ({
    id: raw.id,
    leadId: raw.lead_id,
    sent: raw.sent === 1,
    templateKey: raw.template_key,
    subject: raw.subject,
    reason: raw.reason,
    createdAt: raw.created_at,
  }));
}

export function getEmailsForLead(leadId: string): EmailLogRow[] {
  const instance = getDb();
  if (!instance) return [];

  const rows = instance.prepare(`SELECT * FROM sent_emails WHERE lead_id = ? ORDER BY id DESC`).all(leadId) as RawRow[];
  return rows.map(toRow);
}

export function getEmailById(id: number): EmailLogRow | null {
  const instance = getDb();
  if (!instance) return null;

  const raw = instance.prepare(`SELECT * FROM sent_emails WHERE id = ?`).get(id) as RawRow | undefined;
  return raw ? toRow(raw) : null;
}
