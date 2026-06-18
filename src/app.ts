import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import { handleLoftyEvent } from './handlers/eventListener';
import { handleLoftyWebhook } from './handlers/loftyWebhookHandler';
import { buildCadence } from './engines/cadenceManager';
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
    const { scheduled, skipped } = await buildCadence(leadIds);
    res.json({ scheduled, skipped });
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

const port = process.env.VERN_PORT || 3000;
app.listen(port, () => console.log(`Vern listening on port ${port}`));
