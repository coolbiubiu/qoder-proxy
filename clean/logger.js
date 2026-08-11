const { redact } = require('./redact');

// LOG_LEVEL controls verbosity: debug < info < warn < error. Default is info,
// which matches the historical behavior of logging everything.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel() {
  const name = String(process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[name] ?? LEVELS.info;
}

function write(message, data) {
  const timestamp = new Date().toISOString();
  if (data === undefined) {
    console.log(`[${timestamp}] ${message}`);
    return;
  }
  console.log(`[${timestamp}] ${message}`, redact(data));
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
