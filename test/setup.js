// Loaded via `node --test --require ./test/setup.js` before every test file.
// Tests must behave identically regardless of the developer's local .env,
// so clear everything .env could inject before any app module loads it.
process.env.QODER_PROXY_SKIP_DOTENV = '1';
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
