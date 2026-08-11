const { AppError } = require('./errors');

// Each proxy request spawns a CLI child process, which is CPU- and IO-heavy.
// Without a limit, N concurrent requests means N CLI processes, which can
// saturate the machine and trip upstream rate limits. MAX_CONCURRENT_CLI
// caps how many run at once; the rest wait in a FIFO queue.

function getMaxConcurrency() {
  const value = Number(process.env.MAX_CONCURRENT_CLI);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : Infinity;
}

function getQueueTimeoutMs() {
  const value = Number(process.env.CLI_QUEUE_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

let active = 0;
const queue = [];

function tryNext() {
  while (queue.length > 0 && active < getMaxConcurrency()) {
    const next = queue.shift();
    clearTimeout(next.timer);
    active += 1;
    next.resolve();
  }
}

function release() {
  active = Math.max(0, active - 1);
  tryNext();
}

function acquire() {
  if (active < getMaxConcurrency()) {
    active += 1;
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const entry = { resolve, timer: null };
    const timeoutMs = getQueueTimeoutMs();
    if (timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        const index = queue.indexOf(entry);
        if (index !== -1) queue.splice(index, 1);
        reject(
          new AppError(
            503,
            'proxy_busy',
            `All ${getMaxConcurrency()} CLI slots are busy and the queue timed out after ${timeoutMs}ms. Retry shortly.`
          )
        );
      }, timeoutMs);
      entry.timer.unref?.();
    }
    queue.push(entry);
  });
}

/**
 * Run `fn` within a CLI slot. Waits for a free slot first, and always
 * releases it when `fn` settles so a failed request cannot leak a slot.
 */
async function withCliSlot(fn) {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

function getCliSlotStatus() {
  return {
    active,
    queued: queue.length,
    maxConcurrency: getMaxConcurrency(),
  };
}

module.exports = {
  getCliSlotStatus,
  withCliSlot,
};
