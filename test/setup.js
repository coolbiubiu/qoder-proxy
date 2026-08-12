// Loaded via `node --test --require ./test/setup.js` before every test file.
// Tests must behave identically regardless of the developer's local .env,
// so clear everything .env could inject before any app module loads it.
const os = require('os');
const path = require('path');

process.env.QODER_PROXY_SKIP_DOTENV = '1';
// Persisted usage stats must land in a throwaway file, never the user's real
// usage.json (usage.js resolves this path at module load, so set it first).
process.env.QODER_PROXY_USAGE_FILE = path.join(
  os.tmpdir(),
  `qoder-proxy-test-usage-${process.pid}.json`
);
// Same isolation for the SQLite request-history database: tests must never
// read or truncate the user's real proxy.db.
process.env.QODER_PROXY_DB_FILE = path.join(
  os.tmpdir(),
  `qoder-proxy-test-db-${process.pid}.db`
);
delete process.env.PROXY_API_KEY;
delete process.env.QODERCN_PERSONAL_ACCESS_TOKEN;
delete process.env.QODER_PAT;
delete process.env.CLI_BACKEND;
delete process.env.CLI_COMMAND;
delete process.env.QODERCN_CLI_PATH;
delete process.env.MAX_CONCURRENT_CLI;
delete process.env.CLI_QUEUE_TIMEOUT_MS;
delete process.env.HISTORY_LIMIT;
delete process.env.SERVER_TOOL_EXECUTION;
delete process.env.ALLOWED_HOSTS;
delete process.env.ALLOWED_ORIGINS;
delete process.env.QODERCN_MODEL;
delete process.env.MAX_INPUT_TOKENS;
delete process.env.RETRY_COUNT;
delete process.env.QODER_MODEL_FALLBACK;
delete process.env.LOG_FILE;
