import Database from 'better-sqlite3';
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
 */
const DB_PATH = process.env.EMAIL_LOG_DB_PATH || path.join(process.cwd(), 'data', 'email-log.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
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

const insertStmt = db.prepare(`
  INSERT INTO sent_emails (lead_id, sent, template_key, subject, body, reason, created_at)
  VALUES (@leadId, @sent, @templateKey, @subject, @body, @reason, @createdAt)
`);

export function logEmailAttempt(entry: EmailLogEntry): void {
  insertStmt.run({
    leadId: entry.leadId,
    sent: entry.sent ? 1 : 0,
    templateKey: entry.templateKey,
    subject: entry.subject,
    body: entry.body,
    reason: entry.reason,
    createdAt: new Date().toISOString(),
  });
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
  const rows = db
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
  const rows = db.prepare(`SELECT * FROM sent_emails WHERE lead_id = ? ORDER BY id DESC`).all(leadId) as RawRow[];
  return rows.map(toRow);
}

export function getEmailById(id: number): EmailLogRow | null {
  const raw = db.prepare(`SELECT * FROM sent_emails WHERE id = ?`).get(id) as RawRow | undefined;
  return raw ? toRow(raw) : null;
}
