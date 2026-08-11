'use strict';

// In-memory ring buffer of recent request outcomes, surfaced by the web
// console so users can see per-request detail (endpoint, model, latency,
// success) instead of only the aggregate usage counters. Deliberately not
// persisted: it is a live debugging aid, not an audit log.

const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_LIMIT = 1000;

function getHistoryLimit() {
  const value = Number(process.env.HISTORY_LIMIT);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_HISTORY_LIMIT;
  return Math.min(Math.floor(value), MAX_HISTORY_LIMIT);
}

const entries = [];
let nextId = 1;

/**
 * Record one completed request. `entry` should contain at minimum
 * `endpoint`, `model`, `ok` and `ms`; `error` is optional.
 */
function recordRequestEntry(entry) {
  entries.push({
    id: nextId++,
    ts: new Date().toISOString(),
    ...entry,
  });
  const limit = getHistoryLimit();
  while (entries.length > limit) entries.shift();
}

/**
 * Return recent entries, newest first. `limit` is capped by the buffer size.
 */
function getRecentRequests(limit) {
  const count = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : entries.length;
  return entries.slice(-count).reverse();
}

function resetRequestHistory() {
  entries.length = 0;
}

module.exports = {
  getRecentRequests,
  recordRequestEntry,
  resetRequestHistory,
};
