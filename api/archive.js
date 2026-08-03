// api/archive.js
// Stores/retrieves pipeline runs in Vercel KV, scoped per user.
// GET  ?share=<id>          -> public, no auth (for share links)
// GET  (authed)             -> list current user's runs
// POST (authed)             -> save a run, returns { id, shareUrl }
// DELETE ?id=<id> (authed)  -> delete a run

import { Redis } from '@upstash/redis';
import { verifyToken } from './auth.js';
import crypto from 'crypto';

const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

function getAuthedUser(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  const payload = verifyToken(token);
  return payload?.username || null;
}

export default async function handler(req, res) {
  // Public share link view - no auth required
  if (req.method === 'GET' && req.query.share) {
    const run = await kv.get(`run:${req.query.share}`);
    if (!run) {
      res.status(404).json({ error: 'This dispatch was not found or has been removed.' });
      return;
    }
    res.status(200).json({ run });
    return;
  }

  const username = getAuthedUser(req);
  if (!username) {
    res.status(401).json({ error: 'Sign in to access your archive.' });
    return;
  }

  const listKey = `archive:${username}`;

  if (req.method === 'GET') {
    const ids = (await kv.get(listKey)) || [];
    const runs = await Promise.all(ids.map((id) => kv.get(`run:${id}`)));
    res.status(200).json({ runs: runs.filter(Boolean) });
    return;
  }

  if (req.method === 'POST') {
    const { topic, findings, draft, critique, final, tags, model } = req.body || {};
    if (!topic || !final) {
      res.status(400).json({ error: 'A topic and final draft are required to save.' });
      return;
    }
    const id = crypto.randomBytes(8).toString('hex');
    const run = {
      id,
      username,
      topic,
      findings,
      draft,
      critique,
      final,
      tags: Array.isArray(tags) ? tags.slice(0, 8) : [],
      model: model || 'llama-3.3-70b-versatile',
      createdAt: Date.now(),
    };
    await kv.set(`run:${id}`, run);

    const ids = (await kv.get(listKey)) || [];
    ids.unshift(id);
    await kv.set(listKey, ids.slice(0, 200)); // cap archive size

    res.status(200).json({ id, shareUrl: `/?share=${id}` });
    return;
  }

  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) {
      res.status(400).json({ error: 'Missing run id.' });
      return;
    }
    const run = await kv.get(`run:${id}`);
    if (!run || run.username !== username) {
      res.status(404).json({ error: 'Run not found.' });
      return;
    }
    await kv.del(`run:${id}`);
    const ids = (await kv.get(listKey)) || [];
    await kv.set(listKey, ids.filter((x) => x !== id));
    res.status(200).json({ deleted: id });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}
