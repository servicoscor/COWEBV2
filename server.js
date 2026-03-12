const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT || 5050);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DB_PATH = path.join(DATA_DIR, 'cowebv2.db');
const COLLECTION_NAMES = new Set(['systems', 'anydesk', 'infra', 'quick']);

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  stage INTEGER NOT NULL DEFAULT 1,
  heat INTEGER NOT NULL DEFAULT 1,
  ts TEXT,
  updated_at INTEGER NOT NULL
);

INSERT INTO app_state (id, stage, heat, ts, updated_at)
SELECT 1, 1, 1, NULL, (strftime('%s','now') * 1000)
WHERE NOT EXISTS (SELECT 1 FROM app_state WHERE id = 1);

CREATE TABLE IF NOT EXISTS collections (
  name TEXT PRIMARY KEY,
  payload TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
`);

const stmtGetState = db.prepare(`
  SELECT stage, heat, ts, updated_at AS updatedAt
  FROM app_state
  WHERE id = 1
`);

const stmtSetState = db.prepare(`
  UPDATE app_state
  SET stage = ?, heat = ?, ts = ?, updated_at = ?
  WHERE id = 1
`);

const stmtGetCollection = db.prepare(`
  SELECT payload, updated_at AS updatedAt
  FROM collections
  WHERE name = ?
`);

const stmtUpsertCollection = db.prepare(`
  INSERT INTO collections (name, payload, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(name) DO UPDATE SET
    payload = excluded.payload,
    updated_at = excluded.updated_at
`);

function normalizeLevel(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return null;
  return Math.max(min, Math.min(max, parsed));
}

function readCollection(name) {
  const row = stmtGetCollection.get(name);
  if (!row) return { items: [], updatedAt: null };
  try {
    const parsed = JSON.parse(row.payload);
    return {
      items: Array.isArray(parsed) ? parsed : [],
      updatedAt: row.updatedAt || null
    };
  } catch (err) {
    return { items: [], updatedAt: row.updatedAt || null };
  }
}

function writeCollection(name, items) {
  const payload = JSON.stringify(Array.isArray(items) ? items : []);
  const now = Date.now();
  stmtUpsertCollection.run(name, payload, now);
  return now;
}

const app = express();

app.use(cors());
app.use(express.json({ limit: '4mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'cowebv2-internal-db',
    dbPath: DB_PATH,
    time: Date.now()
  });
});

app.get('/api/state', (_req, res) => {
  const state = stmtGetState.get();
  res.json(state || { stage: 1, heat: 1, ts: null, updatedAt: null });
});

app.put('/api/state', (req, res) => {
  const stage = normalizeLevel(req.body?.stage, 1, 5);
  const heat = normalizeLevel(req.body?.heat, 1, 5);
  if (stage === null || heat === null) {
    res.status(400).json({ error: 'Dados invalidos: stage e heat devem ser inteiros de 1 a 5.' });
    return;
  }

  const ts = typeof req.body?.ts === 'string' ? req.body.ts : null;
  const now = Date.now();
  stmtSetState.run(stage, heat, ts, now);
  res.json({ stage, heat, ts, updatedAt: now });
});

app.get('/api/collections/:name', (req, res) => {
  const name = String(req.params.name || '').trim().toLowerCase();
  if (!COLLECTION_NAMES.has(name)) {
    res.status(400).json({ error: 'Colecao invalida.' });
    return;
  }

  const { items, updatedAt } = readCollection(name);
  res.json({ items, updatedAt });
});

app.put('/api/collections/:name', (req, res) => {
  const name = String(req.params.name || '').trim().toLowerCase();
  if (!COLLECTION_NAMES.has(name)) {
    res.status(400).json({ error: 'Colecao invalida.' });
    return;
  }

  const items = req.body?.items;
  if (!Array.isArray(items)) {
    res.status(400).json({ error: 'Payload invalido: envie { items: [] }.' });
    return;
  }

  const updatedAt = writeCollection(name, items);
  res.json({ ok: true, name, count: items.length, updatedAt });
});

app.use(express.static(ROOT_DIR, { extensions: ['html'] }));

app.listen(PORT, HOST, () => {
  console.log(`[COWEBV2] Servidor interno em http://${HOST}:${PORT}`);
  console.log(`[COWEBV2] Banco SQLite: ${DB_PATH}`);
});
