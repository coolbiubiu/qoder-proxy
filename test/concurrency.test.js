const test = require('node:test');
const assert = require('node:assert/strict');
const { withCliSlot, getCliSlotStatus } = require('../clean/concurrency');

test('limits concurrent CLI runs and queues the rest', async () => {
  process.env.MAX_CONCURRENT_CLI = '1';
  try {
    let running = 0;
    let peak = 0;
    const task = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
      return 'ok';
    };

    const results = await Promise.all([withCliSlot(task), withCliSlot(task), withCliSlot(task)]);
    assert.deepEqual(results, ['ok', 'ok', 'ok']);
    // With a single slot, tasks must never overlap
    assert.equal(peak, 1);
    assert.equal(getCliSlotStatus().active, 0);
    assert.equal(getCliSlotStatus().queued, 0);
  } finally {
    delete process.env.MAX_CONCURRENT_CLI;
  }
});

test('slot is released when the task fails', async () => {
  process.env.MAX_CONCURRENT_CLI = '1';
  try {
    await assert.rejects(withCliSlot(async () => { throw new Error('boom'); }), /boom/);
    // A leaked slot would make this second task wait forever
    const result = await withCliSlot(async () => 'recovered');
    assert.equal(result, 'recovered');
  } finally {
    delete process.env.MAX_CONCURRENT_CLI;
  }
});

test('queued requests fail fast when the queue timeout expires', async () => {
  process.env.MAX_CONCURRENT_CLI = '1';
  process.env.CLI_QUEUE_TIMEOUT_MS = '30';
  try {
    const blocker = withCliSlot(() => new Promise((resolve) => setTimeout(resolve, 150)));
    // Let the blocker take the only slot
    await new Promise((resolve) => setTimeout(resolve, 10));

    await assert.rejects(withCliSlot(async () => 'late'), (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, 'proxy_busy');
      return true;
    });

    await blocker;
  } finally {
    delete process.env.MAX_CONCURRENT_CLI;
    delete process.env.CLI_QUEUE_TIMEOUT_MS;
  }
});

test('unlimited concurrency by default', async () => {
  let running = 0;
  let peak = 0;
  const task = async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 20));
    running -= 1;
  };

  await Promise.all([withCliSlot(task), withCliSlot(task), withCliSlot(task)]);
  assert.equal(peak, 3);
});
