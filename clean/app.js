const path = require('path');
const dotenv = require('dotenv');

// Prefer .env in the working directory; fall back to the project root next
// to clean/ so running the bundle from elsewhere still finds the config.
// QODER_PROXY_SKIP_DOTENV lets tests opt out of local .env entirely.
if (!/^(1|true|yes)$/i.test(process.env.QODER_PROXY_SKIP_DOTENV || '')) {
  const loaded = dotenv.config();
  if (loaded.error) {
    dotenv.config({ path: path.join(__dirname, '..', '.env') });
  }
}

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { anthropicError, openAiError, AppError } = require('./errors');
const { apiKeyGuard, isAllowedOrigin, localOnlyGuard } = require('./auth');
const { log } = require('./logger');
const qoderCli = require('./qodercn-cli');
const { DEFAULT_MODEL_ID, MODELS } = require('./models');
const {
  anthropicToOpenAiMessages,
  createAnthropicMessage,
  estimateAnthropicInputTokens,
  validateAnthropicMessagesRequest,
  writeAnthropicMessageStream,
  writeAnthropicSse,
} = require('./anthropic');
const {
  parseToolCallOutput,
  generateCallId,
  normalizeOpenAiTools,
  normalizeAnthropicTools,
  formatToolResultForPrompt,
} = require('./tool-parser');
const { trackRequest, getUsage, resetUsage, saveUsage, estimateTokens, extractTextFromMessages } = require('./usage');
const { executeToolCall } = require('./tools-executor');
const { recordRequestEntry, getRecentRequests, getHourlyStats, resetRequestHistory } = require('./request-history');
const { getCliSlotStatus } = require('./concurrency');

const MODEL_ID = DEFAULT_MODEL_ID;

// Server-side tool execution is opt-in. Agent clients (OpenCode, Trae, Cline…)
// declare tools they execute themselves in the user's workspace, so the proxy
// must return tool_calls to the client instead of running them locally.
function isServerToolExecutionEnabled() {
  return /^(1|true|yes)$/i.test(process.env.SERVER_TOOL_EXECUTION || '');
}

const MAX_TOOL_CALL_DEPTH = 10;

// Clients can cap a single request's CLI runtime via the x-qoder-timeout
// header (seconds); it may not exceed this ceiling so a rogue client cannot
// pin a CLI slot forever.
const MAX_TIMEOUT_OVERRIDE_SECONDS = 600;

function parseTimeoutOverrideHeader(req) {
  const raw = req.headers['x-qoder-timeout'];
  if (raw === undefined || raw === '') return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new AppError(400, 'invalid_timeout', 'x-qoder-timeout must be a positive number of seconds.');
  }
  return Math.min(seconds, MAX_TIMEOUT_OVERRIDE_SECONDS) * 1000;
}

// Mirror aggregate usage tracking with a per-request history entry for the
// web console's Recent Requests panel. `details` carries optional request
// shape fields: stream, toolCount, messageCount, inputTokens, outputTokens,
// toolCallDepth, reasoningEffort, status.
function recordOutcome({ endpoint, model, isError, started, errorCode, ...details }) {
  const ms = Date.now() - started;
  recordRequestEntry({
    endpoint,
    model,
    ok: !isError,
    ms,
    error: isError ? errorCode || 'internal_error' : undefined,
    ...details,
  });
  recordMetrics(endpoint, !isError, ms);
  // Live feed for the web console — same summary fields as the history row.
  broadcastRequestEvent({
    ts: new Date().toISOString(),
    endpoint,
    model,
    ok: !isError,
    ms,
    error: isError ? errorCode || 'internal_error' : undefined,
    stream: Boolean(details.stream),
  });
}

// Reject oversized prompts before they spend a CLI slot. 0 disables the cap.
function getMaxInputTokens() {
  const value = Number(process.env.MAX_INPUT_TOKENS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

// Automatic retries for transient CLI failures. Capped so a flapping CLI
// cannot queue the same doomed request behind itself forever.
const MAX_RETRY_COUNT = 3;

function getRetryCount() {
  const value = Number(process.env.RETRY_COUNT);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), MAX_RETRY_COUNT);
}

// QODER_MODEL_FALLBACK maps a failing model to a stand-in, e.g.
// "model-a=model-b,model-c=model-d". Unset/empty disables the fallback.
function getModelFallback(model) {
  const raw = process.env.QODER_MODEL_FALLBACK || '';
  if (!raw || !model) return null;
  for (const pair of raw.split(',')) {
    const [from, to] = pair.split('=').map((part) => (part || '').trim());
    if (from && to && from === model) return to;
  }
  return null;
}

// Upstream failures worth retrying: CLI crashes, timeouts, spawn errors.
// Client cancellations (499) and request-shape errors (4xx) never are.
function isRetriableError(error) {
  if (!error || error.code === 'request_cancelled') return false;
  return typeof error.status === 'number' && error.status >= 500;
}

async function runCliWithRetries(runCli, options) {
  const retries = getRetryCount();
  let attempt = 0;
  for (;;) {
    try {
      return await runCli(options);
    } catch (error) {
      if (attempt >= retries || !isRetriableError(error)) throw error;
      attempt += 1;
      log('cli call failed, retrying', { attempt, retries, code: error.code, message: error.message });
    }
  }
}

// Tool-loop wrapper: after per-call retries are exhausted, give the mapped
// fallback model one full-loop chance before surfacing the failure. The
// result carries the model that actually produced it, for stats and history.
async function runToolLoopWithResilience(params) {
  try {
    const result = await runCliWithToolLoop(params);
    return { ...result, model: params.model };
  } catch (error) {
    const fallback = getModelFallback(params.model);
    if (!fallback || fallback === params.model || !isRetriableError(error)) throw error;
    log('tool loop switching to fallback model', { from: params.model, to: fallback, code: error.code });
    const result = await runCliWithToolLoop({ ...params, model: fallback });
    return { ...result, model: fallback };
  }
}

// Streaming wrapper: retries and fallback are only safe while no delta has
// reached the client — once bytes are on the wire, the caller's SSE error
// path is the only sensible recovery.
async function runCliStreamWithResilience({ runStream, canRetry, model, logPrefix }) {
  const retries = getRetryCount();
  let attempt = 0;
  let currentModel = model;
  let triedFallback = false;
  for (;;) {
    try {
      const text = await runStream(currentModel);
      return { text, model: currentModel };
    } catch (error) {
      if (!isRetriableError(error) || !canRetry()) throw error;
      if (attempt < retries) {
        attempt += 1;
        log(`${logPrefix} stream attempt failed, retrying`, { attempt, retries, code: error.code });
        continue;
      }
      if (!triedFallback) {
        const fallback = getModelFallback(currentModel);
        if (fallback && fallback !== currentModel) {
          triedFallback = true;
          attempt = 0;
          log(`${logPrefix} stream switching to fallback model`, { from: currentModel, to: fallback });
          currentModel = fallback;
          continue;
        }
      }
      throw error;
    }
  }
}

// --- Prometheus metrics -------------------------------------------------------

const LATENCY_BUCKETS_MS = [1000, 5000, 15000, 60000, 300000];
const metricsCounters = new Map(); // `${endpoint}|${ok ? 1 : 0}` -> count
const metricsLatency = new Map(); // endpoint -> { count, sumMs, buckets }

function recordMetrics(endpoint, ok, ms) {
  const key = `${endpoint}|${ok ? 1 : 0}`;
  metricsCounters.set(key, (metricsCounters.get(key) || 0) + 1);
  let latency = metricsLatency.get(endpoint);
  if (!latency) {
    latency = { count: 0, sumMs: 0, buckets: LATENCY_BUCKETS_MS.map(() => 0) };
    metricsLatency.set(endpoint, latency);
  }
  latency.count += 1;
  latency.sumMs += ms;
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i += 1) {
    if (ms <= LATENCY_BUCKETS_MS[i]) latency.buckets[i] += 1;
  }
}

function renderMetrics() {
  const lines = [
    '# HELP qoder_proxy_requests_total Completed requests by endpoint and outcome.',
    '# TYPE qoder_proxy_requests_total counter',
  ];
  for (const [key, count] of metricsCounters) {
    const [endpoint, ok] = key.split('|');
    lines.push(`qoder_proxy_requests_total{endpoint="${endpoint}",ok="${ok === '1'}"} ${count}`);
  }
  lines.push(
    '# HELP qoder_proxy_request_duration_ms Request latency in milliseconds.',
    '# TYPE qoder_proxy_request_duration_ms histogram'
  );
  for (const [endpoint, latency] of metricsLatency) {
    let cumulative = 0;
    for (let i = 0; i < LATENCY_BUCKETS_MS.length; i += 1) {
      cumulative += latency.buckets[i];
      lines.push(
        `qoder_proxy_request_duration_ms_bucket{endpoint="${endpoint}",le="${LATENCY_BUCKETS_MS[i]}"} ${cumulative}`
      );
    }
    lines.push(`qoder_proxy_request_duration_ms_bucket{endpoint="${endpoint}",le="+Inf"} ${latency.count}`);
    lines.push(`qoder_proxy_request_duration_ms_sum{endpoint="${endpoint}"} ${latency.sumMs}`);
    lines.push(`qoder_proxy_request_duration_ms_count{endpoint="${endpoint}"} ${latency.count}`);
  }
  const slots = getCliSlotStatus();
  lines.push(
    '# HELP qoder_proxy_cli_slots_active CLI child processes currently running.',
    '# TYPE qoder_proxy_cli_slots_active gauge',
    `qoder_proxy_cli_slots_active ${slots.active}`,
    '# HELP qoder_proxy_cli_slots_queued Requests waiting for a CLI slot.',
    '# TYPE qoder_proxy_cli_slots_queued gauge',
    `qoder_proxy_cli_slots_queued ${slots.queued}`,
    '# HELP qoder_proxy_cli_slots_max Configured slot cap (-1 = unlimited).',
    '# TYPE qoder_proxy_cli_slots_max gauge',
    `qoder_proxy_cli_slots_max ${Number.isFinite(slots.maxConcurrency) ? slots.maxConcurrency : -1}`
  );
  return lines.join('\n') + '\n';
}

// --- Active request tracking + live event stream ------------------------------

// In-flight requests, keyed by id, so the console can list and cancel them.
const activeRequests = new Map();

function registerActiveRequest({ endpoint, model, controller }) {
  const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : makeCompletionId('req_');
  activeRequests.set(id, {
    id,
    endpoint,
    model,
    started: Date.now(),
    abort: () => controller.abort(),
  });
  return id;
}

// EventSource clients subscribed to /events.
const eventClients = new Set();

function broadcastRequestEvent(entry) {
  if (eventClients.size === 0) return;
  const payload = `event: request_completed\ndata: ${JSON.stringify(entry)}\n\n`;
  for (const client of eventClients) {
    try {
      client.write(payload);
    } catch (_) {
      eventClients.delete(client);
    }
  }
}

// Millisecond timestamps collide under concurrency, so add randomness to keep
// completion/message IDs unique.
function makeCompletionId(prefix = 'chatcmpl-') {
  return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
}

// Node 17 removed the request 'aborted' event; the response 'close' event
// fires on every disconnect, so treat it as a cancellation only when we
// haven't finished writing yet. Without this, a client that hangs up leaves
// the CLI child running until its timeout while holding a slot.
function abortOnDisconnect(req, res, controller) {
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
}

/**
 * Run the CLI and, when server-side tool execution is enabled, loop tool
 * results back in until the model stops calling tools. Shared by the OpenAI
 * and Anthropic endpoints — both follow the identical protocol here.
 */
async function runCliWithToolLoop({
  runCli,
  messages,
  model,
  tools,
  requestOptions,
  maxOutputTokens,
  timeoutOverride,
  signal,
  logPrefix,
}) {
  let workingMessages = [...messages];
  let finalContent = '';
  let finalParsedOutput = null;
  let depth = 0;

  while (depth < MAX_TOOL_CALL_DEPTH) {
    const content = await runCli({
      messages: workingMessages,
      model,
      tools,
      reasoningEffort: requestOptions.reasoningEffort,
      contextWindow: requestOptions.contextWindow,
      maxOutputTokens,
      timeoutOverride,
      signal,
    });

    finalContent = content;

    // Parse the output for tool calls if tools were provided
    let parsedOutput = null;
    if (tools) {
      parsedOutput = parseToolCallOutput(content);
      if (parsedOutput && parsedOutput.type === 'tool_calls') {
        log(`${logPrefix} tool calls detected`, {
          tool_count: parsedOutput.toolCalls.length,
          tools: parsedOutput.toolCalls.map((t) => t.name),
        });
      } else {
        log(`${logPrefix} no tool calls detected`, { response_type: parsedOutput?.type || 'text' });
      }
    }

    finalParsedOutput = parsedOutput;

    // If no tool calls, we're done
    if (!parsedOutput || parsedOutput.type !== 'tool_calls') {
      break;
    }

    // Default: hand tool_calls back to the client, which executes tools
    // in its own workspace. Server-side execution only when opted in.
    if (!isServerToolExecutionEnabled()) {
      break;
    }

    // Execute tool calls and build tool result messages
    const toolResults = [];
    const assistantToolCalls = [];

    for (const toolCall of parsedOutput.toolCalls) {
      const callId = generateCallId('call_');
      assistantToolCalls.push({
        id: callId,
        type: 'function',
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments || {}),
        },
      });

      log(`executing ${logPrefix} tool`, { name: toolCall.name, arguments: toolCall.arguments });
      const result = await executeToolCall(toolCall);
      log(`${logPrefix} tool result`, { name: toolCall.name, result });

      toolResults.push({
        role: 'tool',
        tool_call_id: callId,
        content: JSON.stringify(result),
      });
    }

    // Add assistant message with tool_calls, then the tool results
    workingMessages.push({
      role: 'assistant',
      content: parsedOutput.prefixText || null,
      tool_calls: assistantToolCalls,
    });
    workingMessages.push(...toolResults);

    depth++;
  }

  if (depth >= MAX_TOOL_CALL_DEPTH) {
    log(`warning: max ${logPrefix} tool call depth reached`, { depth: MAX_TOOL_CALL_DEPTH });
  }

  return { content: finalContent, parsedOutput: finalParsedOutput, toolCallDepth: depth };
}

function validateChatRequest(body) {
  if (!body || typeof body !== 'object') {
    throw new AppError(400, 'invalid_request', 'Request body must be a JSON object.');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new AppError(400, 'invalid_messages', 'messages must be a non-empty array.');
  }
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') {
      throw new AppError(400, 'invalid_messages', 'Each message must be an object.');
    }
    // Allow system, developer, user, assistant, and tool roles for multi-turn tool use
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) {
      throw new AppError(400, 'unsupported_role', `Unsupported message role: ${message.role}`);
    }
  }
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function extractProviderOption(body, key) {
  return firstDefined(
    body.providerOptions?.['qoder-cn-local']?.[key],
    body.providerOptions?.qoder?.[key],
    body.providerOptions?.openai?.[key],
    body.provider_options?.['qoder-cn-local']?.[key],
    body.provider_options?.qoder?.[key],
    body.provider_options?.openai?.[key],
    body.options?.[key],
    body.modelOptions?.[key],
    body.model_options?.[key]
  );
}

function extractRequestOptions(body) {
  return {
    reasoningEffort: firstDefined(
      body.reasoningEffort,
      body.reasoning_effort,
      body.reasoning?.effort,
      body.reasoning?.reasoningEffort,
      body.reasoning?.reasoning_effort,
      extractProviderOption(body, 'reasoningEffort'),
      extractProviderOption(body, 'reasoning_effort')
    ),
    contextWindow: firstDefined(
      body.contextWindow,
      body.context_window,
      extractProviderOption(body, 'contextWindow'),
      extractProviderOption(body, 'context_window')
    ),
    maxOutputTokens: firstDefined(
      body.maxOutputTokens,
      body.max_output_tokens,
      body.max_tokens,
      extractProviderOption(body, 'maxOutputTokens'),
      extractProviderOption(body, 'max_output_tokens'),
      extractProviderOption(body, 'max_tokens')
    ),
  };
}

function createChatCompletion({ model, content, parsedOutput, inputTokens = 0 }) {
  // If the CLI output was parsed as tool calls, return OpenAI tool_calls format
  if (parsedOutput && parsedOutput.type === 'tool_calls') {
    const completionTokens = estimateTokens(
      (parsedOutput.prefixText || '') + JSON.stringify(parsedOutput.toolCalls)
    );
    return {
      id: makeCompletionId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: parsedOutput.prefixText || null,
            tool_calls: parsedOutput.toolCalls.map((call) => ({
              id: generateCallId('call_'),
              type: 'function',
              function: {
                name: call.name,
                // OpenAI spec: arguments is a JSON string, not a parsed object
                arguments: JSON.stringify(call.arguments),
              },
            })),
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: completionTokens,
        total_tokens: inputTokens + completionTokens,
      },
    };
  }

  // Regular text response
  const completionTokens = estimateTokens(content);
  return {
    id: makeCompletionId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: completionTokens,
      total_tokens: inputTokens + completionTokens,
    },
  };
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeChatCompletionStream(res, { model, content, parsedOutput }) {
  const id = makeCompletionId();
  const created = Math.floor(Date.now() / 1000);
  const isToolCalls = parsedOutput && parsedOutput.type === 'tool_calls';

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  writeSse(res, {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant' },
        finish_reason: null,
      },
    ],
  });

  if (isToolCalls) {
    if (parsedOutput.prefixText) {
      writeSse(res, {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { content: parsedOutput.prefixText },
            finish_reason: null,
          },
        ],
      });
    }
    writeSse(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: parsedOutput.toolCalls.map((call, index) => ({
              index,
              id: generateCallId('call_'),
              type: 'function',
              function: {
                name: call.name,
                // OpenAI spec: arguments is a JSON string, not a parsed object
                arguments: JSON.stringify(call.arguments || {}),
              },
            })),
          },
          finish_reason: null,
        },
      ],
    });
  } else if (content) {
    writeSse(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { content },
          finish_reason: null,
        },
      ],
    });
  }

  writeSse(res, {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: isToolCalls ? 'tool_calls' : 'stop',
      },
    ],
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // Reject foreign Hosts and cross-origin browser requests before anything
  // else, so a disallowed origin cannot even complete a CORS preflight.
  app.use(localOnlyGuard);
  app.use(
    cors({
      origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
      credentials: false,
    })
  );
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    const slots = getCliSlotStatus();
    res.json({
      ok: true,
      uptime: Math.floor(process.uptime()),
      backend: qoderCli.getCliBackend().name,
      slots: {
        active: slots.active,
        queued: slots.queued,
        max: Number.isFinite(slots.maxConcurrency) ? slots.maxConcurrency : null,
      },
    });
  });

  // Prometheus scrape endpoint. Same exposure as /health — counts and
  // latencies only, never request content.
  app.get('/metrics', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(renderMetrics());
  });

  app.get('/', (_req, res) => {
    const backend = qoderCli.getCliBackend();
    // Deliberately no filesystem paths here: this route is reachable by the
    // local web console, and cli_home leaks the OS username. The paths are
    // printed to the server's own startup log instead.
    res.json({
      ok: true,
      name: 'qoder-proxy',
      mode: 'clean',
      cli_backend: backend.name,
    });
  });

  // Live request-completion events for the web console. EventSource cannot
  // send auth headers, so this sits outside apiKeyGuard like /ui — it
  // exposes the same summary data the console already shows, and
  // localOnlyGuard still applies.
  app.get('/events', (req, res) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write('retry: 3000\n\n');
    eventClients.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (_) {
        // Connection gone — the close handler below cleans up.
      }
    }, 30000);
    req.on('close', () => {
      clearInterval(heartbeat);
      eventClients.delete(res);
    });
  });

  // Everything that can spend the user's Qoder quota or read local state sits
  // behind PROXY_API_KEY (a no-op until the user sets one).
  app.use(['/v1', '/v1/v1'], apiKeyGuard);
  app.use('/usage', apiKeyGuard);

  app.get(['/v1/models', '/models', '/v1/v1/models'], (_req, res) => {
    res.json({
      object: 'list',
      data: MODELS.map((model) => ({
        id: model.id,
        object: 'model',
        created: 0,
        owned_by: 'qodercn',
        name: model.name,
        capabilities: {
          reasoning: model.reasoning || false,
        },
        ...(model.effortAlias ? { effort_alias: true } : {}),
      })),
    });
  });

  app.post(['/v1/chat/completions', '/chat/completions', '/v1/v1/chat/completions'], async (req, res) => {
    const started = Date.now();
    const controller = new AbortController();
    abortOnDisconnect(req, res, controller);
    let activeId;

    try {
      validateChatRequest(req.body);
      const model = req.body.model || MODEL_ID;
      const requestOptions = extractRequestOptions(req.body);
      const timeoutOverride = parseTimeoutOverrideHeader(req);
      const tools = Array.isArray(req.body.tools) ? req.body.tools : null;
      const normalizedTools = tools ? normalizeOpenAiTools(tools) : null;
      // Extract the input text once — usage tracking and the history row
      // both need it, and re-joining every message at each call site wastes
      // cycles on large conversations.
      const inputText = extractTextFromMessages(req.body.messages);
      // Request-shape details recorded in the per-request history row.
      const requestDetails = {
        messageCount: req.body.messages.length,
        toolCount: normalizedTools ? normalizedTools.length : 0,
        inputTokens: estimateTokens(inputText),
        reasoningEffort: requestOptions.reasoningEffort,
      };
      // Reject oversized prompts before they spend a CLI slot on them.
      const maxInputTokens = getMaxInputTokens();
      if (maxInputTokens > 0 && requestDetails.inputTokens > maxInputTokens) {
        throw new AppError(
          413,
          'input_too_large',
          `Estimated input (${requestDetails.inputTokens} tokens) exceeds MAX_INPUT_TOKENS (${maxInputTokens}).`
        );
      }
      activeId = registerActiveRequest({ endpoint: 'chat', model, controller });
      log('chat request accepted', {
        model,
        message_count: req.body.messages.length,
        stream: Boolean(req.body.stream),
        tool_count: normalizedTools ? normalizedTools.length : 0,
        reasoning_effort: requestOptions.reasoningEffort,
      });

      // True streaming: stream-json mode, real-time SSE forwarding.
      // Only when no tools are declared — with tools the model may emit a
      // tool-call JSON block that must be parsed and returned as structured
      // tool_calls, so those requests go through the buffered path below.
      if (req.body.stream && !normalizedTools) {
        const id = makeCompletionId();
        const created = Math.floor(Date.now() / 1000);

        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        // Send role chunk first
        writeSse(res, {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        });

        let chatStreamText = '';
        let streamModelUsed = model;
        let deltaSent = false;
        try {
          // Retries and model fallback only apply before the first delta
          // leaves — after that the SSE error path is the only recovery.
          const streamed = await runCliStreamWithResilience({
            model,
            canRetry: () => !deltaSent,
            logPrefix: 'chat',
            runStream: (streamModel) =>
              qoderCli.runQoderCnCliStream({
                messages: req.body.messages,
                model: streamModel,
                tools: normalizedTools,
                reasoningEffort: requestOptions.reasoningEffort,
                contextWindow: requestOptions.contextWindow,
                maxOutputTokens: requestOptions.maxOutputTokens,
                timeoutOverride,
                signal: controller.signal,
                onDelta: (delta) => {
                  deltaSent = true;
                  writeSse(res, {
                    id,
                    object: 'chat.completion.chunk',
                    created,
                    model,
                    choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
                  });
                },
              }),
          });
          chatStreamText = streamed.text;
          streamModelUsed = streamed.model;
        } catch (streamError) {
          log('chat stream failed', {
            code: streamError.code || 'internal_error',
            status: streamError.status || 500,
            duration_ms: Date.now() - started,
            message: streamError.message,
          });
          trackRequest({
            model,
            inputText,
            outputText: '',
            isError: true,
          });
          recordOutcome({
            endpoint: 'chat',
            model,
            isError: true,
            started,
            errorCode: streamError.code,
            stream: true,
            status: streamError.status,
            ...requestDetails,
          });
          // Headers are already sent — surface the error as an SSE event so
          // clients render a failure instead of a silent empty message.
          if (!res.writableEnded) {
            try {
              writeSse(res, {
                error: {
                  message: streamError.message || 'Upstream request failed.',
                  type: 'server_error',
                  code: streamError.code || 'internal_error',
                },
              });
              res.write('data: [DONE]\n\n');
              res.end();
            } catch (_) { /* ignore */ }
          }
          return;
        }

        writeSse(res, {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        });
        res.write('data: [DONE]\n\n');
        res.end();
        log('chat stream completed', { duration_ms: Date.now() - started });
        trackRequest({
          model: streamModelUsed,
          inputText,
          outputText: chatStreamText || '',
          isError: false,
        });
        recordOutcome({
          endpoint: 'chat',
          model: streamModelUsed,
          isError: false,
          started,
          stream: true,
          status: 200,
          outputTokens: estimateTokens(chatStreamText || ''),
          ...requestDetails,
        });
        return;
      }

      // Non-streaming path (or tool calls with stream=true → downgraded)
      const loopResult = await runToolLoopWithResilience({
        runCli: (options) => runCliWithRetries((opts) => qoderCli.runQoderCnCli(opts), options),
        messages: req.body.messages,
        model,
        tools: normalizedTools,
        requestOptions,
        maxOutputTokens: requestOptions.maxOutputTokens,
        timeoutOverride,
        signal: controller.signal,
        logPrefix: 'chat',
      });
      const { content: finalContent, parsedOutput: finalParsedOutput, toolCallDepth } = loopResult;
      // The fallback model may have produced this answer — attribute stats,
      // history and the response envelope to whichever model actually ran.
      const effectiveModel = loopResult.model;

      if (req.body.stream) {
        // Buffered request (tools declared) — emit the parsed result as a
        // proper SSE stream, including delta.tool_calls when applicable.
        writeChatCompletionStream(res, { model: effectiveModel, content: finalContent, parsedOutput: finalParsedOutput });
      } else {
        res.json(createChatCompletion({
          model: effectiveModel,
          content: finalContent,
          parsedOutput: finalParsedOutput,
          inputTokens: requestDetails.inputTokens,
        }));
      }
      log('chat request completed', { duration_ms: Date.now() - started, tool_call_depth: toolCallDepth });
      trackRequest({
        model: effectiveModel,
        inputText,
        outputText: finalContent || '',
        isError: false,
      });
      recordOutcome({
        endpoint: 'chat',
        model: effectiveModel,
        isError: false,
        started,
        stream: Boolean(req.body.stream),
        status: 200,
        outputTokens: estimateTokens(finalContent || ''),
        toolCallDepth,
        ...requestDetails,
      });
    } catch (error) {
      log('chat request failed', {
        code: error.code || 'internal_error',
        status: error.status || 500,
        duration_ms: Date.now() - started,
        message: error.message,
      });
      trackRequest({
        model: req.body?.model || MODEL_ID,
        inputText: extractTextFromMessages(req.body?.messages),
        outputText: '',
        isError: true,
      });
      recordOutcome({
        endpoint: 'chat',
        model: req.body?.model || MODEL_ID,
        isError: true,
        started,
        errorCode: error.code,
        status: error.status,
        messageCount: req.body?.messages?.length ?? null,
      });
      if (!res.headersSent && !res.writableEnded) openAiError(res, error);
    } finally {
      if (activeId) activeRequests.delete(activeId);
    }
  });

  app.post(['/v1/messages', '/messages', '/v1/v1/messages'], async (req, res) => {
    const started = Date.now();
    const controller = new AbortController();
    abortOnDisconnect(req, res, controller);
    let activeId;

    try {
      validateAnthropicMessagesRequest(req.body);
      const model = req.body.model || MODEL_ID;
      const requestOptions = extractRequestOptions(req.body);
      const timeoutOverride = parseTimeoutOverrideHeader(req);
      const { messages, tools } = anthropicToOpenAiMessages(req.body);
      // Same as the chat handler: extract once, reuse everywhere.
      const inputText = extractTextFromMessages(req.body.messages);
      // Request-shape details recorded in the per-request history row.
      const requestDetails = {
        messageCount: req.body.messages.length,
        toolCount: Array.isArray(tools) ? tools.length : 0,
        inputTokens: estimateTokens(inputText),
        reasoningEffort: requestOptions.reasoningEffort,
      };
      // Reject oversized prompts before they spend a CLI slot on them.
      const maxInputTokens = getMaxInputTokens();
      if (maxInputTokens > 0 && requestDetails.inputTokens > maxInputTokens) {
        throw new AppError(
          413,
          'input_too_large',
          `Estimated input (${requestDetails.inputTokens} tokens) exceeds MAX_INPUT_TOKENS (${maxInputTokens}).`
        );
      }
      activeId = registerActiveRequest({ endpoint: 'anthropic', model, controller });
      log('anthropic message request accepted', {
        model,
        message_count: req.body.messages.length,
        stream: Boolean(req.body.stream),
        tool_count: Array.isArray(req.body.tools) ? req.body.tools.length : 0,
        reasoning_effort: requestOptions.reasoningEffort,
      });

      // True streaming: stream-json mode, real-time SSE forwarding.
      // Only when no tools are declared — with tools the model may emit a
      // tool-call JSON block that must be parsed and returned as structured
      // tool_use blocks, so those requests go through the buffered path below.
      if (req.body.stream && !(tools && tools.length)) {
        const msgId = makeCompletionId('msg_');

        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        writeAnthropicSse(res, 'message_start', {
          type: 'message_start',
          message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
        writeAnthropicSse(res, 'content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        });

        let anthropicStreamText = '';
        let streamModelUsed = model;
        let deltaSent = false;
        try {
          // Retries and model fallback only apply before the first delta
          // leaves — after that the SSE error path is the only recovery.
          const streamed = await runCliStreamWithResilience({
            model,
            canRetry: () => !deltaSent,
            logPrefix: 'anthropic',
            runStream: (streamModel) =>
              qoderCli.runQoderCnCliStream({
                messages,
                model: streamModel,
                tools,
                reasoningEffort: requestOptions.reasoningEffort,
                contextWindow: requestOptions.contextWindow,
                maxOutputTokens: requestOptions.maxOutputTokens || req.body.max_tokens,
                timeoutOverride,
                signal: controller.signal,
                onDelta: (delta) => {
                  deltaSent = true;
                  writeAnthropicSse(res, 'content_block_delta', {
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'text_delta', text: delta },
                  });
                },
              }),
          });
          anthropicStreamText = streamed.text;
          streamModelUsed = streamed.model;
        } catch (streamError) {
          log('anthropic stream failed', {
            code: streamError.code || 'internal_error',
            status: streamError.status || 500,
            duration_ms: Date.now() - started,
            message: streamError.message,
          });
          trackRequest({
            model,
            inputText,
            outputText: '',
            isError: true,
          });
          recordOutcome({
            endpoint: 'anthropic',
            model,
            isError: true,
            started,
            errorCode: streamError.code,
            stream: true,
            status: streamError.status,
            ...requestDetails,
          });
          // Headers are already sent — surface the error as an SSE error
          // event so clients render a failure instead of an empty message.
          if (!res.writableEnded) {
            try {
              writeAnthropicSse(res, 'error', {
                type: 'error',
                error: {
                  type: 'api_error',
                  message: streamError.message || 'Upstream request failed.',
                },
              });
              res.end();
            } catch (_) { /* ignore */ }
          }
          return;
        }

        writeAnthropicSse(res, 'content_block_stop', {
          type: 'content_block_stop',
          index: 0,
        });
        writeAnthropicSse(res, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 0 },
        });
        writeAnthropicSse(res, 'message_stop', { type: 'message_stop' });
        res.end();
        log('anthropic stream completed', { duration_ms: Date.now() - started });
        trackRequest({
          model: streamModelUsed,
          inputText,
          outputText: anthropicStreamText || '',
          isError: false,
        });
        recordOutcome({
          endpoint: 'anthropic',
          model: streamModelUsed,
          isError: false,
          started,
          stream: true,
          status: 200,
          outputTokens: estimateTokens(anthropicStreamText || ''),
          ...requestDetails,
        });
        return;
      }

      // Non-streaming path (or tool calls with stream=true → downgraded)
      const anthropicLoopResult = await runToolLoopWithResilience({
        runCli: (options) => runCliWithRetries((opts) => qoderCli.runQoderCnCli(opts), options),
        messages,
        model,
        tools,
        requestOptions,
        maxOutputTokens: requestOptions.maxOutputTokens || req.body.max_tokens,
        timeoutOverride,
        signal: controller.signal,
        logPrefix: 'anthropic',
      });
      const { content: anthropicContent, parsedOutput: anthropicParsedOutput, toolCallDepth: anthropicToolDepth } =
        anthropicLoopResult;
      // Attribute the response to whichever model actually produced it (the
      // fallback may have stepped in).
      const effectiveModel = anthropicLoopResult.model;

      if (req.body.stream) {
        // Buffered request (tools declared) — emit the parsed result as a
        // proper SSE stream, including tool_use blocks when applicable.
        writeAnthropicMessageStream(res, { model: effectiveModel, content: anthropicContent, parsedOutput: anthropicParsedOutput });
      } else {
        res.json(createAnthropicMessage({
          model: effectiveModel,
          content: anthropicContent,
          parsedOutput: anthropicParsedOutput,
          inputTokens: requestDetails.inputTokens,
        }));
      }
      log('anthropic message request completed', { duration_ms: Date.now() - started, tool_call_depth: anthropicToolDepth });
      trackRequest({
        model: effectiveModel,
        inputText,
        outputText: anthropicContent || '',
        isError: false,
      });
      recordOutcome({
        endpoint: 'anthropic',
        model: effectiveModel,
        isError: false,
        started,
        stream: Boolean(req.body.stream),
        status: 200,
        outputTokens: estimateTokens(anthropicContent || ''),
        toolCallDepth: anthropicToolDepth,
        ...requestDetails,
      });
    } catch (error) {
      log('anthropic message request failed', {
        code: error.code || 'internal_error',
        status: error.status || 500,
        duration_ms: Date.now() - started,
        message: error.message,
      });
      trackRequest({
        model: req.body?.model || MODEL_ID,
        inputText: extractTextFromMessages(req.body?.messages),
        outputText: '',
        isError: true,
      });
      recordOutcome({
        endpoint: 'anthropic',
        model: req.body?.model || MODEL_ID,
        isError: true,
        started,
        errorCode: error.code,
        status: error.status,
        messageCount: req.body?.messages?.length ?? null,
      });
      if (!res.headersSent && !res.writableEnded) anthropicError(res, error);
    } finally {
      if (activeId) activeRequests.delete(activeId);
    }
  });

  app.post(['/v1/messages/count_tokens', '/messages/count_tokens', '/v1/v1/messages/count_tokens'], (req, res) => {
    try {
      res.json({ input_tokens: estimateAnthropicInputTokens(req.body) });
    } catch (error) {
      anthropicError(res, error);
    }
  });

  // --- Usage / Credits API ---
  app.get('/usage/local', (_req, res) => {
    res.json(getUsage());
  });

  app.get('/usage/recent', (req, res) => {
    let limit;
    if (req.query.limit !== undefined) {
      limit = Number(req.query.limit);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new AppError(400, 'invalid_limit', 'limit must be a positive integer.');
      }
    }
    const filters = {};
    if (req.query.endpoint !== undefined) filters.endpoint = String(req.query.endpoint);
    if (req.query.model !== undefined) filters.model = String(req.query.model);
    if (req.query.ok !== undefined) {
      if (req.query.ok === 'true') filters.ok = true;
      else if (req.query.ok === 'false') filters.ok = false;
      else throw new AppError(400, 'invalid_ok', 'ok must be "true" or "false".');
    }
    res.json({ requests: getRecentRequests(limit, filters) });
  });

  app.get('/usage/hourly', (req, res) => {
    let hours = 24;
    if (req.query.hours !== undefined) {
      hours = Number(req.query.hours);
      if (!Number.isInteger(hours) || hours <= 0 || hours > 168) {
        throw new AppError(400, 'invalid_hours', 'hours must be an integer between 1 and 168.');
      }
    }
    res.json({ hours: getHourlyStats(hours) });
  });

  app.get('/usage/active', (_req, res) => {
    res.json({
      requests: [...activeRequests.values()].map(({ abort, ...info }) => ({
        ...info,
        elapsedMs: Date.now() - info.started,
      })),
    });
  });

  app.delete('/usage/active/:id', (req, res) => {
    const entry = activeRequests.get(req.params.id);
    if (!entry) {
      return openAiError(res, new AppError(404, 'not_found', 'No active request with that id.'));
    }
    // Aborting the controller kills the CLI child and fails the original
    // request with 499 request_cancelled.
    entry.abort();
    return res.json({ ok: true, id: entry.id });
  });

  app.post('/usage/reset-local', (_req, res) => {
    resetUsage();
    resetRequestHistory();
    res.json({ ok: true });
  });

  // --- Static Web Console at /ui ---
  const publicDir = path.join(__dirname, '..', 'public');

  // Redirect /ui → /ui/ so relative asset paths resolve correctly in the browser
  app.use('/ui', (req, res, next) => {
    if (req.originalUrl === '/ui' || req.originalUrl === '/ui?') {
      return res.redirect(301, '/ui/');
    }
    next();
  });

  // Serve /ui/ → index.html, and static assets under /ui/*
  app.get('/ui/', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use('/ui', express.static(publicDir));

  app.use((_req, res) => {
    openAiError(res, new AppError(404, 'not_found', 'Route not found.'));
  });

  app.use((error, _req, res, _next) => {
    openAiError(res, error);
  });

  return app;
}

module.exports = {
  MODEL_ID,
  createApp,
  createChatCompletion,
  extractRequestOptions,
  writeChatCompletionStream,
  validateChatRequest,
};
