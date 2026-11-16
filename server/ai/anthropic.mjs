/**
 * ATOM · Traduccion entre formato OpenAI (incluyendo vision) y Anthropic /v1/messages
 */
import { sseHeaders } from './common.mjs';

const MAX_TOKENS = 4096;

function extractTextOnly(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
}

function toAnthropicContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
      const url = part.image_url.url;
      const m = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=]+)$/i.exec(url);
      if (m) {
        const mediaType = m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase();
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: m[2] },
        });
      } else if (/^https:\/\//i.test(url)) {
        blocks.push({ type: 'image', source: { type: 'url', url } });
      }
    }
  }
  return blocks;
}

function mergeTurnContent(prev, next) {
  const toBlocks = (c) => (typeof c === 'string'
    ? (c.trim() ? [{ type: 'text', text: c }] : [])
    : Array.isArray(c) ? c : []);
  if (typeof prev === 'string' && typeof next === 'string') return `${prev}\n\n${next}`;
  return [...toBlocks(prev), ...toBlocks(next)];
}

function hasContent(c) {
  if (typeof c === 'string') return c.trim().length > 0;
  return Array.isArray(c) && c.length > 0;
}

export function toAnthropicBody(model, messages, stream) {
  const system = [];
  const turns = [];

  for (const message of messages) {
    if (message.role === 'system') {
      const txt = extractTextOnly(message.content);
      if (txt.trim()) system.push(txt);
      continue;
    }
    const content = toAnthropicContent(message.content);
    if (!hasContent(content)) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === message.role) {
      last.content = mergeTurnContent(last.content, content);
      continue;
    }
    turns.push({ role: message.role, content });
  }

  while (turns.length > 0 && turns[0]?.role === 'assistant') turns.shift();

  return {
    model,
    max_tokens: MAX_TOKENS,
    messages: turns,
    ...(system.length > 0 ? { system: system.join('\n\n') } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

const STOP = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
};

export function fromAnthropicReply(raw) {
  const data = typeof raw === 'object' && raw !== null ? raw : {};
  let text = '';
  if (Array.isArray(data.content)) {
    for (const block of data.content) {
      if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
    }
  }
  const input = typeof data.usage?.input_tokens === 'number' ? data.usage.input_tokens : 0;
  const output = typeof data.usage?.output_tokens === 'number' ? data.usage.output_tokens : 0;
  const reason = typeof data.stop_reason === 'string' ? (STOP[data.stop_reason] ?? 'stop') : 'stop';

  return {
    id: typeof data.id === 'string' ? data.id : '',
    object: 'chat.completion',
    model: typeof data.model === 'string' ? data.model : '',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: reason }],
    usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
  };
}

export function pipeAnthropicResponse(upstream) {
  const body = upstream.body;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (chunk) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      const text = (piece) => send({
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: piece } }],
      });
      const done = () => controller.enqueue(encoder.encode('data: [DONE]\n\n'));

      if (!body) {
        done();
        controller.close();
        return;
      }

      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let closed = false;

      try {
        for (;;) {
          const { done: finished, value } = await reader.read();
          if (finished) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const raw of lines) {
            const line = raw.trim();
            if (!line.startsWith('data:')) continue;
            let event;
            try {
              event = JSON.parse(line.slice(5).trim());
            } catch {
              continue;
            }
            if (event.type === 'content_block_start') {
              if (event.content_block?.type === 'text' && typeof event.content_block.text === 'string' && event.content_block.text) {
                text(event.content_block.text);
              }
              continue;
            }
            if (event.type === 'content_block_delta') {
              if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string' && event.delta.text) {
                text(event.delta.text);
              }
              continue;
            }
            if (event.type === 'message_delta') {
              const reason = event.delta?.stop_reason;
              if (typeof reason === 'string') {
                send({
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: {}, finish_reason: STOP[reason] ?? 'stop' }],
                });
              }
              continue;
            }
            if (event.type === 'error') {
              const message = typeof event.error?.message === 'string'
                ? event.error.message
                : 'El proveedor cortó la respuesta.';
              send({ error: { message } });
              continue;
            }
            if (event.type === 'message_stop') {
              done();
              closed = true;
            }
          }
        }
        if (!closed) done();
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { status: 200, headers: sseHeaders() });
}
