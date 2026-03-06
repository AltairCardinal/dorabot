export const MINIMAX_MODELS = [
  { value: 'MiniMax-M2.5', label: 'MiniMax M2.5' },
] as const;

export const QWEN_BAILIAN_MODELS = [
  { value: 'qwen3-max-2026-01-23', label: 'qwen3-max-2026-01-23' },
  { value: 'qwen3.5-plus', label: 'qwen3.5-plus' },
  { value: 'qwen3-coder-next', label: 'qwen3-coder-next' },
  { value: 'glm-5', label: 'glm-5' },
  { value: 'kimi-k2.5', label: 'kimi-k2.5' },
  { value: 'MiniMax-M2.5', label: 'MiniMax-M2.5' },
] as const;

export const QWEN_PORTAL_MODELS = [
  { value: 'coder-model', label: 'Qwen Coder' },
  { value: 'vision-model', label: 'Qwen Vision' },
] as const;

export function getQwenModels(authMode?: string) {
  return authMode === 'oauth' ? QWEN_PORTAL_MODELS : QWEN_BAILIAN_MODELS;
}