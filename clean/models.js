const MODELS = [
  { id: 'auto', name: 'Auto', cliModel: 'auto', reasoning: true },
  { id: 'qwen3.8-max', name: 'Qwen3.8-Max', cliModel: 'Qwen3.8-Max', reasoning: true },
  { id: 'qwen3.7-max', name: 'Qwen3.7-Max', cliModel: 'Qwen3.7-Max', reasoning: true },
  { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', cliModel: 'Qwen3.7-Plus', reasoning: true },
  { id: 'qwen3.6-flash', name: 'Qwen3.6-Flash', cliModel: 'Qwen3.6-Flash', reasoning: true },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', cliModel: 'DeepSeek-V4-Pro', reasoning: true },
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', cliModel: 'DeepSeek-V4-Flash', reasoning: true },
  { id: 'glm-5.2', name: 'GLM-5.2', cliModel: 'GLM-5.2', reasoning: true },
  { id: 'kimi-k2.7-code', name: 'Kimi-K2.7-Code', cliModel: 'Kimi-K2.7-Code', reasoning: true },
  { id: 'minimax-m2.7', name: 'MiniMax-M2.7', cliModel: 'MiniMax-M2.7', reasoning: true },
];

const DEFAULT_MODEL_ID = 'auto';
// Legacy clients may still request `-effort-*` suffixed IDs; resolve them to
// the base model plus a reasoning effort hint instead of failing.
const EFFORT_SUFFIX_RE = /^(.*)-effort-(low|medium|high|max)$/;

function getModel(modelId) {
  return MODELS.find((model) => model.id === modelId);
}

function resolveCliModel(modelId) {
  if (process.env.QODERCN_MODEL) return process.env.QODERCN_MODEL;
  const model = getModel(modelId);
  if (model) return model.cliModel;
  // Fallback to auto for unknown models (e.g. claude-haiku, gpt-4, etc.)
  return 'auto';
}

function resolveModelRoute(modelId) {
  const match = modelId ? String(modelId).match(EFFORT_SUFFIX_RE) : null;
  const baseModelId = match ? match[1] : modelId;
  return {
    baseModelId,
    cliModel: resolveCliModel(baseModelId),
    reasoningEffort: match?.[2],
  };
}

module.exports = {
  DEFAULT_MODEL_ID,
  MODELS,
  getModel,
  resolveCliModel,
  resolveModelRoute,
};
