/**
 * OpenAI-compatible inference client.
 *
 * Works against Particle.ai (the default), LM Studio, Ollama, Gemini's
 * OpenAI-compatible endpoint, or anything else that speaks /chat/completions.
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface GenerateResult {
  code: string;
  raw: string;
  usage?: unknown;
  model?: string;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Remove markdown fences and leading prose so we get runnable JS. */
export function extractCode(raw: string): string {
  let text = raw.trim();

  const fenced = text.match(/```(?:javascript|js|typescript|ts)?\s*\n([\s\S]*?)```/i);
  if (fenced?.[1]) text = fenced[1].trim();

  // Drop any prose before the first plausible statement.
  const firstStatement = text.search(
    /^(const|let|var|if|for|return|await|penpot|penpotUtils|\/\/|\/\*)/m,
  );
  if (firstStatement > 0) text = text.slice(firstStatement).trim();

  return text;
}

export async function generateCode(
  cfg: LlmConfig,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs = 180_000,
): Promise<GenerateResult> {
  if (!cfg.baseUrl) throw new Error('No LLM base URL configured. Open Settings.');
  if (!cfg.model) throw new Error('No model configured. Open Settings.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(joinUrl(cfg.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.4,
        stream: false,
      }),
      signal: controller.signal,
    });

    const bodyText = await res.text();
    if (!res.ok) {
      throw new Error(`Model endpoint returned HTTP ${res.status}: ${bodyText.slice(0, 400)}`);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      throw new Error(`Model endpoint did not return JSON: ${bodyText.slice(0, 300)}`);
    }

    const choices = payload.choices as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.message as Record<string, unknown> | undefined;
    const content = typeof message?.content === 'string' ? message.content : '';

    if (!content.trim()) {
      throw new Error(
        'The model returned an empty message. If this is a reasoning model, it may have ' +
          'put everything in a reasoning field. Try a different model.',
      );
    }

    return {
      code: extractCode(content),
      raw: content,
      usage: payload.usage,
      model: typeof payload.model === 'string' ? payload.model : cfg.model,
    };
  } catch (err) {
    const e = err as Error;
    if (e.name === 'AbortError') {
      throw new Error(`Model call timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw new Error(`Model call failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function listModels(
  cfg: Pick<LlmConfig, 'baseUrl' | 'apiKey'>,
  timeoutMs = 20_000,
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(joinUrl(cfg.baseUrl, 'models'), {
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = (await res.json()) as { data?: Array<{ id?: string }> };
    return (payload.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => Boolean(id))
      .sort();
  } finally {
    clearTimeout(timer);
  }
}