import { Provider, ProviderRequest, ProviderMeta } from './types';

export class OllamaProvider implements Provider {
  constructor(public readonly meta: ProviderMeta) {}

  async generate(req: ProviderRequest): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (req.apiKey) headers['Authorization'] = `Bearer ${req.apiKey}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    const cancellation = req.token?.onCancellationRequested(() => controller.abort());

    try {
      const res = await fetch(`${trim(req.baseUrl)}/api/generate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: req.model,
          prompt: req.prompt,
          stream: false,
          format: req.expectJson ? 'json' : undefined,
          options: { temperature: 0.1 }
        }),
        signal: controller.signal
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await safeText(res)}`);
      const data = (await res.json()) as { response?: unknown };
      if (typeof data.response !== 'string') throw new Error('Unexpected response.');
      return data.response;
    } finally {
      clearTimeout(timeout);
      cancellation?.dispose();
    }
  }

  async listModels(baseUrl: string, apiKey?: string): Promise<string[]> {
    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(`${trim(baseUrl)}/api/tags`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { models?: unknown };
    if (!Array.isArray(data.models)) return [];
    return data.models
      .map(m => (m as { name?: unknown }).name)
      .filter((n): n is string => typeof n === 'string');
  }

  async test(baseUrl: string, apiKey?: string, model?: string): Promise<string> {
    const models = await this.listModels(baseUrl, apiKey);
    if (!models.length) return 'Connected, but no models available.';
    if (model && !models.includes(model)) {
      return `Connected. Model "${model}" not found. Try: ${models.slice(0, 3).join(', ')}`;
    }
    if (model) {
      const reply = await this.generate({
        baseUrl, apiKey, model,
        prompt: 'Reply with the single word: ok',
        expectJson: false
      });
      return `Working. "${model}" replied: ${reply.trim().slice(0, 30)}`;
    }
    return `Connected. ${models.length} model(s).`;
  }
}

function trim(s: string): string { return s.replace(/\/+$/, ''); }

async function safeText(res: Response): Promise<string> {
  try { return (await res.text()).slice(0, 200); } catch { return ''; }
}