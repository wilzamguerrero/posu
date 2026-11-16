/**
 * ATOM · Catalogo de proveedores integrados y utilidades de identificador
 */

export const BUILTIN_IDS = ['freepi', 'openai', 'anthropic', 'openrouter', 'github', 'nvidia'];

export const CUSTOM_PREFIX = 'custom:';

export const BUILTINS = {
  freepi: {
    label: 'free-pi',
    hint: 'Gratis con tu cuenta de GitHub en 1 paso: ~15 000 créditos/día con modelos DeepSeek, GPT, Claude y visión.',
    url: 'https://freepi.ai',
    publicCatalog: false,
    defaultModel: 'deepseek-v4.1-flash',
  },
  openai: {
    label: 'OpenAI',
    hint: 'API directa de OpenAI (GPT-4o, GPT-4.1, o3/o4-mini) con soporte multimodal para analizar bocetos.',
    url: 'https://platform.openai.com/api-keys',
    publicCatalog: false,
    defaultModel: 'gpt-4o-mini',
  },
  anthropic: {
    label: 'Anthropic',
    hint: 'Claude Sonnet / Opus / Haiku directo desde console.anthropic.com (también entiende bocetos e imágenes).',
    url: 'https://console.anthropic.com/',
    publicCatalog: false,
    defaultModel: 'claude-sonnet-4-5',
  },
  openrouter: {
    label: 'OpenRouter',
    hint: 'Pasarela unificada con cientos de modelos (incluidos niveles :free y modelos con visión).',
    url: 'https://openrouter.ai/keys',
    publicCatalog: true,
    defaultModel: 'openai/gpt-4o-mini',
  },
  github: {
    label: 'GitHub Copilot',
    hint: 'Conecta tu cuenta de GitHub mediante código de dispositivo (OAuth device flow).',
    url: 'https://github.com/settings/copilot',
    publicCatalog: false,
    defaultModel: 'gpt-4o-mini',
  },
  nvidia: {
    label: 'NVIDIA',
    hint: 'NVIDIA NIM (Llama, Nemotron, Qwen, VLM) con créditos gratuitos al crear cuenta.',
    url: 'https://build.nvidia.com/',
    publicCatalog: false,
    defaultModel: 'nvidia/llama-3.3-nemotron-super-49b-v1',
  },
};

export function isBuiltin(id) {
  return BUILTIN_IDS.includes(id);
}

export function isCustom(id) {
  return typeof id === 'string' && id.startsWith(CUSTOM_PREFIX) && id.length > CUSTOM_PREFIX.length;
}

export function builtinInfo(id) {
  return isBuiltin(id) ? BUILTINS[id] : null;
}

export function customSlug(id) {
  return isCustom(id) ? id.slice(CUSTOM_PREFIX.length) : null;
}

export function customId(slug) {
  return `${CUSTOM_PREFIX}${slug}`;
}
