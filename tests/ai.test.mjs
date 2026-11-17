/**
 * Pruebas unitarias e integracion del asistente IA multi-proveedor de ATOM:
 *  1) Backend compartible Node/Cloudflare (server/ai/*): target SSRF, vision y Anthropic
 *  2) Configuracion cliente y cabeceras (src/ai/config.js, wire.js)
 *  3) Agente compositor 3D (src/ai/atomAgent.js): extraccion JSON, poses reales Three.js y acciones
 *  4) Interfaz DOM (FloatingAI + AiSettings en jsdom)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const html = fs.readFileSync('index.html', 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { pretendToBeVisual: true, url: 'https://localhost/' });
const { window } = dom;
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLCanvasElement', 'Image',
  'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'PointerEvent',
  'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'Intl']) {
  if (window[k] === undefined) continue;
  try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch { /* noop */ }
}

const { readTarget, safeBase, BUILTIN_IDS } = await import('../server/ai/common.mjs');
const { toAnthropicBody, fromAnthropicReply } = await import('../server/ai/anthropic.mjs');
const { checkMessages, handleFreePiAd, handleHealth, runNodeHandler } = await import('../server/ai/handlers.mjs');
const { CONSENT_VERSION } = await import('../server/ai/freepiDevice.mjs');
const { isGravityUrl, sanitizeAd, ensureAdShown } = await import('../server/ai/freepiAds.mjs');
const { freepiHeaders } = await import('../server/ai/freepi.mjs');
const {
  aiConfig, setProvider, setKey, clearKey, browserKey,
  addCustomProvider, removeCustomProvider, providerIds,
} = await import('../src/ai/config.js');
const { wireProvider, aiHeaders } = await import('../src/ai/wire.js');
const {
  extractAtomActions, applyPoseRecipeToCharacter, executeAtomActions, buildOfflineQuickActions,
} = await import('../src/ai/atomAgent.js');
const { Settings } = await import('../src/core/Settings.js');
const { DEFAULTS, STORAGE_KEY } = await import('../src/config.js');
const { FloatingAI } = await import('../src/ui/FloatingAI.js');
const { buildAiSettingsControl } = await import('../src/ui/AiSettings.js');

let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}

await test('proveedores integrados y validacion SSRF en custom providers', async () => {
  assert.deepEqual(BUILTIN_IDS, ['freepi', 'openai', 'anthropic', 'openrouter', 'github', 'nvidia']);

  const anth = readTarget(new Headers(), 'anthropic', {});
  assert.equal(anth.ok, true);
  assert.equal(anth.target.format, 'anthropic');
  assert.equal(anth.target.keyHeader, 'x-api-key');

  assert.ok('error' in safeBase('http://127.0.0.1:11434/v1', 'public'));
  assert.ok('error' in safeBase('http://169.254.169.254/latest', 'public'));
  assert.deepEqual(safeBase('http://localhost:11434/v1', 'local'), { base: 'http://localhost:11434/v1' });
  assert.deepEqual(safeBase('https://api.deepseek.com/chat/completions', 'public'), { base: 'https://api.deepseek.com/v1' });
});

await test('checkMessages y traduccion Anthropic con imagenes/bocetos', async () => {
  const sampleDataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const checked = checkMessages([
    { role: 'system', content: 'Sistema ATOM' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Recrea este boceto' },
        { type: 'image_url', image_url: { url: sampleDataUri } },
      ],
    },
  ]);
  assert.ok('messages' in checked);
  assert.equal(checked.hasImage, true);
  assert.equal(checked.lastUserPrompt, 'Recrea este boceto');

  const body = toAnthropicBody('claude-sonnet-4-5', checked.messages, true);
  assert.equal(body.system, 'Sistema ATOM');
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].content[0].type, 'text');
  assert.equal(body.messages[0].content[1].type, 'image');
  assert.equal(body.messages[0].content[1].source.type, 'base64');
  assert.equal(body.messages[0].content[1].source.media_type, 'image/png');

  const reply = fromAnthropicReply({
    id: 'msg_1',
    model: 'claude-sonnet-4-5',
    stop_reason: 'end_turn',
    content: [{ type: 'thinking', text: 'interno' }, { type: 'text', text: 'Hecho.' }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  assert.equal(reply.choices[0].message.content, 'Hecho.');
});

await test('handleHealth expone estado de proveedores sin filtrar claves', async () => {
  const res = await handleHealth(new Request('https://localhost/api/health'), { OPENAI_API_KEY: 'sk-secret' });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.ai.providers.openai, true);
  assert.equal(data.ai.providers.anthropic, false);
  assert.equal(JSON.stringify(data).includes('sk-secret'), false);

  // runNodeHandler convierte IncomingMessage (cabeceras objeto plano) sin fallar
  const { Readable } = await import('node:stream');
  const fakeReq = Readable.from([]);
  fakeReq.method = 'GET';
  fakeReq.url = '/';
  fakeReq.headers = { host: 'localhost:5173', 'sec-fetch-site': 'same-origin' };
  let bodyOut = '';
  const fakeRes = {
    statusCode: 0,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    write(c) { bodyOut += Buffer.from(c).toString(); },
    end(c) { if (c) bodyOut += Buffer.from(c).toString(); },
  };
  await runNodeHandler(handleHealth, fakeReq, fakeRes, {});
  assert.equal(fakeRes.statusCode, 200);
  assert.equal(JSON.parse(bodyOut).ok, true);

  assert.equal(CONSENT_VERSION, '4');
  const fHdrs = await freepiHeaders('test-token');
  assert.ok(/^[0-9a-f-]{36}$/.test(fHdrs['x-session-id']));
  assert.ok(Boolean(fHdrs['x-client-version']));
});

await test('configuracion cliente, cabeceras y proveedores propios', async () => {
  setProvider('openai');
  setKey('openai', 'sk-test-123');
  assert.equal(browserKey('openai'), 'sk-test-123');
  assert.equal(aiHeaders('openai')['X-Ai-Key'], 'sk-test-123');
  assert.equal(wireProvider('openai'), 'openai');

  const customId = addCustomProvider({
    label: 'Ollama Local',
    baseUrl: 'http://localhost:11434/v1',
    format: 'openai',
  });
  assert.ok(providerIds().includes(customId));
  assert.equal(wireProvider(customId), 'custom');
  assert.equal(aiHeaders(customId)['X-Ai-Base'], 'http://localhost:11434/v1');

  removeCustomProvider(customId);
  clearKey('openai');
  setProvider('freepi');
  assert.equal(aiConfig.get().provider, 'freepi');
});

await test('poses anatomicas Three.js desde recetas en marco corporal', async () => {
  // Mini esqueleto en T-pose canonica: +Y arriba, +Z frente, +X brazo izq
  const root = new THREE.Group();
  const holder = new THREE.Group();
  root.add(holder);

  const mkBone = (name, x, y, z, parent) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, z);
    parent.add(b);
    return b;
  };
  const hips = mkBone('hips', 0, 1.0, 0, holder);
  const spine = mkBone('spine', 0, 0.2, 0, hips);
  const spine2 = mkBone('spine2', 0, 0.25, 0, spine);
  const head = mkBone('head', 0, 0.25, 0, spine2);
  const leftArm = mkBone('leftArm', 0.2, 0.15, 0, spine2);
  const leftForeArm = mkBone('leftForeArm', 0.3, 0, 0, leftArm);
  const leftHand = mkBone('leftHand', 0.28, 0, 0, leftForeArm);
  const rightArm = mkBone('rightArm', -0.2, 0.15, 0, spine2);
  const rightForeArm = mkBone('rightForeArm', -0.3, 0, 0, rightArm);
  const leftUpLeg = mkBone('leftUpLeg', 0.1, -0.05, 0, hips);
  const leftLeg = mkBone('leftLeg', 0, -0.42, 0, leftUpLeg);
  const leftFoot = mkBone('leftFoot', 0, -0.42, 0, leftLeg);

  root.updateMatrixWorld(true);
  const bones = {
    hips, spine, spine2, head,
    leftArm, leftForeArm, leftHand,
    rightArm, rightForeArm,
    leftUpLeg, leftLeg, leftFoot,
  };
  const rest = { local: new Map(), world: new Map(), position: new Map(), scale: new Map(), offset: new Map() };
  for (const b of Object.values(bones)) {
    rest.local.set(b, b.quaternion.clone());
    rest.offset.set(b, b.position.clone());
    rest.world.set(b, b.getWorldQuaternion(new THREE.Quaternion()));
  }
  const ch = {
    root,
    holder,
    bones,
    rest,
    restHipsLocal: hips.position.clone(),
    basis: new THREE.Quaternion(),
    sourceScale: 1,
    resetToRest() {
      for (const [b, q] of rest.local) b.quaternion.copy(q);
      for (const [b, p] of rest.offset) b.position.copy(p);
      hips.position.copy(this.restHipsLocal);
    },
  };

  const wPos = (node) => node.getWorldPosition(new THREE.Vector3());
  const handRestY = wPos(leftHand).y;
  const shoulderY = wPos(leftArm).y;
  assert.ok(Math.abs(handRestY - shoulderY) < 0.01, 'en T-pose la mano esta a altura del hombro');

  applyPoseRecipeToCharacter(ch, { preset: 'relajada' });
  const handRelaxedY = wPos(leftHand).y;
  assert.ok(handRelaxedY < shoulderY - 0.3, 'en pose relajada los brazos cuelgan hacia abajo');

  applyPoseRecipeToCharacter(ch, { preset: 'sentada' });
  const kneeSatZ = wPos(leftLeg).z;
  assert.ok(kneeSatZ > 0.25, 'en pose sentada la rodilla se adelanta hacia +Z');
  assert.ok(wPos(hips).y < 0.75, 'en pose sentada la cadera desciende');

  applyPoseRecipeToCharacter(ch, { preset: 't' });
  assert.ok(Math.abs(wPos(leftHand).y - shoulderY) < 0.01, 'pose t restaura T-pose');
});

await test('extractAtomActions y executeAtomActions componen escena completa', async () => {
  const sample = [
    'Te preparo una composición dramática con 2 figuras.',
    '<atom_actions>',
    JSON.stringify([
      { type: 'set_figure_count', count: 2 },
      { type: 'update_figure', figureIndex: 1, position: [-0.6, 0, 0], rotationY: 25 },
      { type: 'update_figure', figureIndex: 2, position: [0.6, 0, 0], rotationY: -25 },
      { type: 'add_object', kind: 'cubo', name: 'Pedestal', position: [0, 0.2, 0] },
      { type: 'set_lighting', preset: 'rembrandt' },
      { type: 'set_camera', view: 'picado', focalLength: 24, roll: -8 },
      { type: 'set_guides', perspective: { mode: '5puntos', warp: true }, heads: true },
      { type: 'set_stage', background: 'solido', bgColor: '#101216', grid: false },
      { type: 'set_appearance', variant: 'maniqui', shading: 'arcilla' },
    ]),
    '</atom_actions>',
  ].join('\n');

  const { cleanText, actions } = extractAtomActions(sample);
  assert.equal(cleanText, 'Te preparo una composición dramática con 2 figuras.');
  assert.equal(actions.length, 9);

  const settings = new Settings(DEFAULTS, STORAGE_KEY);
  let figSeq = 1;
  settings.set('scene.figures', [
    { id: 'f1', name: 'Figura 1', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, height: 1.75 },
  ]);
  settings.set('figure.active', 'f1');

  const mockFigures = {
    get defs() { return settings.get('scene.figures') ?? []; },
    get count() { return this.defs.length; },
    get activeId() { return settings.get('figure.active'); },
    setActive(id) { settings.set('figure.active', id); },
    locate(id) {
      const i = this.defs.findIndex((d) => d.id === id);
      return i < 0 ? null : { index: i, def: this.defs[i] };
    },
    get() { return null; },
    async add() {
      figSeq += 1;
      const id = `f${figSeq}`;
      settings.set('scene.figures', [...this.defs, {
        id, name: `Figura ${figSeq}`, position: { x: 0.7, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, height: 1.75,
      }]);
      return id;
    },
    remove(id) {
      const rest = this.defs.filter((d) => d.id !== id);
      settings.set('scene.figures', rest);
      return true;
    },
  };
  const mockScene = {
    addObject(kind) {
      const id = `obj-${Date.now()}`;
      settings.set('scene.objects', [...(settings.get('scene.objects') ?? []), {
        id, type: kind, name: kind, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, material: {},
      }]);
      return id;
    },
    locate(id) {
      const objs = settings.get('scene.objects') ?? [];
      const i = objs.findIndex((d) => d.id === id);
      return i >= 0 ? { branch: 'objects', index: i, def: objs[i] } : null;
    },
  };
  let lastView = '';
  let lastLightPreset = '';
  const app = {
    settings,
    figures: mockFigures,
    scene: mockScene,
    viewport: {
      cameras: { setView(v) { lastView = v; } },
      lighting: { setPreset(p) { lastLightPreset = p; } },
    },
  };

  const applied = await executeAtomActions(actions, app);
  assert.ok(applied.length >= 8);
  assert.equal(mockFigures.count, 2);
  assert.equal(settings.get('scene.figures')[0].position.x, -0.6);
  assert.equal(settings.get('scene.figures')[1].rotation.y, -25);
  assert.equal(settings.get('scene.objects')[0].name, 'Pedestal');
  assert.equal(lastLightPreset, 'rembrandt');
  assert.equal(lastView, 'picado');
  assert.equal(settings.get('camera.focalLength'), 24);
  assert.equal(settings.get('camera.roll'), -8);
  assert.equal(settings.get('guides.perspective.mode'), '5puntos');
  assert.equal(settings.get('guides.heads'), true);
  assert.equal(settings.get('stage.background'), 'solido');
  assert.equal(settings.get('figure.variant'), 'maniqui');
  assert.equal(settings.get('figure.shading'), 'arcilla');

  const offline = buildOfflineQuickActions('pon 3 figuras con luz lateral y perspectiva 4 puntos');
  assert.ok(offline && offline.actions.length >= 3);
});

await test('FloatingAI y AiSettings se montan e interactuan en DOM sin errores', async () => {
  const settings = new Settings(DEFAULTS, STORAGE_KEY);
  settings.set('scene.figures', [{ id: 'f1', name: 'Figura 1', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }]);
  settings.set('figure.active', 'f1');

  let openedSettings = false;
  let camView = '';
  const app = {
    settings,
    figures: {
      get defs() { return settings.get('scene.figures') ?? []; },
      get count() { return this.defs.length; },
      get activeId() { return settings.get('figure.active'); },
      async add() {
        const next = { id: 'f2', name: 'Figura 2', position: { x: 0.7, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };
        settings.set('scene.figures', [...this.defs, next]);
        return next.id;
      },
      remove() { return false; },
    },
    viewport: {
      cameras: { setView(v) { camView = v; } },
      lighting: { setPreset() {} },
    },
  };

  const floating = new FloatingAI(app, {
    mount: document.body,
    onOpenSettings: () => { openedSettings = true; },
  });
  const handle = document.querySelector('.atom-ai-handle');
  const pop = document.querySelector('.atom-ai-pop');
  assert.ok(handle, 'boton flotante montado');
  assert.ok(pop.classList.contains('hidden'), 'panel inicia cerrado');

  handle.click();
  assert.equal(pop.classList.contains('hidden'), false, 'clic en el orbe abre el panel');

  pop.querySelector('[title*="Configurar API"]').click();
  assert.equal(openedSettings, true, 'boton de engranaje abre Ajustes > IA');

  const textarea = pop.querySelector('textarea');
  textarea.value = 'pon 2 figuras en camara frente';
  textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  pop.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(settings.get('scene.figures').length, 2);
  assert.equal(camView, 'frente');
  assert.ok(pop.querySelector('.atom-ai-action-chip'), 'muestra chips de acciones aplicadas');

  const aiCfgUi = buildAiSettingsControl();
  document.body.appendChild(aiCfgUi);
  const provBtns = [...aiCfgUi.querySelectorAll('.ai-prov-btn')];
  assert.ok(provBtns.some((b) => b.textContent.includes('free-pi')));
  assert.ok(provBtns.some((b) => b.textContent.includes('OpenAI')));
  assert.ok(provBtns.some((b) => b.textContent.includes('Anthropic')));
  assert.ok(provBtns.some((b) => b.textContent.includes('OpenRouter')));
  assert.ok(provBtns.some((b) => b.textContent.includes('GitHub Copilot')));
  assert.ok(provBtns.some((b) => b.textContent.includes('NVIDIA')));

  provBtns.find((b) => b.textContent === 'OpenAI').click();
  assert.equal(aiConfig.get().provider, 'openai');

  floating.dispose();
  aiCfgUi.dispose?.();
  aiCfgUi.remove();
});

await test('el anuncio de free-pi funciona en segundo plano, sin mostrarse en ninguna parte', async () => {
  setProvider('freepi');
  setKey('freepi', 'fp-local-test');

  const settings = new Settings(DEFAULTS, STORAGE_KEY);
  const app = {
    settings,
    figures: {
      get defs() { return settings.get('scene.figures') ?? []; },
      get count() { return this.defs.length; },
      get activeId() { return settings.get('figure.active'); },
      async add() { return null; },
      remove() { return false; },
    },
    viewport: { cameras: { setView() {} }, lighting: { setPreset() {} } },
  };

  const floating = new FloatingAI(app, { mount: document.body });
  floating.toggle(true);
  floating.dispose();

  const ui = buildAiSettingsControl();
  document.body.appendChild(ui);
  await new Promise((r) => setTimeout(r, 30));

  // Ni en el chat ni en Ajustes: no hay tarjeta, ni linea, ni boton de anuncio.
  assert.equal(document.querySelectorAll('.atom-ai-ad, .ai-ad-line, .ai-ad-card').length, 0,
    'no se pinta ningun cuadro de anuncio');
  assert.ok(ui.textContent.includes('free-pi'), 'la configuracion de free-pi sigue visible');

  ui.dispose?.();
  ui.remove();

  clearKey('freepi');
  setProvider('openai');
});

await test('free-pi ads: validacion de creativos, pixels gravity y handleFreePiAd', async () => {
  assert.equal(isGravityUrl('https://pixel.trygravity.ai/imp?id=1'), true);
  assert.equal(isGravityUrl('https://trygravity.com/track'), true);
  assert.equal(isGravityUrl('http://trygravity.ai/imp'), false);
  assert.equal(isGravityUrl('https://evil.example/imp'), false);

  const clean = sanitizeAd({
    ad_id: 'ad-1',
    click_token: 'tok-1',
    source: 'gravity',
    click_url: 'javascript:alert(1)',
    imp_url: 'https://pixel.trygravity.ai/imp?t=1',
    creative: { headline: 'Tool', body: 'Desc', cta: 'Abrir' },
  });
  assert.equal(clean.ad_id, 'ad-1');
  assert.equal(clean.click_url, '');
  assert.equal(clean.imp_url, 'https://pixel.trygravity.ai/imp?t=1');

  const noKey = await handleFreePiAd(new Request('https://localhost/api/freepi-ad', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'next' }),
  }), {});
  assert.equal(noKey.status, 401);

  const badAd = await handleFreePiAd(new Request('https://localhost/api/freepi-ad', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ai-Key': 'fp-test' },
    body: JSON.stringify({ action: 'impression', ad: {} }),
  }), {});
  assert.equal(badAd.status, 400);
});

await test('free-pi ads: la impresión se pide y se reporta sola (camino automático)', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (u.includes('/ads/next')) {
      return json({
        ad_id: 'ad-9',
        click_token: 'tok-9',
        source: 'own',
        click_url: 'https://example.test/ad',
        creative: { headline: 'H', body: 'B', cta: 'Ir' },
      });
    }
    if (u.includes('/ads/impression')) return json({ ok: true });
    return json({ message: 'no esperado' }, 500);
  };

  try {
    const shown = await ensureAdShown('fp-test');
    assert.equal(shown.reported, true);
    assert.equal(shown.ad.ad_id, 'ad-9');
    const imp = calls.find((c) => c.url.includes('/ads/impression'));
    assert.equal(imp.method, 'POST');
    assert.equal(imp.body.ad_id, 'ad-9');
    assert.equal(imp.body.click_token, 'tok-9');

    // 204 = el backend no tiene anuncio para ese hueco: no hay nada que reportar.
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const none = await ensureAdShown('fp-test');
    assert.equal(none.noAd, true);
    assert.equal(none.reported, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log(`\nai.test.mjs: ${passed} comprobaciones superadas`);
