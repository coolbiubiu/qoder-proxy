const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_MODEL_ID,
  MODELS,
  getModel,
  resolveModelRoute,
} = require('../clean/models');

test('all models have required fields: id, name, cliModel, reasoning', () => {
  for (const model of MODELS) {
    assert.equal(typeof model.id, 'string', `model missing id`);
    assert.equal(typeof model.name, 'string', `model ${model.id} missing name`);
    assert.equal(typeof model.cliModel, 'string', `model ${model.id} missing cliModel`);
    assert.equal(model.reasoning, true, `model ${model.id} missing reasoning: true`);
  }
});

test('model list contains only the 10 official models', () => {
  const expectedIds = [
    'auto',
    'qwen3.8-max',
    'qwen3.7-max',
    'qwen3.7-plus',
    'qwen3.6-flash',
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    'glm-5.2',
    'kimi-k2.7-code',
    'minimax-m2.7',
  ];
  assert.deepEqual(MODELS.map((m) => m.id), expectedIds);
});

test('no model exposes a duplicate underlying CLI model', () => {
  const cliModels = MODELS.map((m) => m.cliModel);
  assert.equal(new Set(cliModels).size, cliModels.length);
  assert.equal(MODELS.some((m) => m.effortAlias), false);
});

test('resolveModelRoute parses effort suffixes correctly', () => {
  const low = resolveModelRoute('qwen3.7-max-effort-low');
  assert.equal(low.baseModelId, 'qwen3.7-max');
  assert.equal(low.reasoningEffort, 'low');

  const high = resolveModelRoute('qwen3.7-max-effort-high');
  assert.equal(high.baseModelId, 'qwen3.7-max');
  assert.equal(high.reasoningEffort, 'high');

  const max = resolveModelRoute('deepseek-v4-pro-effort-max');
  assert.equal(max.baseModelId, 'deepseek-v4-pro');
  assert.equal(max.reasoningEffort, 'max');

  const none = resolveModelRoute('qwen3.7-max');
  assert.equal(none.baseModelId, 'qwen3.7-max');
  assert.equal(none.reasoningEffort, undefined);
});

test('getModel returns correct model for known ID', () => {
  const model = getModel('auto');
  assert.ok(model);
  assert.equal(model.id, 'auto');
  assert.equal(model.name, 'Auto');
  assert.equal(model.cliModel, 'auto');
  assert.equal(model.reasoning, true);

  const flash = getModel('deepseek-v4-flash');
  assert.ok(flash);
  assert.equal(flash.id, 'deepseek-v4-flash');
  assert.equal(flash.cliModel, 'DeepSeek-V4-Flash');
});

test('getModel returns undefined for unknown ID', () => {
  assert.equal(getModel('nonexistent-model'), undefined);
  assert.equal(getModel(''), undefined);
  assert.equal(getModel(undefined), undefined);
});

test('DEFAULT_MODEL_ID is auto', () => {
  assert.equal(DEFAULT_MODEL_ID, 'auto');
});
