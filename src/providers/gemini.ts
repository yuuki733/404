import { Provider, ProviderRequest, ProviderMeta } from './types';

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
}

export class GeminiProvider implements Provider {
  constructor(public readonly meta: ProviderMeta) {}

  async generate(req: ProviderRequest): Promise<string> {
    if (!req.apiKey) throw new Error('Missing API key.');

    const genConfig: Record<string, unknown> = { temperature: 0.1 };
    if (req.expectJson) genConfig.responseMimeType = 'application/json';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    const cancellation = req.token?.onCancellationRequested(() => controller.abort());

    try {
      const url = `${trim(req.baseUrl)}/models/${encodeURIComponent(req.model)}:generateContent`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': req.apiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: req.prompt }] }],
          generationConfig: genConfig
        }),
        signal: controller.signal
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await safeText(res)}`);
      const data = (await res.json()) as GeminiResponse;
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      const text = parts.map(p => p.text).filter((t): t is string => typeof t === 'string').join('');
      if (!text) throw new Error('Unexpected response.');
      return text;
    } finally {
      clearTimeout(timeout);
      cancellation?.dispose();
    }
  }

  async listModels(baseUrl: string, apiKey?: string): Promise<string[]> {
    if (!apiKey) return [];
    try {
      const res = await fetch(`${trim(baseUrl)}/models`, {
        headers: { 'x-goog-api-key': apiKey }
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { models?: unknown };
      if (!Array.isArray(data.models)) return [];
      return data.models
        .map(m => (m as { name?: unknown }).name)
        .filter((n): n is string => typeof n === 'string')
        .map(n => n.replace(/^models\//, ''))
        .sort();
    } catch { return []; }
  }

  async test(baseUrl: string, apiKey?: string, model?: string): Promise<string> {
    if (!apiKey) return 'Missing API key.';
    if (!model) {
      const models = await this.listModels(baseUrl, apiKey);
      return models.length
        ? `Key works. ${models.length} model(s). Try: ${models.slice(0, 3).join(', ')}`
        : 'Key accepted but no models listed.';
    }
    const reply = await this.generate({
      baseUrl, apiKey, model,
      prompt: 'Reply with the single word: ok',
      expectJson: false
    });
    return `Working. "${model}" replied: ${reply.trim().slice(0, 30)}`;
  }
}

function trim(s: string): string { return s.replace(/\/+$/, ''); }

async function safeText(res: Response): Promise<string> {
  try { return (await res.text()).slice(0, 200); } catch { return ''; }
}