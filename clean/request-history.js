'use strict';

// Recent request outcomes, surfaced by the web console's Recent Requests
// panel. Persisted to a SQLite file (proxy.db in the project root by default)
// so the history survives restarts. On Node versions without node:sqlite the
// store degrades to an in-memory ring buffer — the panel keeps working, it
// just resets with the process.

const path = require('path');

const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_LIMIT = 1000;

// Hourly aggregates back the Usage page's trend chart. Kept for a week —
// enough for "last 24h" views with headroom, small enough to never matter.
const HOURLY_RETENTION_HOURS = 24 * 7;

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
    db.exec(
      'CREATE TABLE IF NOT EXISTS usage_hourly ('
        + 'hour TEXT PRIMARY KEY, '
        + 'requests INTEGER NOT NULL DEFAULT 0, '
        + 'ok INTEGER NOT NULL DEFAULT 0, '
        + 'total_ms INTEGER NOT NULL DEFAULT 0)'
    );
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
let hourlyUpsertStmt = null;
let hourlyPruneStmt = null;

// In-memory fallback ring buffer (also used if a DB write ever fails).
const entries = [];
let nextId = 1;
// Hourly aggregates for the memory fallback path.
const hourlyMemory = new Map();

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
  hourlyUpsertStmt = db.prepare(
    'INSERT INTO usage_hourly (hour, requests, ok, total_ms) VALUES (?, 1, ?, ?) '
      + 'ON CONFLICT(hour) DO UPDATE SET requests = requests + 1, '
      + 'ok = ok + excluded.ok, total_ms = total_ms + excluded.total_ms'
  );
  hourlyPruneStmt = db.prepare('DELETE FROM usage_hourly WHERE hour < ?');
  // Drop rows beyond the current cap (e.g. HISTORY_LIMIT was lowered since
  // the last run).
  pruneToLimit(getHistoryLimit());
}

/**
 * Fold one completed request into the hourly aggregate row. `ts` is the ISO
 * timestamp; the hour key is its first 13 characters ("2026-08-12T13"),
 * which sorts lexicographically the same way it sorts chronologically.
 */
function recordHourlyStats(ts, ok, ms) {
  const hour = String(ts).slice(0, 13);
  const cutoff = new Date(Date.now() - HOURLY_RETENTION_HOURS * 3600 * 1000)
    .toISOString()
    .slice(0, 13);

  if (hourlyUpsertStmt) {
    try {
      hourlyUpsertStmt.run(hour, ok ? 1 : 0, ms || 0);
      hourlyPruneStmt.run(cutoff);
      return;
    } catch (_) {
      // Mirror into the memory map below.
    }
  }

  const bucket = hourlyMemory.get(hour) || { hour, requests: 0, ok: 0, totalMs: 0 };
  bucket.requests += 1;
  if (ok) bucket.ok += 1;
  bucket.totalMs += ms || 0;
  hourlyMemory.set(hour, bucket);
  for (const key of hourlyMemory.keys()) {
    if (key < cutoff) hourlyMemory.delete(key);
  }
}

/**
 * Record one completed request. `entry` should contain at minimum
 * `endpoint`, `model`, `ok` and `ms`; `error` is optional.
 */
function recordRequestEntry(entry) {
  const record = { ts: new Date().toISOString(), ...entry };

  recordHourlyStats(record.ts, record.ok, record.ms);

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

// Normalize to camelCase so API consumers see the same shape whether rows
// come from SQLite or the in-memory fallback buffer.
function mapHistoryRow(row) {
  return {
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
  };
}

function matchesFilters(entry, filters) {
  if (filters.endpoint && entry.endpoint !== filters.endpoint) return false;
  if (filters.model && entry.model !== filters.model) return false;
  if (typeof filters.ok === 'boolean' && Boolean(entry.ok) !== filters.ok) return false;
  return true;
}

/**
 * Return recent entries, newest first. `limit` defaults to the history cap.
 * `filters` optionally narrows by endpoint, model and/or ok outcome.
 */
function getRecentRequests(limit, filters = {}) {
  const count = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : getHistoryLimit();
  const hasFilters = Boolean(filters.endpoint || filters.model || typeof filters.ok === 'boolean');

  if (recentStmt) {
    try {
      let rows;
      if (hasFilters) {
        // Filters come from query strings, so always bind them as params —
        // never splice them into the SQL text.
        const clauses = [];
        const params = [];
        if (filters.endpoint) {
          clauses.push('endpoint = ?');
          params.push(filters.endpoint);
        }
        if (filters.model) {
          clauses.push('model = ?');
          params.push(filters.model);
        }
        if (typeof filters.ok === 'boolean') {
          clauses.push('ok = ?');
          params.push(filters.ok ? 1 : 0);
        }
        const stmt = db.prepare(
          `SELECT * FROM request_history WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?`
        );
        rows = stmt.all(...params, count);
      } else {
        rows = recentStmt.all(count);
      }
      return rows.map(mapHistoryRow);
    } catch (_) {
      // Fall back to the memory buffer below.
    }
  }

  const filtered = hasFilters ? entries.filter((entry) => matchesFilters(entry, filters)) : entries;
  return filtered.slice(-count).reverse();
}

/**
 * Hourly aggregates for the trailing `hours` window, oldest first. Only
 * hours that saw at least one request are returned; the caller fills gaps.
 */
function getHourlyStats(hours = 24) {
  const window = Number.isFinite(hours) && hours > 0 ? Math.min(Math.floor(hours), HOURLY_RETENTION_HOURS) : 24;
  const cutoff = new Date(Date.now() - window * 3600 * 1000).toISOString().slice(0, 13);

  if (db) {
    try {
      return db
        .prepare('SELECT * FROM usage_hourly WHERE hour >= ? ORDER BY hour ASC')
        .all(cutoff)
        .map((row) => ({ hour: row.hour, requests: row.requests, ok: row.ok, totalMs: row.total_ms }));
    } catch (_) {
      // Fall back to the memory map below.
    }
  }

  return [...hourlyMemory.values()]
    .filter((bucket) => bucket.hour >= cutoff)
    .sort((a, b) => (a.hour < b.hour ? -1 : 1));
}

function resetRequestHistory() {
  if (db) {
    try {
      db.exec('DELETE FROM request_history');
      db.exec('DELETE FROM usage_hourly');
    } catch (_) {
      // Keep going — still clear the memory buffer.
    }
  }
  entries.length = 0;
  hourlyMemory.clear();
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
  getHourlyStats,
  getRecentRequests,
  isHistoryPersisted,
  recordRequestEntry,
  resetRequestHistory,
};
