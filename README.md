# DESKWIRE — Research → Write → Critique Agent (v2)

An autonomous editorial desk: three AI agents (Researcher, Writer, Critic)
that pass a story down the line, styled as a wire-service dispatch feed.

## What's new in v2

- **Streaming output** — tokens render live as each agent writes, instead of
  waiting for the full response
- **Accounts** — username/password login, no email service required
- **Persistent archive** — saved runs live in Vercel KV, scoped per user,
  survive across devices
- **Share links** — `?share=<id>` loads a specific saved dispatch publicly
- **Custom agent prompts** — override the Researcher/Writer/Critic system
  instructions from the UI
- **Model picker** — switch between Groq-hosted models per run
- **Skip stages** — bypass research, drafting, or critique individually
- **Cancel mid-run**
- **Diff view** — see exactly what changed between the first draft and the
  final revision
- **Inline sources** — Researcher dispatch shows a clickable source list
- **Word count / read time** on the final piece
- **Export to Markdown or PDF** (PDF via browser print dialog)
- **Tags + archive search/filter**
- **Session token usage tracker** (approximate, from Groq's usage stats)

## Stack

- **Groq** — free LLM API (Llama 3.3 70B, 3.1 8B, Mixtral, Gemma2). console.groq.com/keys
- **Tavily** — free web search API for agents, 1000 searches/month free. tavily.com
- **Vercel KV** — free tier Redis-compatible store, used for users + archive

## Setup

### 1. Create accounts / keys
- Groq: console.groq.com/keys → create key
- Tavily: tavily.com → dashboard → copy API key
- Vercel KV: in your Vercel project → Storage tab → Create → KV database
  (this auto-injects the KV env vars into your project)

### 2. Environment variables (Vercel → Settings → Environment Variables)
```
GROQ_API_KEY = gsk_...
TAVILY_API_KEY = tvly-...
SESSION_SECRET = <any long random string, e.g. `openssl rand -hex 32`>
```
KV vars (`KV_REST_API_URL`, `KV_REST_API_TOKEN`, etc.) are added automatically
when you create the KV store from the Vercel dashboard — no manual copying needed.

### 3. Install & deploy
```
npm install
vercel deploy --prod
```

### 4. Local testing
```
vercel dev
```
The frontend auto-detects its own origin, so no URL to hardcode — it calls
`/api/agent`, `/api/auth`, `/api/archive` relative to wherever it's hosted.
If you ever need to point it at a different backend, run in the browser console:
```js
localStorage.setItem('deskwire_api_base', 'https://your-other-deploy.vercel.app')
```

## Notes

- **Auth is intentionally lightweight**: scrypt-hashed passwords, HMAC-signed
  stateless session tokens (no session table, no external auth provider).
  Good for a personal/small-team tool. Swap in a real auth provider
  (Clerk, Auth0, NextAuth) if you need password resets, SSO, or stronger
  guarantees.
- **Streaming** uses Server-Sent Events. Vercel's default function timeout is
  short on some plans — `vercel.json` raises `api/agent.js` to 60s.
- **PDF export** opens the browser print dialog rather than generating a PDF
  server-side, to avoid adding a headless-browser dependency.
- Model list in the picker is hardcoded to what's confirmed available on
  Groq's free tier as of writing — check console.groq.com for current models
  and adjust `ALLOWED_MODELS` in `api/agent.js` if it changes.
