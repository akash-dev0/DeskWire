// api/agent.js
// Streams tokens back over Server-Sent Events so the UI can render
// each agent's output as it's generated instead of waiting for the
// full response.
//
// Body: { role, input, topic, useSearch, model, systemPrompt }
// role: "researcher" | "writer" | "critic"

import { verifyToken } from './auth.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const TAVILY_URL = 'https://api.tavily.com/search';

const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const ALLOWED_MODELS = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.6-27b',
];

const DEFAULT_PROMPTS = {
  researcher: `You are a research agent. You are given search results about a topic.
Organize them into a clear set of findings. For every factual claim, cite the
source using [1], [2], etc. matching the numbered sources you were given.
End with a "Sources" section listing each numbered source's title and URL.
Do not add claims that aren't backed by the given search results.`,
  writer: `You are a writer agent. Write using ONLY the research findings you are
given — do not add outside facts. Preserve the [n] citation markers from the
findings where relevant. Write clearly and directly, no filler.`,
  critic: `You are a critic agent. Compare the draft against the findings.
Flag any claim in the draft that is NOT supported by the findings, quoting
the unsupported sentence. Also flag any findings that were ignored. Be
specific and terse — a bullet list of issues, not prose.`,
};

async function tavilySearch(query) {
  const res = await fetch(TAVILY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results: 6,
      include_answer: false,
    }),
  });
  if (!res.ok) throw new Error(`Tavily search failed: ${await res.text()}`);
  const data = await res.json();
  return data.results || [];
}

function formatSources(results) {
  return results
    .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content?.slice(0, 500) || ''}`)
    .join('\n\n');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Auth optional here: allow anonymous use, but attach username if present
  // so callers can be rate-limited or tracked later.
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  const user = verifyToken(token);

  const {
    role,
    input,
    topic,
    useSearch = true,
    model = DEFAULT_MODEL,
    systemPrompt,
  } = req.body || {};

  if (!['researcher', 'writer', 'critic'].includes(role)) {
    res.status(400).json({ error: 'role must be researcher, writer, or critic' });
    return;
  }
  const chosenModel = ALLOWED_MODELS.includes(model) ? model : DEFAULT_MODEL;
  const system = (systemPrompt && systemPrompt.trim()) || DEFAULT_PROMPTS[role];

  let userContent = input;
  let sourcesBlock = '';

  if (role === 'researcher' && useSearch) {
    try {
      const results = await tavilySearch(topic || input);
      sourcesBlock = formatSources(results);
      userContent = `${input}\n\nSearch results:\n${sourcesBlock}`;
    } catch (err) {
      // Degrade gracefully: continue without live search rather than fail the whole run
      userContent = `${input}\n\n(Note: live web search was unavailable — answer from general knowledge and say so.)`;
    }
  }

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const groqRes = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: chosenModel,
        stream: true,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
      }),
    });

    if (!groqRes.ok || !groqRes.body) {
      send('error', { message: `Groq request failed: ${await groqRes.text()}` });
      res.end();
      return;
    }

    const reader = groqRes.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    let usage = null;
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line for next chunk

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            send('token', { text: delta });
          }
          if (json.x_groq?.usage) usage = json.x_groq.usage;
          if (json.usage) usage = json.usage;
        } catch {
          // ignore malformed SSE fragments
        }
      }
    }

    send('done', {
      output: full,
      sources: role === 'researcher' ? sourcesBlock : undefined,
      usage,
      model: chosenModel,
    });
    res.end();
  } catch (err) {
    send('error', { message: err.message });
    res.end();
  }
}
