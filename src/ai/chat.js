/**
 * ATOM · Cliente de chat SSE + JSON con soporte multimodal (texto e imagenes/bocetos)
 */
import { aiHeaders, readError, readJson, wireProvider } from './wire.js';
import { activeProvider, chosenModel } from './config.js';

function streamError(parsed) {
  const msg = parsed?.error?.message;
  return typeof msg === 'string' && msg.trim() ? msg.trim() : null;
}

function deltaOf(parsed) {
  const choices = parsed?.choices;
  const content = Array.isArray(choices) ? choices[0]?.delta?.content : null;
  return typeof content === 'string' ? content : '';
}

function wholeReply(parsed) {
  const choices = parsed?.choices;
  const content = Array.isArray(choices) ? choices[0]?.message?.content : null;
  return typeof content === 'string' ? content : '';
}

async function readEventStream(body, onDelta) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let cut;
    while ((cut = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (raw === '[DONE]') return full;

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      const err = streamError(parsed);
      if (err) throw new Error(err);

      const piece = deltaOf(parsed);
      if (piece) {
        full += piece;
        onDelta?.(piece);
      }
    }
  }
  return full;
}

export async function streamChat({ messages, provider, model, stream = true, signal, onDelta }) {
  const prov = provider || activeProvider();
  const wire = wireProvider(prov);
  const chosen = model || chosenModel(prov);

  const response = await fetch('/api/ai-chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...aiHeaders(prov),
    },
    body: JSON.stringify({
      provider: wire,
      ...(chosen ? { model: chosen } : {}),
      messages,
      stream,
    }),
    signal,
  });

  if (!response.ok) throw new Error(await readError(response));

  const type = (response.headers.get('content-type') || '').toLowerCase();
  if (type.includes('text/event-stream') && response.body) {
    return await readEventStream(response.body, onDelta);
  }

  const parsed = await readJson(response);
  if (parsed && typeof parsed === 'object') {
    const err = streamError(parsed);
    if (err) throw new Error(err);
  }
  const text = wholeReply(parsed);
  if (text) onDelta?.(text);
  return text;
}
