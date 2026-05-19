import { applyRateLimitHeaders, checkRateLimit } from '../lib/rate-limit.js';

const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V3-0324:fastest';
const ROUTER_URL = 'https://router.huggingface.co/v1/chat/completions';
const DEFAULT_ALLOWED_ORIGINS = [
  'https://smm.fredericlabadie.com',
  'http://localhost:4200',
  'http://127.0.0.1:4200',
];

const GAP_VALUES = ['decision', 'barrier', 'problematic', 'role', 'spinout', 'washout'];
const PROMPT_VERSION = process.env.PROMPT_VERSION || 'smm-rewriter-2026-05';

function getAllowedOrigins() {
  const configured = process.env.ALLOWED_ORIGINS;
  if (!configured) return DEFAULT_ALLOWED_ORIGINS;
  return configured.split(',').map((s) => s.trim()).filter(Boolean);
}

function applyCors(req, res) {
  const origin = req.headers.origin || '';
  const allowed = getAllowedOrigins();
  res.setHeader('Vary', 'Origin');
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 50_000) {
        reject(new Error('Request body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// Legacy shim: old callers sent { prompt } using a chat-template format from
// earlier LLaMA/Mistral models (<|user|>…<|assistant|>). The current frontend
// always sends { question }, so this path is only hit by direct API clients
// using the old format. Do not remove until confirmed no callers remain.
function extractQuestionFromPrompt(prompt) {
  const text = String(prompt || '');
  const userMatch = text.match(/<\|user\|>\s*([\s\S]*?)(?:<\|assistant\|>|$)/i);
  if (userMatch && userMatch[1]) return userMatch[1].trim();
  return text.trim();
}

async function parseRequest(req) {
  if (req.method === 'GET') {
    const host = req.headers.host ? `https://${req.headers.host}` : 'https://smm-api.fredericlabadie.com';
    const url = new URL(req.url || '/', host);
    const question = String(url.searchParams.get('question') || '').trim();
    if (question) return { question, browserTest: true };
    const err = new Error('Use POST, or provide ?question=... for browser testing.');
    err.code = 'METHOD_NOT_ALLOWED';
    err.status = 405;
    throw err;
  }

  const body = await readBody(req);
  const contentType = String(req.headers['content-type'] || '').toLowerCase();

  if (contentType.includes('application/json')) {
    let parsed;
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      const err = new Error('Invalid JSON body.');
      err.code = 'BAD_JSON';
      throw err;
    }

    const question = String(parsed.question || '').trim();
    if (question) return { question };

    const prompt = String(parsed.prompt || '').trim();
    if (prompt) return { question: extractQuestionFromPrompt(prompt), legacyPrompt: prompt };

    const err = new Error('Request body must include question or prompt.');
    err.code = 'MISSING_QUESTION';
    throw err;
  }

  const raw = body.trim();
  if (!raw) {
    const err = new Error('Request body is empty.');
    err.code = 'MISSING_QUESTION';
    throw err;
  }

  return { question: extractQuestionFromPrompt(raw), legacyPrompt: raw };
}

function buildSystemPrompt() {
  return `You are an expert practitioner using Brenda Dervin's Sense-Making Methodology (SMM). A user will give you a research question, survey question, UX interview question, or A/B test hypothesis.

Important accuracy constraint: use the gap labels below as this course's practitioner heuristic. They are grounded where possible in Dervin's movement-state / stop framing, but they are not a canonical six-part Dervin taxonomy. Do not claim that Dervin herself published these exact six categories.

Practitioner labels:
- decision: Facing a choice; unclear how to decide.
- barrier: External obstacle blocking movement.
- problematic: Something feels wrong but is unclear or unnamed.
- role: Course extension for unclear role/script expectations in organisational, UX, or product settings.
- spinout: Total disorientation; no clear question yet.
- washout: Information was received but did not address the actual gap.

Your task:
1. DIAGNOSE: Give exactly 3 bullet points explaining what is wrong with the question from an SMM perspective. Focus on what it presupposes, whether it asks about a moment or a generality, and whether it leaves room for both helps and hurts.
2. REWRITE: Rewrite the question using SMM neutral questioning principles: anchor a specific moment, leave the gap type open, probe for bridges and hurts.
3. GAP_LABEL: Suggest one tentative practitioner gap label: decision, barrier, problematic, role, spinout, or washout. Treat this as an analytic prompt, not as the respondent's answer and not as a canonical Dervin taxonomy.
4. WHY: In 1-2 sentences, explain why the rewrite produces more useful data than the original.
5. DIFF: Show what was cut and what was added.

Respond ONLY with valid JSON, no markdown, no preamble. Schema:
{"diagnosis":["...","...","..."],"rewrite":"...","gap":"decision|barrier|problematic|role|spinout|washout","why":"...","diff":[{"kind":"cut","text":"..."},{"kind":"add","text":"..."},{"kind":"add","text":"..."}]}`;
}

async function callHuggingFace(question) {
  const token = process.env.HF_TOKEN;
  if (!token) {
    const err = new Error('HF_TOKEN is not configured.');
    err.code = 'MISSING_TOKEN';
    throw err;
  }

  const model = process.env.HF_MODEL || DEFAULT_MODEL;
  const started = Date.now();
  const response = await fetch(ROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      stream: false,
      temperature: 0.2,
      max_tokens: 650,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: question },
      ],
    }),
    signal: AbortSignal.timeout(18_000),
  });

  const responseText = await response.text();
  let payload;
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    payload = responseText;
  }

  if (!response.ok) {
    const err = new Error('Hugging Face router request failed.');
    err.code = response.status === 401 ? 'HF_UNAUTHORIZED' : 'MODEL_ERROR';
    err.status = response.status;
    err.payload = payload;
    throw err;
  }

  const generatedText = payload?.choices?.[0]?.message?.content || '';

  if (!generatedText) {
    const err = new Error('Model returned no chat completion text.');
    err.code = 'EMPTY_MODEL_RESPONSE';
    err.payload = payload;
    throw err;
  }

  return { text: generatedText, model, latencyMs: Date.now() - started };
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeResult(candidate, originalQuestion) {
  const diagnosis = Array.isArray(candidate?.diagnosis)
    ? candidate.diagnosis.map((d) => String(d).trim()).filter(Boolean).slice(0, 3)
    : [];

  while (diagnosis.length < 3) {
    diagnosis.push('The question needs a more specific moment, gap, bridge, or hurt probe.');
  }

  const rewrite = String(candidate?.rewrite || '').trim() ||
    'Walk me through a specific moment when this came up for you. What were you trying to do, what did you reach for, and what got in the way?';

  const candidateGap = String(candidate?.gap || '').trim().toLowerCase();
  const gap = GAP_VALUES.includes(candidateGap) ? candidateGap : 'washout';

  const why = String(candidate?.why || '').trim() ||
    'This anchors the question in a specific micro-moment and leaves room for the participant to describe helps, hurts, and bridges in their own terms.';

  let diff = Array.isArray(candidate?.diff) ? candidate.diff : [];
  diff = diff
    .map((item) => ({
      kind: item?.kind === 'cut' ? 'cut' : 'add',
      text: String(item?.text || '').trim(),
    }))
    .filter((item) => item.text)
    .slice(0, 4);

  if (!diff.length) {
    diff = [
      { kind: 'cut', text: originalQuestion },
      { kind: 'add', text: rewrite },
    ];
  }

  return { diagnosis, rewrite, gap, why, diff };
}

function fallbackResult(question) {
  return {
    diagnosis: [
      'Asks for an evaluation rather than situating a concrete moment.',
      'Presupposes the relevant bridge before diagnosing the participant’s actual gap.',
      'Does not invite both helps and hurts.',
    ],
    rewrite: 'Walk me through a specific moment when this came up for you. What were you trying to do, what did you reach for, and what got in the way?',
    gap: 'washout',
    why: 'This anchors the question in a specific micro-moment, leaves room for any bridge type the participant actually used, and probes for both helps and hurts.',
    diff: [
      { kind: 'cut', text: question },
      { kind: 'add', text: 'Walk me through a specific moment when this came up for you.' },
      { kind: 'add', text: 'What were you trying to do, what did you reach for, and what got in the way?' },
    ],
  };
}

function publicError(code, message, started, extra = {}) {
  return {
    ok: false,
    error: { code, message },
    meta: {
      prompt_version: PROMPT_VERSION,
      latency_ms: Date.now() - started,
      ...extra,
    },
  };
}

function summarizeProviderPayload(payload) {
  if (!payload) return undefined;
  if (typeof payload === 'string') return payload.slice(0, 240);
  if (payload.error) return String(payload.error).slice(0, 240);
  if (payload.message) return String(payload.message).slice(0, 240);
  return undefined;
}

export default async function handler(req, res) {
  const started = Date.now();
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    sendJson(res, 405, publicError('METHOD_NOT_ALLOWED', 'Use POST, or provide ?question=... for browser testing.', started));
    return;
  }

  const rate = checkRateLimit(req, { namespace: 'rewrite', limit: Number(process.env.REWRITE_RATE_LIMIT_MAX || 20) });
  applyRateLimitHeaders(res, rate);
  if (!rate.allowed) {
    sendJson(res, 429, publicError('RATE_LIMITED', 'Too many rewrite requests. Please try again shortly.', started));
    return;
  }

  let request;
  try {
    request = await parseRequest(req);
  } catch (err) {
    sendJson(res, err.status || 400, publicError(err.code || 'BAD_REQUEST', err.message, started));
    return;
  }

  const question = String(request.question || '').trim();
  if (!question || question.length < 4) {
    sendJson(res, 400, publicError('MISSING_QUESTION', 'Question is missing or too short.', started));
    return;
  }

  if (question.length > 4000) {
    sendJson(res, 413, publicError('QUESTION_TOO_LONG', 'Question is too long.', started));
    return;
  }

  try {
    const modelResponse = await callHuggingFace(question);
    const parsed = extractJsonObject(modelResponse.text);
    const result = parsed ? normalizeResult(parsed, question) : fallbackResult(question);

    sendJson(res, 200, {
      ok: true,
      source: parsed ? 'ai' : 'server_fallback',
      result,
      meta: {
        model: modelResponse.model,
        provider: 'huggingface-router',
        prompt_version: PROMPT_VERSION,
        latency_ms: Date.now() - started,
        browser_test: Boolean(request.browserTest),
      },
    });
  } catch (err) {
    console.error('rewrite-error', {
      code: err.code || 'MODEL_ERROR',
      status: err.status,
      message: err.message,
      payload: err.payload,
    });

    sendJson(res, 502, publicError(
      err.code || 'MODEL_ERROR',
      'The model request failed. The course frontend should use its local heuristic fallback.',
      started,
      {
        model: process.env.HF_MODEL || DEFAULT_MODEL,
        provider: 'huggingface-router',
        provider_status: err.status,
        provider_message: summarizeProviderPayload(err.payload),
        browser_test: Boolean(request?.browserTest),
      },
    ));
  }
}
