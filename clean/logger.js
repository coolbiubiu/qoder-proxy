const fs = require('fs');
const util = require('util');
const { redact } = require('./redact');

// LOG_LEVEL controls verbosity: debug < info < warn < error. Default is info,
// which matches the historical behavior of logging everything.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel() {
  const name = String(process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[name] ?? LEVELS.info;
}

// Optional file sink: background runs otherwise lose their logs when the
// terminal goes away. Best-effort — a full disk must never break request
// handling. Redaction already happened in write().
function appendToLogFile(line) {
  const file = process.env.LOG_FILE;
  if (!file) return;
  try {
    fs.appendFileSync(file, `${line}\n`, 'utf8');
  } catch (_) {
    // Ignore — console output still works.
  }
}

function write(message, data) {
  const timestamp = new Date().toISOString();
  if (data === undefined) {
    console.log(`[${timestamp}] ${message}`);
    appendToLogFile(`[${timestamp}] ${message}`);
    return;
  }
  const redacted = redact(data);
  console.log(`[${timestamp}] ${message}`, redacted);
  appendToLogFile(
    `[${timestamp}] ${message} ${util.inspect(redacted, { depth: 4, breakLength: Infinity })}`
  );
}

function log(message, data) {
  if (currentLevel() > LEVELS.info) return;
  write(message, data);
}

function debug(message, data) {
  if (currentLevel() > LEVELS.debug) return;
  write(message, data);
}

function warn(message, data) {
  if (currentLevel() > LEVELS.warn) return;
  write(message, data);
}

module.exports = {
  debug,
  log,
  warn,
};
