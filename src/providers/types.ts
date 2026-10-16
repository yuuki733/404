import { Explanation } from '../types';

export type ProviderId =
  | 'ollama-local'
  | 'ollama-cloud'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'openai-compatible';

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  requiresKey: boolean;
  defaultBaseUrl: string;
  description: string;
}

export interface ProviderRequest {
  baseUrl: string;
  apiKey?: string;
  model: string;
  prompt: string;
  expectJson: boolean;
  token?: import('vscode').CancellationToken;
}

export interface Provider {
  meta: ProviderMeta;
  generate(req: ProviderRequest): Promise<string>;
  listModels(baseUrl: string, apiKey?: string): Promise<string[]>;
  test(baseUrl: string, apiKey?: string, model?: string): Promise<string>;
}

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  'ollama-local': {
    id: 'ollama-local',
    label: 'Ollama (local)',
    requiresKey: false,
    defaultBaseUrl: 'http://localhost:11434',
    description: 'Runs on your machine. No API key needed.'
  },
  'ollama-cloud': {
    id: 'ollama-cloud',
    label: 'Ollama (cloud)',
    requiresKey: true,
    defaultBaseUrl: 'https://ollama.com',
    description: 'Ollama Cloud. Requires an API key from ollama.com.'
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    requiresKey: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    description: 'GPT models. Requires an OpenAI API key.'
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    requiresKey: true,
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    description: 'Claude models. Requires an Anthropic API key.'
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    requiresKey: true,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    description: 'Gemini models. Requires a Google AI Studio key.'
  },
  'openai-compatible': {
    id: 'openai-compatible',
    label: 'OpenAI-compatible',
    requiresKey: true,
    defaultBaseUrl: 'https://api.example.com/v1',
    description: 'Groq, Together, OpenRouter, LM Studio, vLLM.'
  }
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export type { Explanation };