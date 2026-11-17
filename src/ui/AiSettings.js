/**
 * ATOM · Panel de configuracion de APIs de IA (Ajustes › Asistente IA)
 * ---------------------------------------------------------------------------
 * Mismo sistema multi-proveedor que Zence-R2 en DOM puro acorde con ATOM:
 * free-pi (1 paso gratis), OpenAI, Anthropic, OpenRouter, GitHub Copilot,
 * NVIDIA y proveedores propios (Ollama, LM Studio o cualquier endpoint).
 */
import { el } from './widgets.js';
import { icon } from './icons.js';
import { streamChat } from '../ai/chat.js';
import {
  activeProvider,
  addCustomProvider,
  aiConfig,
  browserKey,
  chosenModel,
  clearKey,
  customProvider,
  hasCredential,
  probeServerKeys,
  providerIds,
  providerLabel,
  removeCustomProvider,
  serverKeys,
  setKey,
  setModel,
  setProvider,
} from '../ai/config.js';
import { startDeviceFlow, waitForDeviceToken } from '../ai/device.js';
import {
  clearFreePiAd,
  ensureFreePiAd,
} from '../ai/freepiAds.js';
import { freePiAccount, startFreePiFlow, waitForFreePiToken } from '../ai/freepiDevice.js';
import { cachedCatalog, forgetCatalog, listModels } from '../ai/models.js';
import { builtinInfo, isBuiltin, isCustom } from '../ai/providers.js';
import { loadDirectory } from '../ai/registry.js';

export function buildAiSettingsControl() {
  const root = el('div', { class: 'ai-settings' });

  const state = {
    addingCustom: false,
    keyDraft: '',
    models: [],
    defaultModel: '',
    modelFilter: '',
    loadingModels: false,
    probing: false,
    statusText: '',
    statusBad: false,
    freepiStart: null,
    freepiMe: null,
    ghStart: null,
    authBusy: false,
    copiedCode: false,
    customLabel: '',
    customUrl: '',
    customFormat: 'openai',
    customKeyHeader: '',
    directory: [],
  };

  let authAbort = null;
  let catalogAbort = null;
  let meAbort = null;
  let copyTimer = 0;
  let lastCatalogKey = '';

  const setStatus = (text, bad = false) => {
    state.statusText = text;
    state.statusBad = bad;
    render();
  };

  async function copyCode(code) {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = code;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* noop */ }
      document.body.removeChild(ta);
    }
    state.copiedCode = true;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { state.copiedCode = false; render(); }, 1800);
    setStatus(`Código ${code} copiado al portapapeles.`);
  }

  async function connectFreePi() {
    authAbort?.abort();
    const ac = new AbortController();
    authAbort = ac;
    state.authBusy = true;
    setStatus('Solicitando código de free-pi en GitHub…');
    try {
      const start = await startFreePiFlow(ac.signal);
      state.freepiStart = start;
      setStatus(`Introduce el código ${start.userCode} en GitHub para activar free-pi.`);
      const tok = await waitForFreePiToken(start, ac.signal);
      setKey('freepi', tok.token);
      state.freepiStart = null;
      setStatus('free-pi conectado y listo para usar.');
    } catch (e) {
      if (!ac.signal.aborted) {
        setStatus(e instanceof Error ? e.message : 'Error conectando free-pi.', true);
      }
      state.freepiStart = null;
    } finally {
      state.authBusy = false;
      render();
    }
  }

  async function connectGithub() {
    authAbort?.abort();
    const ac = new AbortController();
    authAbort = ac;
    state.authBusy = true;
    setStatus('Solicitando código de dispositivo en GitHub…');
    try {
      const start = await startDeviceFlow(ac.signal);
      state.ghStart = start;
      setStatus(`Introduce el código ${start.userCode} en GitHub.`);
      const token = await waitForDeviceToken(start, ac.signal);
      setKey('github', token);
      state.ghStart = null;
      setStatus('GitHub Copilot conectado.');
    } catch (e) {
      if (!ac.signal.aborted) {
        setStatus(e instanceof Error ? e.message : 'Error conectando GitHub.', true);
      }
      state.ghStart = null;
    } finally {
      state.authBusy = false;
      render();
    }
  }

  function refreshFreePiAccount(provider, savedKey) {
    meAbort?.abort();
    if (provider !== 'freepi' || !savedKey) {
      state.freepiMe = null;
      return;
    }
    const ac = new AbortController();
    meAbort = ac;
    void freePiAccount(savedKey, ac.signal).then((me) => {
      if (!ac.signal.aborted) {
        state.freepiMe = me;
        render();
      }
    });
  }

  async function syncCatalog(force = false) {
    const provider = activeProvider();
    const info = builtinInfo(provider);
    const authed = hasCredential(provider);
    if (state.addingCustom) return;

    const cached = !force ? cachedCatalog(provider) : null;
    if (cached) {
      state.models = cached.models;
      state.defaultModel = cached.defaultModel;
      return;
    }
    if (!force && !authed && !info?.publicCatalog && !isCustom(provider)) {
      state.models = [];
      state.defaultModel = '';
      return;
    }

    catalogAbort?.abort();
    const ac = new AbortController();
    catalogAbort = ac;
    state.loadingModels = true;
    if (force) setStatus('Actualizando lista de modelos…');
    else render();

    try {
      const cat = await listModels(provider, { force, signal: ac.signal });
      if (ac.signal.aborted) return;
      state.models = cat.models;
      state.defaultModel = cat.defaultModel;
      if (force) setStatus(`${cat.models.length} modelos disponibles.`);
    } catch (e) {
      if (!ac.signal.aborted && force) {
        setStatus(e instanceof Error ? e.message : 'No se pudieron cargar los modelos.', true);
      }
    } finally {
      if (!ac.signal.aborted) {
        state.loadingModels = false;
        render();
      }
    }
  }

  /** Anuncios de free-pi: se piden y se reportan solos, sin mostrar nada. */
  function syncAdsQuiet() {
    if (activeProvider() !== 'freepi' || !hasCredential('freepi')) return;
    void ensureFreePiAd();
  }

  async function testConnection() {
    const provider = activeProvider();
    const selectedModel = chosenModel(provider) || state.defaultModel;
    state.probing = true;
    setStatus('Probando respuesta del modelo…');
    const pingOnce = () => streamChat({
      provider,
      model: selectedModel || undefined,
      messages: [
        { role: 'system', content: 'Contesta en una palabra: listo.' },
        { role: 'user', content: 'ping' },
      ],
    });
    try {
      let reply;
      try {
        reply = await pingOnce();
      } catch (err) {
        const isAdsRequired = provider === 'freepi'
          && (err?.code === 'ads_required' || /ads_required|ads aren't displaying/i.test(err?.message || ''));
        if (!isAdsRequired) throw err;
        setStatus('anuncio de free-pi automático: reintentando…');
        const ad = await ensureFreePiAd({ force: true });
        if (!ad) throw err;
        await new Promise((r) => setTimeout(r, 350));
        reply = await pingOnce();
      }
      setStatus(`Conexión OK: "${reply.replace(/\s+/g, ' ').trim().slice(0, 60)}"`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Fallo al probar conexión.', true);
    } finally {
      state.probing = false;
      render();
    }
  }

  function submitCustom() {
    if (!state.customUrl.trim()) {
      setStatus('Escribe la URL base (ej. http://localhost:11434/v1).', true);
      return;
    }
    const id = addCustomProvider({
      label: state.customLabel.trim() || 'API propia',
      baseUrl: state.customUrl.trim(),
      format: state.customFormat,
      keyHeader: state.customKeyHeader.trim() || undefined,
    });
    if (state.keyDraft.trim()) {
      setKey(id, state.keyDraft.trim());
      state.keyDraft = '';
    }
    state.customLabel = '';
    state.customUrl = '';
    state.customKeyHeader = '';
    state.addingCustom = false;
    setStatus('Proveedor añadido.');
  }

  function openCustomForm() {
    state.addingCustom = true;
    state.statusText = '';
    render();
    void loadDirectory()
      .then((dir) => {
        state.directory = dir.providers.slice(0, 40);
        if (state.addingCustom) render();
      })
      .catch(() => {});
  }

  function render() {
    const provider = activeProvider();
    const info = builtinInfo(provider);
    const custom = customProvider(provider);
    const savedKey = browserKey(provider);
    const serverConfigured = isBuiltin(provider) && serverKeys.get()?.[provider] === true;
    const selectedModel = chosenModel(provider) || state.defaultModel;
    const authed = hasCredential(provider);

    const catKey = `${provider}:${authed ? 1 : 0}:${savedKey.length}`;
    if (catKey !== lastCatalogKey && !state.addingCustom) {
      lastCatalogKey = catKey;
      refreshFreePiAccount(provider, savedKey);
      queueMicrotask(() => void syncCatalog(false));
    }

    const ids = providerIds();
    const providerRow = el('div', { class: 'ai-provider-row', role: 'group', 'aria-label': 'Proveedor de IA' }, [
      ...ids.map((id) => el('button', {
        type: 'button',
        class: `ai-prov-btn ${!state.addingCustom && provider === id ? 'is-active' : ''}`,
        text: providerLabel(id),
        onClick: () => {
          authAbort?.abort();
          state.addingCustom = false;
          state.freepiStart = null;
          state.ghStart = null;
          state.statusText = '';
          state.modelFilter = '';
          setProvider(id);
        },
      })),
      el('button', {
        type: 'button',
        class: `ai-prov-btn ${state.addingCustom ? 'is-active' : ''}`,
        onClick: openCustomForm,
      }, [icon('plus', 11), el('span', { text: 'Otro' })]),
    ]);

    const bodyNodes = [providerRow];

    if (state.addingCustom) {
      const dirSelect = state.directory.length > 0
        ? el('label', { class: 'ai-field' }, [
          el('span', { text: 'Plantilla rápida' }),
          el('select', {
            class: 'select',
            onChange: (ev) => {
              const v = ev.target.value;
              if (v === '__ollama') {
                state.customLabel = 'Ollama';
                state.customUrl = 'http://localhost:11434/v1';
                render();
                return;
              }
              const found = state.directory.find((d) => d.id === v);
              if (found) {
                state.customLabel = found.name;
                if (found.api) state.customUrl = found.api;
                render();
              }
            },
          }, [
            el('option', { value: '', text: 'Elegir de models.dev…' }),
            el('option', { value: '__ollama', text: 'Ollama local (localhost:11434)' }),
            ...state.directory.map((d) => el('option', { value: d.id, text: `${d.name} (${d.models} modelos)` })),
          ]),
        ])
        : null;

      bodyNodes.push(el('div', { class: 'ai-custom-box' }, [
        el('div', { class: 'ai-box-head', text: 'Añadir proveedor compatible (OpenAI / Ollama / Anthropic)' }),
        dirSelect,
        el('label', { class: 'ai-field' }, [
          el('span', { text: 'Nombre' }),
          el('input', {
            type: 'text',
            placeholder: 'Ej: Ollama / DeepSeek / LM Studio',
            value: state.customLabel,
            onInput: (e) => { state.customLabel = e.target.value; },
          }),
        ]),
        el('label', { class: 'ai-field' }, [
          el('span', { text: 'URL Base' }),
          el('input', {
            type: 'url',
            placeholder: 'http://localhost:11434/v1',
            value: state.customUrl,
            onInput: (e) => { state.customUrl = e.target.value; },
          }),
        ]),
        el('label', { class: 'ai-field' }, [
          el('span', { text: 'Formato API' }),
          el('select', {
            class: 'select',
            value: state.customFormat,
            onChange: (e) => { state.customFormat = e.target.value; },
          }, [
            el('option', { value: 'openai', text: 'OpenAI (/chat/completions)' }),
            el('option', { value: 'anthropic', text: 'Anthropic (/messages)' }),
          ]),
        ]),
        el('label', { class: 'ai-field' }, [
          el('span', { text: 'API Key (opcional en local)' }),
          el('input', {
            type: 'password',
            placeholder: 'Opcional para Ollama / LM Studio',
            value: state.keyDraft,
            onInput: (e) => { state.keyDraft = e.target.value; },
          }),
        ]),
        el('div', { class: 'ai-btn-row' }, [
          el('button', { type: 'button', class: 'btn is-primary', text: 'Guardar proveedor', onClick: submitCustom }),
          el('button', {
            type: 'button',
            class: 'btn',
            text: 'Cancelar',
            onClick: () => { state.addingCustom = false; render(); },
          }),
        ]),
      ]));
    } else {
      bodyNodes.push(el('p', {
        class: 'ai-hint',
        text: info ? info.hint : (custom ? `Endpoint personalizado: ${custom.baseUrl}` : ''),
      }));

      if (provider === 'freepi') {
        const box = el('div', { class: 'ai-cred-box' });
        if (state.freepiStart) {
          box.append(el('div', { class: 'ai-device-code' }, [
            el('span', { text: 'Código GitHub:' }),
            el('button', {
              type: 'button',
              class: `ai-code-copy ${state.copiedCode ? 'is-copied' : ''}`,
              title: 'Clic para copiar el código',
              onClick: () => void copyCode(state.freepiStart.userCode),
            }, [
              el('strong', { text: state.freepiStart.userCode }),
              el('span', { class: 'ai-code-copy-tag' }, [
                icon(state.copiedCode ? 'check' : 'copy', 11),
                el('span', { text: state.copiedCode ? 'Copiado' : 'Copiar' }),
              ]),
            ]),
            el('a', {
              href: state.freepiStart.verificationUriComplete || state.freepiStart.verificationUri,
              target: '_blank',
              rel: 'noreferrer',
              class: 'btn is-primary',
              onClick: () => void copyCode(state.freepiStart.userCode),
            }, [el('span', { text: 'Abrir GitHub' }), icon('external-link', 11)]),
          ]));
        } else if (savedKey) {
          const me = state.freepiMe;
          const label = `free-pi conectado${me?.handle ? ` (@${me.handle})` : ''}${
            me?.remainingCredits != null && me?.allowanceCredits != null
              ? ` · ${me.remainingCredits}/${me.allowanceCredits} cr`
              : ''
          }`;
          box.append(el('div', { class: 'ai-connected-row' }, [
            el('span', { class: 'ai-ok-pill' }, [icon('check', 11), el('span', { text: label })]),
            el('button', {
              type: 'button',
              class: 'btn',
              text: 'Desconectar',
              onClick: () => { clearKey('freepi'); clearFreePiAd(); state.freepiMe = null; },
            }),
          ]));
          // El anuncio de free-pi se pide y se reporta en segundo plano: aqui no
          // se pinta nada, ni tarjeta ni linea ni boton. Solo se asegura uno
          // vigente al abrir los ajustes (el resto lo hace la app sola).
          queueMicrotask(syncAdsQuiet);
        } else {
          box.append(el('button', {
            type: 'button',
            class: 'btn is-primary',
            disabled: state.authBusy,
            onClick: () => void connectFreePi(),
          }, [icon('zap', 12), el('span', { text: state.authBusy ? 'Esperando autorización…' : 'Conectar free-pi gratis (1 paso)' })]));
        }
        bodyNodes.push(box);
      } else if (provider === 'github') {
        const box = el('div', { class: 'ai-cred-box' });
        if (state.ghStart) {
          box.append(el('div', { class: 'ai-device-code' }, [
            el('span', { text: 'Código:' }),
            el('button', {
              type: 'button',
              class: `ai-code-copy ${state.copiedCode ? 'is-copied' : ''}`,
              onClick: () => void copyCode(state.ghStart.userCode),
            }, [
              el('strong', { text: state.ghStart.userCode }),
              el('span', { class: 'ai-code-copy-tag' }, [
                icon(state.copiedCode ? 'check' : 'copy', 11),
                el('span', { text: state.copiedCode ? 'Copiado' : 'Copiar' }),
              ]),
            ]),
            el('a', {
              href: state.ghStart.verificationUri,
              target: '_blank',
              rel: 'noreferrer',
              class: 'btn is-primary',
              onClick: () => void copyCode(state.ghStart.userCode),
            }, [el('span', { text: 'Abrir GitHub' }), icon('external-link', 11)]),
          ]));
        } else {
          box.append(el('div', { class: 'ai-btn-row' }, [
            el('button', {
              type: 'button',
              class: 'btn is-primary',
              disabled: state.authBusy,
              text: savedKey ? 'Reconectar GitHub Copilot' : 'Conectar GitHub por dispositivo',
              onClick: () => void connectGithub(),
            }),
            savedKey
              ? el('button', { type: 'button', class: 'btn', text: 'Quitar', onClick: () => clearKey('github') })
              : null,
          ]));
        }
        bodyNodes.push(box);
      } else {
        const credBox = el('div', { class: 'ai-cred-box' }, [
          el('div', { class: 'ai-key-row' }, [
            icon('key-round', 13),
            el('input', {
              type: 'password',
              placeholder: savedKey
                ? 'Clave guardada en navegador'
                : (serverConfigured ? 'Configurada en servidor (.env)' : 'Pega aquí tu API key…'),
              value: state.keyDraft,
              onInput: (e) => { state.keyDraft = e.target.value; },
            }),
            el('button', {
              type: 'button',
              class: 'btn',
              text: savedKey ? 'Cambiar' : 'Guardar',
              onClick: () => {
                if (!state.keyDraft.trim()) return;
                setKey(provider, state.keyDraft);
                state.keyDraft = '';
                setStatus('Clave guardada en este navegador.');
              },
            }),
            savedKey
              ? el('button', {
                type: 'button',
                class: 'icon-btn tiny',
                title: 'Borrar clave',
                onClick: () => clearKey(provider),
              }, icon('trash-2', 12))
              : null,
          ]),
          isCustom(provider)
            ? el('button', {
              type: 'button',
              class: 'btn ai-remove-custom',
              onClick: () => removeCustomProvider(provider),
            }, [icon('trash-2', 11), el('span', { text: 'Eliminar proveedor propio' })])
            : null,
        ]);
        bodyNodes.push(credBox);
      }

      // Selector de modelo
      const q = state.modelFilter.trim().toLowerCase();
      const filtered = state.models.filter((m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
      const modelOptions = filtered.length === 0
        ? [el('option', {
          value: selectedModel || '',
          text: selectedModel || (state.loadingModels ? 'Cargando modelos…' : 'Modelo por defecto'),
        })]
        : filtered.map((m) => el('option', {
          value: m.id,
          text: `${m.name}${m.free ? ' · Gratis' : ''}${m.ctx ? ` (${Math.round(m.ctx / 1000)}k)` : ''}`,
        }));

      const selectNode = el('select', {
        class: 'select',
        value: selectedModel,
        onChange: (e) => setModel(provider, e.target.value),
      }, modelOptions);
      selectNode.value = selectedModel;

      bodyNodes.push(el('div', { class: 'ai-model-box' }, [
        el('div', { class: 'ai-model-head' }, [
          el('strong', { text: 'Modelo' }),
          el('div', { class: 'ai-btn-row' }, [
            el('button', {
              type: 'button',
              class: 'icon-btn tiny',
              title: 'Actualizar catálogo de modelos',
              disabled: state.loadingModels,
              onClick: () => {
                forgetCatalog(provider);
                void syncCatalog(true);
              },
            }, icon('refresh-cw', 12)),
            el('button', {
              type: 'button',
              class: 'btn',
              disabled: state.probing || (!authed && !isCustom(provider)),
              text: state.probing ? 'Probando…' : 'Probar conexión',
              onClick: () => void testConnection(),
            }),
          ]),
        ]),
        state.models.length > 8
          ? el('input', {
            type: 'search',
            class: 'ai-model-filter',
            placeholder: 'Filtrar modelos…',
            value: state.modelFilter,
            onInput: (e) => { state.modelFilter = e.target.value; render(); },
          })
          : null,
        selectNode,
      ]));
    }

    if (state.statusText) {
      bodyNodes.push(el('p', {
        class: `ai-status-msg ${state.statusBad ? 'is-bad' : ''}`,
        text: state.statusText,
      }));
    }

    root.replaceChildren(...bodyNodes.filter(Boolean));
  }

  void probeServerKeys();
  const unsub1 = aiConfig.subscribe(() => render());
  const unsub2 = serverKeys.subscribe(() => render());
  render();

  root.dispose = () => {
    unsub1();
    unsub2();
    authAbort?.abort();
    catalogAbort?.abort();
    meAbort?.abort();
    clearTimeout(copyTimer);
  };
  return root;
}
