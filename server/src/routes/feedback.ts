import { Router } from 'express';
import type { Request, Response } from 'express';
import { resolveAuth } from '../lib/system-prompt.js';
import { recordFeedback, sanitizeFeedback } from '../lib/hermes-feedback.js';

// POST /v1/hermesfllm/feedback — the Hermes plugin reports what the agent did with each answer.
// Same credential as inference (the unified key or a client-profile key), so only a client that
// can already use the router can feed its quality signal.
export const feedbackRouter = Router();

feedbackRouter.post('/feedback', (req: Request, res: Response) => {
  const header = req.headers.authorization;
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
  if (!resolveAuth(token)) {
    res.status(401).json({ error: { message: 'invalid API key', type: 'authentication_error' } });
    return;
  }
  const events = sanitizeFeedback(req.body?.events);
  const stored = recordFeedback(events);
  res.json({ stored, dropped: (Array.isArray(req.body?.events) ? req.body.events.length : 0) - stored });
});
