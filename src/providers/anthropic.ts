import { Provider, ProviderRequest, ProviderMeta } from './types';

interface MessagesResponse { content?: Array<{ type?: string; text?: unknown }>; }

export class AnthropicProvider implements Provider {
  constructor(public readonly meta: ProviderMeta) {}

  async generate(req: ProviderRequest): Promise<string> {
    if (!req.apiKey) throw new Error('Missing API key.');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    const cancellation = req.token?.onCancellationRequested(() => controller.abort());

    try {
      const res = await fetch(`${trim(req.baseUrl)}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': req.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: 2048,
          messages: [{ role: 'user', content: req.prompt }],
          temperature: 0.1
        }),
        signal: controller.signal
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await safeText(res)}`);
      const data = (await res.json()) as MessagesResponse;
      const block = data.content?.find(c => c.type === 'text');
      if (!block || typeof block.text !== 'string') throw new Error('Unexpected response.');
      return block.text;
    } finally {
      clearTimeout(timeout);
      cancellation?.dispose();
    }
  }

  async listModels(_baseUrl: string, _apiKey?: string): Promise<string[]> {
    return [
      'claude-sonnet-4-5',
      'claude-opus-4-1',
      'claude-haiku-4-5',
      'claude-3-5-sonnet-latest',
      'claude-3-5-haiku-latest'
    ];
  }

  async test(baseUrl: string, apiKey?: string, model?: string): Promise<string> {
    if (!apiKey) return 'Missing API key.';
    if (!model) return 'Enter a model name (e.g. claude-haiku-4-5).';
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