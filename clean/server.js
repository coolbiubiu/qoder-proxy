const { createApp } = require('./app');
const { log } = require('./logger');
const { isProxyAuthEnabled } = require('./auth');
const { getCliBackend, shutdownCliProcesses } = require('./qodercn-cli');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);

const app = createApp();

const server = app.listen(PORT, HOST, () => {
  const backend = getCliBackend();
  log(`Qoder Proxy listening on http://${HOST}:${PORT}`);
  log('CLI backend', {
    name: backend.name,
    command: backend.command,
    home: backend.homeDir,
    token_configured: Boolean(process.env[backend.tokenEnvVar] || process.env.QODERCN_PERSONAL_ACCESS_TOKEN),
  });
  log('security', {
    proxy_api_key: isProxyAuthEnabled() ? 'enabled' : 'not set',
    cross_origin: 'loopback origins only',
    server_tool_execution: /^(1|true|yes)$/i.test(process.env.SERVER_TOOL_EXECUTION || '')
      ? 'ENABLED'
      : 'off',
  });
  if (!isProxyAuthEnabled()) {
    log(
      'note: PROXY_API_KEY is not set, so any process on this machine can use the proxy. ' +
        'Set it in .env to require a key.'
    );
  }
});

// Graceful shutdown: stop accepting new connections, terminate in-flight CLI
// child processes so they are not left orphaned, then exit. A hard deadline
// forces exit if a connection refuses to drain.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[server] ${signal} received, shutting down gracefully`);
  shutdownCliProcesses();
  server.close(() => {
    log('[server] HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
