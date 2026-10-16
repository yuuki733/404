import { Provider, ProviderRequest, ProviderMeta } from './types';

interface ChatCompletion { choices?: Array<{ message?: { content?: unknown } }>; }

export class OpenAIProvider implements Provider {
  constructor(public readonly meta: ProviderMeta) {}

  async generate(req: ProviderRequest): Promise<string> {
    if (!req.apiKey) throw new Error('Missing API key.');

    const body: Record<string, unknown> = {
      model: req.model,
      messages: [
        { role: 'system', content: 'You are a concise coding assistant. Always reply with valid JSON when asked.' },
        { role: 'user', content: req.prompt }
      ],
      temperature: 0.1
    };
    if (req.expectJson) body.response_format = { type: 'json_object' };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    const cancellation = req.token?.onCancellationRequested(() => controller.abort());

    try {
      const res = await fetch(`${trim(req.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${req.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await safeText(res)}`);
      const data = (await res.json()) as ChatCompletion;
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('Unexpected response.');
      return content;
    } finally {
      clearTimeout(timeout);
      cancellation?.dispose();
    }
  }

  async listModels(baseUrl: string, apiKey?: string): Promise<string[]> {
    if (!apiKey) return [];
    try {
      const res = await fetch(`${trim(baseUrl)}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: unknown };
      if (!Array.isArray(data.data)) return [];
      return data.data
        .map(m => (m as { id?: unknown }).id)
        .filter((id): id is string => typeof id === 'string')
        .sort();
    } catch { return []; }
  }

  async test(baseUrl: string, apiKey?: string, model?: string): Promise<string> {
    if (!apiKey) return 'Missing API key.';
    const models = await this.listModels(baseUrl, apiKey);
    if (!models.length) return 'API key accepted, but could not list models.';
    if (model && !models.includes(model)) {
      return `Key works. Model "${model}" not in list. Try: ${models.slice(0, 3).join(', ')}`;
    }
    return `Working. ${models.length} model(s).`;
  }
}

function trim(s: string): string { return s.replace(/\/+$/, ''); }

async function safeText(res: Response): Promise<string> {
  try { return (await res.text()).slice(0, 200); } catch { return ''; }
}