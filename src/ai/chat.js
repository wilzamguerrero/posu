/**
 * ATOM · Cliente de chat SSE + JSON con soporte multimodal (texto e imagenes/bocetos)
 */
import { aiHeaders, readErrorDetail, readJson, wireProvider } from './wire.js';
import { activeProvider, chosenModel } from './config.js';

function streamError(parsed) {
  const err = parsed?.error;
  const msg = typeof err?.message === 'string' ? err.message.trim() : '';
  if (!msg) return null;
  const code = (typeof err?.type === 'string' && err.type) || (typeof err?.code === 'string' && err.code) || '';
  return { message: msg, code };
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
      if (err) {
        const e = new Error(err.message);
        if (err.code) e.code = err.code;
        throw e;
      }

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

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    const err = new Error(detail.message);
    if (detail.code) err.code = detail.code;
    err.status = detail.status;
    throw err;
  }

  const type = (response.headers.get('content-type') || '').toLowerCase();
  if (type.includes('text/event-stream') && response.body) {
    return await readEventStream(response.body, onDelta);
  }

  const parsed = await readJson(response);
  if (parsed && typeof parsed === 'object') {
    const err = streamError(parsed);
    if (err) {
      const e = new Error(err.message);
      if (err.code) e.code = err.code;
      throw e;
    }
  }
  const text = wholeReply(parsed);
  if (text) onDelta?.(text);
  return text;
}
