import pg from 'pg';
import { applyRateLimitHeaders, checkRateLimit } from '../lib/rate-limit.js';

const { Pool } = pg;

const DEFAULT_ALLOWED_ORIGINS = [
  'https://smm.fredericlabadie.com',
  'http://localhost:4200',
  'http://127.0.0.1:4200',
];

const VALID_TYPES = new Set(['useful', 'inaccuracy', 'issue']);
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL;

let pool;
let schemaReady = false;

function getPool() {
  if (!DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 1,
      idleTimeoutMillis: 10_000,
    });
  }
  return pool;
}

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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
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

function clean(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

function normalizePayload(payload, req) {
  const type = clean(payload.type, 40);
  if (!VALID_TYPES.has(type)) {
    const err = new Error('Feedback type must be useful, inaccuracy, or issue.');
    err.code = 'BAD_TYPE';
    throw err;
  }

  return {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    type,
    question: clean(payload.question),
    rewrite: clean(payload.rewrite),
    gap: clean(payload.gap, 80),
    category: clean(payload.category, 120),
    comment: clean(payload.comment, 2000),
    model: clean(payload.model, 160),
    prompt_version: clean(payload.prompt_version, 80),
    page: clean(payload.page, 500),
    user_agent: clean(req.headers['user-agent'], 500),
    source: clean(payload.source, 80),
  };
}

async function ensureSchema(client) {
  if (schemaReady) return;
  // Table must exist before the ALTER and indexes — run first, then parallelize the rest.
  await client.query(`
    CREATE TABLE IF NOT EXISTS smm_feedback (
      id uuid PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      type text NOT NULL CHECK (type IN ('useful', 'inaccuracy', 'issue')),
      question text,
      rewrite text,
      gap text,
      category text,
      comment text,
      model text,
      prompt_version text,
      page text,
      user_agent text,
      source text,
      status text NOT NULL DEFAULT 'new',
      reviewed_at timestamptz,
      reviewer_note text
    )
  `);
  await Promise.all([
    client.query(`ALTER TABLE smm_feedback ADD COLUMN IF NOT EXISTS category text`),
    client.query(`CREATE INDEX IF NOT EXISTS smm_feedback_created_at_idx ON smm_feedback (created_at DESC)`),
    client.query(`CREATE INDEX IF NOT EXISTS smm_feedback_status_idx ON smm_feedback (status)`),
    client.query(`CREATE INDEX IF NOT EXISTS smm_feedback_source_idx ON smm_feedback (source)`),
    client.query(`CREATE INDEX IF NOT EXISTS smm_feedback_category_idx ON smm_feedback (category)`),
  ]);
  schemaReady = true;
}

async function storeFeedback(feedback) {
  const db = getPool();
  if (!db) return { stored: false, storage: 'logs', reason: 'NO_DATABASE_URL' };

  const client = await db.connect();
  try {
    await ensureSchema(client);
    await client.query(
      `INSERT INTO smm_feedback (
        id, created_at, type, question, rewrite, gap, category, comment,
        model, prompt_version, page, user_agent, source
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        feedback.id,
        feedback.created_at,
        feedback.type,
        feedback.question,
        feedback.rewrite,
        feedback.gap,
        feedback.category,
        feedback.comment,
        feedback.model,
        feedback.prompt_version,
        feedback.page,
        feedback.user_agent,
        feedback.source,
      ],
    );
    return { stored: true, storage: 'neon' };
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, {
      ok: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' },
    });
    return;
  }

  const rate = checkRateLimit(req, { namespace: 'feedback', limit: Number(process.env.FEEDBACK_RATE_LIMIT_MAX || 30) });
  applyRateLimitHeaders(res, rate);
  if (!rate.allowed) {
    sendJson(res, 429, {
      ok: false,
      error: { code: 'RATE_LIMITED', message: 'Too many feedback submissions. Please try again shortly.' },
    });
    return;
  }

  let parsed;
  try {
    const body = await readBody(req);
    parsed = body ? JSON.parse(body) : {};
  } catch {
    sendJson(res, 400, {
      ok: false,
      error: { code: 'BAD_JSON', message: 'Invalid JSON body.' },
    });
    return;
  }

  let feedback;
  try {
    feedback = normalizePayload(parsed, req);
  } catch (err) {
    sendJson(res, 400, {
      ok: false,
      error: { code: err.code || 'BAD_REQUEST', message: err.message },
    });
    return;
  }

  console.log('smm-feedback', feedback);

  let storage;
  try {
    storage = await storeFeedback(feedback);
  } catch (err) {
    console.error('smm-feedback-db-error', {
      id: feedback.id,
      code: err.code,
      message: err.message,
    });
    storage = { stored: false, storage: 'logs', reason: 'DB_INSERT_FAILED' };
  }

  sendJson(res, 200, {
    ok: true,
    id: feedback.id,
    message: storage.stored ? 'Feedback recorded in database.' : 'Feedback recorded in logs.',
    storage,
  });
}
