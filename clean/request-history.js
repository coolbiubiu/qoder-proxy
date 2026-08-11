'use strict';

// Recent request outcomes, surfaced by the web console's Recent Requests
// panel. Persisted to a SQLite file (proxy.db in the project root by default)
// so the history survives restarts. On Node versions without node:sqlite the
// store degrades to an in-memory ring buffer — the panel keeps working, it
// just resets with the process.

const path = require('path');

const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_LIMIT = 1000;

// Per-request detail columns recorded alongside the basic outcome. Declared
// once so CREATE TABLE, the legacy-schema migration and the INSERT statement
// can never drift apart.
const DETAIL_COLUMNS = [
  ['stream', 'INTEGER NOT NULL DEFAULT 0'],
  ['tool_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['message_count', 'INTEGER'],
  ['input_tokens', 'INTEGER'],
  ['output_tokens', 'INTEGER'],
  ['tool_call_depth', 'INTEGER'],
  ['reasoning_effort', 'TEXT'],
  ['status', 'INTEGER'],
];

function getHistoryLimit() {
  const value = Number(process.env.HISTORY_LIMIT);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_HISTORY_LIMIT;
  return Math.min(Math.floor(value), MAX_HISTORY_LIMIT);
}

function resolveDbFile() {
  return process.env.QODER_PROXY_DB_FILE || path.join(__dirname, '..', 'proxy.db');
}

function openDb() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(resolveDbFile());
    // WAL tolerates a second process holding the database open (e.g. a dev
    // and a prod instance alive at the same time), and busy_timeout makes
    // writers wait briefly instead of failing with SQLITE_BUSY.
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA busy_timeout=2000');
    const detailSql = DETAIL_COLUMNS.map(([name, type]) => `${name} ${type}`).join(', ');
    db.exec(
      'CREATE TABLE IF NOT EXISTS request_history (' +
        'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
        'ts TEXT NOT NULL, ' +
        'endpoint TEXT NOT NULL, ' +
        'model TEXT, ' +
        'ok INTEGER NOT NULL, ' +
        'ms INTEGER NOT NULL, ' +
        'error TEXT, ' +
        detailSql +
        ')'
    );
    // Databases created before the detail columns existed keep their rows —
    // just add whatever columns are missing.
    const existing = new Set(
      db.prepare('PRAGMA table_info(request_history)').all().map((row) => row.name)
    );
    for (const [name, type] of DETAIL_COLUMNS) {
      if (!existing.has(name)) db.exec(`ALTER TABLE request_history ADD COLUMN ${name} ${type}`);
    }
    return db;
  } catch (_) {
    // node:sqlite unavailable (older Node) or the file is not writable —
    // fall back to the in-memory buffer below.
    return null;
  }
}

const db = openDb();
let insertStmt = null;
let recentStmt = null;
let countStmt = null;
let pruneStmt = null;

// In-memory fallback ring buffer (also used if a DB write ever fails).
const entries = [];
let nextId = 1;

function pruneToLimit(limit) {
  if (!db) return;
  try {
    const { n } = countStmt.get();
    const excess = n - limit;
    if (excess > 0) pruneStmt.run(excess);
  } catch (_) {
    // Pruning is housekeeping only — never let it break request handling.
  }
}

if (db) {
  insertStmt = db.prepare(
    'INSERT INTO request_history ' +
      '(ts, endpoint, model, ok, ms, error, stream, tool_count, message_count, ' +
      'input_tokens, output_tokens, tool_call_depth, reasoning_effort, status) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  recentStmt = db.prepare('SELECT * FROM request_history ORDER BY id DESC LIMIT ?');
  countStmt = db.prepare('SELECT COUNT(*) AS n FROM request_history');
  pruneStmt = db.prepare(
    'DELETE FROM request_history WHERE id IN (SELECT id FROM request_history ORDER BY id ASC LIMIT ?)'
  );
  // Drop rows beyond the current cap (e.g. HISTORY_LIMIT was lowered since
  // the last run).
  pruneToLimit(getHistoryLimit());
}

/**
 * Record one completed request. `entry` should contain at minimum
 * `endpoint`, `model`, `ok` and `ms`; `error` is optional.
 */
function recordRequestEntry(entry) {
  const record = { ts: new Date().toISOString(), ...entry };

  if (insertStmt) {
    try {
      insertStmt.run(
        record.ts,
        record.endpoint,
        record.model ?? null,
        record.ok ? 1 : 0,
        record.ms || 0,
        record.error ?? null,
        record.stream ? 1 : 0,
        record.toolCount || 0,
        record.messageCount ?? null,
        record.inputTokens ?? null,
        record.outputTokens ?? null,
        record.toolCallDepth ?? null,
        record.reasoningEffort ?? null,
        record.status ?? null
      );
      pruneToLimit(getHistoryLimit());
      return;
    } catch (_) {
      // DB write failed — mirror into the memory buffer so the panel still
      // shows something.
    }
  }

  entries.push({ id: nextId++, ...record });
  const limit = getHistoryLimit();
  while (entries.length > limit) entries.shift();
}

/**
 * Return recent entries, newest first. `limit` defaults to the history cap.
 */
function getRecentRequests(limit) {
  const count = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : getHistoryLimit();

  if (recentStmt) {
    try {
      // Normalize to camelCase so API consumers see the same shape whether
      // rows come from SQLite or the in-memory fallback buffer.
      return recentStmt.all(count).map((row) => ({
        id: row.id,
        ts: row.ts,
        endpoint: row.endpoint,
        model: row.model,
        ok: Boolean(row.ok),
        ms: row.ms,
        error: row.error ?? undefined,
        stream: Boolean(row.stream),
        toolCount: row.tool_count,
        messageCount: row.message_count,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        toolCallDepth: row.tool_call_depth,
        reasoningEffort: row.reasoning_effort,
        status: row.status,
      }));
    } catch (_) {
      // Fall back to the memory buffer below.
    }
  }

  return entries.slice(-count).reverse();
}

function resetRequestHistory() {
  if (db) {
    try {
      db.exec('DELETE FROM request_history');
    } catch (_) {
      // Keep going — still clear the memory buffer.
    }
  }
  entries.length = 0;
}

function closeRequestHistoryDb() {
  if (db) {
    try {
      db.close();
    } catch (_) {
      // Already closed — nothing to do.
    }
  }
}

function isHistoryPersisted() {
  return Boolean(db);
}

module.exports = {
  closeRequestHistoryDb,
  getRecentRequests,
  isHistoryPersisted,
  recordRequestEntry,
  resetRequestHistory,
};
