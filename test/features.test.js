// Coverage for the observability and resilience features: history filters,
// hourly aggregates, active-request cancellation, /metrics, /events SSE,
// input size guard, retries, model fallback and file logging.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const qoderCli = require('../clean/qodercn-cli');
const { createApp } = require('../clean/app');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function upstreamError() {
  const error = new Error('qoderclicn failed. boom');
  error.code = 'upstream_error';
  error.status = 502;
  return error;
}

async function postChat(baseUrl, body) {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], ...body }),
  });
}

async function waitForActive(baseUrl, expected) {
  for (let i = 0; i < 100; i += 1) {
    const { requests } = await (await fetch(`${baseUrl}/usage/active`)).json();
    if (requests.length === expected) return requests;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for active requests');
}

test('/usage/recent supports endpoint, model and ok filters', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  qoderCli.runQoderCnCli = async (options) => {
    if (options.model === 'fail-me') throw upstreamError();
    return 'OK';
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    assert.equal((await postChat(baseUrl, { model: 'filter-model-a' })).status, 200);
    assert.equal((await postChat(baseUrl, { model: 'fail-me' })).status, 502);

    const byModel = await (
      await fetch(`${baseUrl}/usage/recent?model=filter-model-a`)
    ).json();
    assert.ok(byModel.requests.length >= 1);
    assert.ok(byModel.requests.every((r) => r.model === 'filter-model-a'));

    const okOnly = await (await fetch(`${baseUrl}/usage/recent?endpoint=chat&ok=true`)).json();
    assert.ok(okOnly.requests.every((r) => r.endpoint === 'chat' && r.ok === true));

    const failedOnly = await (
      await fetch(`${baseUrl}/usage/recent?model=fail-me&ok=false`)
    ).json();
    assert.ok(failedOnly.requests.length >= 1);
    assert.ok(failedOnly.requests.every((r) => r.ok === false));

    const invalid = await fetch(`${baseUrl}/usage/recent?ok=maybe`);
    assert.equal(invalid.status, 400);
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('/usage/hourly aggregates completed requests', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  qoderCli.runQoderCnCli = async () => 'OK';
  const { server, baseUrl } = await listen(createApp());
  try {
    assert.equal((await postChat(baseUrl, {})).status, 200);

    const { hours } = await (await fetch(`${baseUrl}/usage/hourly?hours=24`)).json();
    assert.ok(Array.isArray(hours));
    assert.ok(hours.length >= 1, 'expected at least one hourly bucket');
    const total = hours.reduce((sum, h) => sum + h.requests, 0);
    assert.ok(total >= 1);
    assert.match(hours[0].hour, /^\d{4}-\d{2}-\d{2}T\d{2}$/);
    assert.equal(typeof hours[0].ok, 'number');
    assert.equal(typeof hours[0].totalMs, 'number');

    const invalid = await fetch(`${baseUrl}/usage/hourly?hours=0`);
    assert.equal(invalid.status, 400);
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('active requests can be listed and cancelled', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  // Hang until the abort signal arrives — exactly the situation a stuck CLI
  // child creates in production.
  qoderCli.runQoderCnCli = (options) =>
    new Promise((_resolve, reject) => {
      const onAbort = () => {
        const error = new Error('cancelled');
        error.code = 'request_cancelled';
        error.status = 499;
        reject(error);
      };
      if (options.signal.aborted) return onAbort();
      options.signal.addEventListener('abort', onAbort, { once: true });
    });
  const { server, baseUrl } = await listen(createApp());
  try {
    const pending = postChat(baseUrl, {});
    const active = await waitForActive(baseUrl, 1);
    assert.equal(active[0].endpoint, 'chat');
    assert.equal(typeof active[0].elapsedMs, 'number');

    const cancelled = await fetch(`${baseUrl}/usage/active/${active[0].id}`, {
      method: 'DELETE',
    });
    assert.equal(cancelled.status, 200);

    const response = await pending;
    assert.equal(response.status, 499);
    await waitForActive(baseUrl, 0);

    const missing = await fetch(`${baseUrl}/usage/active/nope`, { method: 'DELETE' });
    assert.equal(missing.status, 404);
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('/metrics exposes counters, latency histogram and slot gauges', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  qoderCli.runQoderCnCli = async () => 'OK';
  const { server, baseUrl } = await listen(createApp());
  try {
    assert.equal((await postChat(baseUrl, {})).status, 200);

    const response = await fetch(`${baseUrl}/metrics`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/plain/);
    const text = await response.text();
    assert.match(text, /qoder_proxy_requests_total\{endpoint="chat",ok="true"\} \d+/);
    assert.match(text, /qoder_proxy_request_duration_ms_bucket\{endpoint="chat",le="\+Inf"\}/);
    assert.match(text, /qoder_proxy_request_duration_ms_count\{endpoint="chat"\}/);
    assert.match(text, /qoder_proxy_cli_slots_active \d+/);
    assert.match(text, /qoder_proxy_cli_slots_max -?\d+/);
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('/events pushes request_completed for finished requests', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  qoderCli.runQoderCnCli = async () => 'OK';
  const { server, baseUrl } = await listen(createApp());
  const sseController = new AbortController();
  try {
    const sseResponse = await fetch(`${baseUrl}/events`, { signal: sseController.signal });
    assert.equal(sseResponse.status, 200);
    assert.match(sseResponse.headers.get('content-type'), /text\/event-stream/);
    const reader = sseResponse.body.getReader();

    assert.equal((await postChat(baseUrl, {})).status, 200);

    let buffer = '';
    while (!buffer.includes('request_completed')) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += Buffer.from(value).toString('utf8');
    }
    assert.match(buffer, /event: request_completed/);
    assert.match(buffer, /"endpoint":"chat"/);
    assert.match(buffer, /"ok":true/);
  } finally {
    sseController.abort();
    qoderCli.runQoderCnCli = originalRun;
    server.closeAllConnections?.();
    server.close();
  }
});

test('MAX_INPUT_TOKENS rejects oversized prompts with 413', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  let cliCalls = 0;
  qoderCli.runQoderCnCli = async () => {
    cliCalls += 1;
    return 'OK';
  };
  process.env.MAX_INPUT_TOKENS = '1';
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await postChat(baseUrl, {
      messages: [{ role: 'user', content: 'x'.repeat(300) }],
    });
    assert.equal(response.status, 413);
    const body = await response.json();
    assert.equal(body.error.code, 'input_too_large');
    // The guard must fire before any CLI child is spawned.
    assert.equal(cliCalls, 0);

    // Small requests still pass when the cap is generous.
    process.env.MAX_INPUT_TOKENS = '100000';
    assert.equal((await postChat(baseUrl, {})).status, 200);
  } finally {
    delete process.env.MAX_INPUT_TOKENS;
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('RETRY_COUNT retries transient CLI failures', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  let cliCalls = 0;
  qoderCli.runQoderCnCli = async () => {
    cliCalls += 1;
    if (cliCalls < 3) throw upstreamError();
    return 'recovered';
  };
  process.env.RETRY_COUNT = '2';
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await postChat(baseUrl, {});
    assert.equal(response.status, 200);
    assert.equal(cliCalls, 3);

    // Without retries the same flapping CLI fails fast.
    process.env.RETRY_COUNT = '0';
    cliCalls = 0;
    const failed = await postChat(baseUrl, {});
    assert.equal(failed.status, 502);
    assert.equal(cliCalls, 1);
  } finally {
    delete process.env.RETRY_COUNT;
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('QODER_MODEL_FALLBACK switches model after the primary fails', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  const seenModels = [];
  qoderCli.runQoderCnCli = async (options) => {
    seenModels.push(options.model);
    if (options.model === 'failing-model') throw upstreamError();
    return 'fallback answered';
  };
  process.env.QODER_MODEL_FALLBACK = 'failing-model=fallback-model';
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await postChat(baseUrl, { model: 'failing-model' });
    assert.equal(response.status, 200);
    const body = await response.json();
    // The response envelope attributes the answer to the model that ran.
    assert.equal(body.model, 'fallback-model');
    assert.deepEqual(seenModels, ['failing-model', 'fallback-model']);
  } finally {
    delete process.env.QODER_MODEL_FALLBACK;
    qoderCli.runQoderCnCli = originalRun;
    server.close();
  }
});

test('streaming retries apply before the first delta only', async () => {
  const originalStream = qoderCli.runQoderCnCliStream;
  let attempts = 0;
  qoderCli.runQoderCnCliStream = async (options) => {
    attempts += 1;
    if (attempts === 1) throw upstreamError();
    options.onDelta('second attempt ');
    return 'second attempt text';
  };
  process.env.RETRY_COUNT = '1';
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /second attempt/);
    assert.match(text, /data: \[DONE\]/);
    assert.equal(attempts, 2);
  } finally {
    delete process.env.RETRY_COUNT;
    qoderCli.runQoderCnCliStream = originalStream;
    server.close();
  }
});

test('LOG_FILE mirrors log lines into a file', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  qoderCli.runQoderCnCli = async () => 'OK';
  const logFile = path.join(os.tmpdir(), `qoder-proxy-test-log-${process.pid}-${Date.now()}.log`);
  process.env.LOG_FILE = logFile;
  const { server, baseUrl } = await listen(createApp());
  try {
    assert.equal((await postChat(baseUrl, {})).status, 200);
    const content = fs.readFileSync(logFile, 'utf8');
    assert.match(content, /chat request accepted/);
    assert.match(content, /chat request completed/);
  } finally {
    delete process.env.LOG_FILE;
    qoderCli.runQoderCnCli = originalRun;
    server.close();
    fs.rmSync(logFile, { force: true });
  }
});
