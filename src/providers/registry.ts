import * as vscode from 'vscode';
import {
  Provider,
  ProviderId,
  PROVIDERS,
  PROVIDER_IDS
} from './types';
import { OllamaProvider } from './ollama';
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';

const instances: Record<ProviderId, Provider> = {
  'ollama-local': new OllamaProvider(PROVIDERS['ollama-local']),
  'ollama-cloud': new OllamaProvider(PROVIDERS['ollama-cloud']),
  openai: new OpenAIProvider(PROVIDERS.openai),
  anthropic: new AnthropicProvider(PROVIDERS.anthropic),
  gemini: new GeminiProvider(PROVIDERS.gemini),
  'openai-compatible': new OpenAIProvider(PROVIDERS['openai-compatible'])
};

export function getProvider(id: ProviderId): Provider {
  return instances[id];
}

export function isProviderId(v: string): v is ProviderId {
  return (PROVIDER_IDS as string[]).includes(v);
}

/**
 * Secret key naming: `404Extension.apiKey.<providerId>`.
 * Uses VS Code SecretStorage, which is backed by the OS keychain[reference:7].
 */
function secretKey(providerId: ProviderId): string {
  return `404Extension.apiKey.${providerId}`;
}

export async function getApiKey(
  context: vscode.ExtensionContext,
  providerId: ProviderId
): Promise<string | undefined> {
  return context.secrets.get(secretKey(providerId));
}

export async function setApiKey(
  context: vscode.ExtensionContext,
  providerId: ProviderId,
  key: string
): Promise<void> {
  if (!key.trim()) {
    await context.secrets.delete(secretKey(providerId));
    return;
  }
  await context.secrets.store(secretKey(providerId), key.trim());
}

export async function deleteApiKey(
  context: vscode.ExtensionContext,
  providerId: ProviderId
): Promise<void> {
  await context.secrets.delete(secretKey(providerId));
}

export async function hasApiKey(
  context: vscode.ExtensionContext,
  providerId: ProviderId
): Promise<boolean> {
  const v = await getApiKey(context, providerId);
  return !!v;
}

/**
 * Resolve provider + model + api key for a given task.
 * Reads the task profile from settings; falls back to the global default.
 */
export interface ResolvedTarget {
  providerId: ProviderId;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export async function resolveTarget(
  context: vscode.ExtensionContext,
  taskType: string
): Promise<ResolvedTarget> {
  const config = vscode.workspace.getConfiguration('404Extension');

  const useProfiles = config.get<boolean>('taskProfiles.enabled', false);
  const defaultProvider = config.get<ProviderId>(
    'provider',
    'ollama-local'
  );
  const defaultModel = config.get<string>('model', 'phi3:mini');

  let providerId: ProviderId = defaultProvider;
  let model: string = defaultModel;

  if (useProfiles) {
    const profileProvider = config.get<string>(
      `taskProfiles.${taskType}.provider`,
      ''
    );
    const profileModel = config.get<string>(
      `taskProfiles.${taskType}.model`,
      ''
    );
    if (profileProvider && isProviderId(profileProvider)) {
      providerId = profileProvider;
    }
    if (profileModel) model = profileModel;
  }

  const baseUrl =
    config.get<string>(`providerUrls.${providerId}`, '') ||
    PROVIDERS[providerId].defaultBaseUrl;

  const apiKey = PROVIDERS[providerId].requiresKey
    ? await getApiKey(context, providerId)
    : undefined;

  return { providerId, baseUrl, model, apiKey };
}