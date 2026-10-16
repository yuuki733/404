import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { Explanation } from './types';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 300;

interface Entry { explanation: Explanation; timestamp: number; }

export class ExplanationCache {
  private static readonly KEY = '404Extension.cache';
  constructor(private readonly context: vscode.ExtensionContext) {}

  private get store(): Record<string, Entry> {
    return this.context.globalState.get<Record<string, Entry>>(ExplanationCache.KEY, {});
  }

  get(signature: string): Explanation | undefined {
    const entry = this.store[signature];
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > TTL_MS) return undefined;
    return entry.explanation;
  }

  async set(signature: string, explanation: Explanation): Promise<void> {
    const store = { ...this.store, [signature]: { explanation, timestamp: Date.now() } };
    const entries = Object.entries(store)
      .filter(([, value]) => Date.now() - value.timestamp <= TTL_MS)
      .sort((a, b) => b[1].timestamp - a[1].timestamp)
      .slice(0, MAX_ENTRIES);
    await this.context.globalState.update(ExplanationCache.KEY, Object.fromEntries(entries));
  }
}

export function signatureFor(
  errorMessage: string,
  _codeContext: string,
  languageId: string,
  extra: string
): string {
  const normalized = errorMessage
    .replace(/'[^']*'/g, "'X'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return createHash('sha256')
    .update([normalized, languageId, extra].join('|'))
    .digest('hex');
}