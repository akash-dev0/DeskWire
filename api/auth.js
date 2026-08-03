// api/auth.js
// Lightweight username+password auth. No external mail service needed.
// Sessions are stateless signed tokens (HMAC), so no session table required.
// User records live in Vercel KV.

import { kv } from '@vercel/kv';
import crypto from 'crypto';

const SESSION_SECRET = process.env.SESSION_SECRET; // set this in Vercel env vars
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload; // { username, exp }
  } catch {
    return null;
  }
}

function isValidUsername(u) {
  return typeof u === 'string' && /^[a-zA-Z0-9_-]{3,24}$/.test(u);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { action, username, password } = req.body || {};

  if (!isValidUsername(username) || typeof password !== 'string' || password.length < 6) {
    res.status(400).json({ error: 'Username must be 3-24 alphanumeric characters; password must be at least 6 characters.' });
    return;
  }

  const userKey = `user:${username.toLowerCase()}`;

  if (action === 'signup') {
    const existing = await kv.get(userKey);
    if (existing) {
      res.status(409).json({ error: 'That username is taken.' });
      return;
    }
    const salt = makeSalt();
    const hash = hashPassword(password, salt);
    await kv.set(userKey, { username, salt, hash, createdAt: Date.now() });

    const token = sign({ username, exp: Date.now() + SESSION_TTL_SECONDS * 1000 });
    res.status(200).json({ token, username });
    return;
  }

  if (action === 'login') {
    const user = await kv.get(userKey);
    if (!user) {
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }
    const hash = hashPassword(password, user.salt);
    if (hash !== user.hash) {
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }
    const token = sign({ username: user.username, exp: Date.now() + SESSION_TTL_SECONDS * 1000 });
    res.status(200).json({ token, username: user.username });
    return;
  }

  res.status(400).json({ error: 'Unknown action. Use "signup" or "login".' });
}
