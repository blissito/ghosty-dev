// `doctor` (C31): consume el catálogo de proveedores OAuth de Ghosty Studio (no tiene uno propio), detecta como la
// caja (grepPattern + codeHints + alias de env), dice la URL a registrar con consola y pasos, y prefiere lo que vio
// la preview del PR (`registered`). Sólo nombres: ningún valor del disco ni de gs sale en la salida.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectProviders, diagnose, doctorText, factoryPartner, fetchCatalog, parseCatalog, parsePreviewOAuth, partnerAgentRefs, partnerAgentsCheck, probeProviders } from '../src/doctor.mjs';

const URI = 'https://www.ghosty.studio/preview-oauth/callback';
// Forma real de GET /api/v2/preview-oauth/providers (recortada a dos proveedores).
const RAW = {
  redirectUri: URI,
  env: { redirectUri: 'GS_PREVIEW_OAUTH_REDIRECT_URI', stateKey: 'GS_PREVIEW_OAUTH_STATE_KEY', host: 'PREVIEW_HOST' },
  grepPattern: 'accounts\\.google\\.com|remix-auth-google|GoogleStrategy|@shopify/shopify-api|admin/oauth/authorize|\\b(GOOGLE_CLIENT_ID|GOOGLE_ID|GOOGLE_CLIENT_SECRET|GOOGLE_SECRET|SHOPIFY_API_KEY|SHOPIFY_API_SECRET)\\b',
  providers: [
    { id: 'google', name: 'Google', codeHints: ['accounts\\.google\\.com', 'remix-auth-google', 'GoogleStrategy'], env: [['GOOGLE_CLIENT_ID', 'GOOGLE_ID'], ['GOOGLE_CLIENT_SECRET', 'GOOGLE_SECRET']], consoleUrl: 'https://console.cloud.google.com/apis/credentials', steps: ['Abre la consola.', 'Abre tu cliente OAuth.', 'Agrega {uri} y guarda.'] },
    { id: 'shopify', name: 'Shopify', codeHints: ['@shopify/shopify-api', 'admin/oauth/authorize'], env: [['SHOPIFY_API_KEY'], ['SHOPIFY_API_SECRET']], consoleUrl: 'https://partners.shopify.com', steps: ['a', 'b', 'Agrega {uri}.'], signsCallback: true },
    { id: 'roto', name: 'Roto', codeHints: ['(['], env: [], consoleUrl: 'http://inseguro', steps: [] },
  ],
  helperJs: 'export function previewOAuthState() {}',
  docs: 'https://www.ghosty.studio/docs/fabrica/oauth-en-previews',
};
const CAT = parseCatalog(RAW);

const repo = (files) => {
  const d = mkdtempSync(join(tmpdir(), 'doctor-'));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(d, f, '..'), { recursive: true });
    writeFileSync(join(d, f), typeof text === 'string' ? text : JSON.stringify(text));
  }
  return d;
};

test('el catálogo se valida: pistas que no compilan y URLs no https fuera (C31)', () => {
  assert.deepEqual(CAT.providers.map((p) => p.id), ['google', 'shopify']);
  assert.equal(CAT.redirectUri, URI);
  assert.equal(parseCatalog({ grepPattern: '([', providers: [] }), null);
  assert.equal(parseCatalog(null), null);
});

test('detecta como la caja: pista de código → proveedor; alias citado sin ninguno en el env → falta (C31)', () => {
  const tokens = ['GoogleStrategy', 'GOOGLE_ID', 'GOOGLE_CLIENT_SECRET'];
  const [g] = detectProviders(CAT, tokens, ['GOOGLE_CLIENT_ID']);
  assert.deepEqual([g.id, g.missingEnv, g.steps[2]], ['google', ['GOOGLE_CLIENT_SECRET'], `Agrega ${URI} y guarda.`]); // GOOGLE_ID cubierto por su alias
  assert.deepEqual(detectProviders(CAT, ['GOOGLE_CLIENT_ID'], []), []); // sólo la variable no basta: hace falta la pista
  assert.equal(detectProviders(CAT, tokens, null)[0].missingEnv, null); // sin env: no se sabe
});

test('diagnose: llaves faltantes, registro con URL para copiar + consola + 3 pasos + ghosty-browser, callback sin proxy; node_modules fuera (C31)', () => {
  const d = repo({
    'package.json': { dependencies: { 'remix-auth-google': '^2' } },
    'app/auth.server.ts': 'new GoogleStrategy({ clientID: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET })',
    'node_modules/x/i.js': 'admin/oauth/authorize SHOPIFY_API_KEY',
  });
  // Sin poder saber si está registrado no se avisa del registro; con el proveedor rechazando el callback, sí.
  assert.ok(!diagnose(d, { saved: ['GOOGLE_CLIENT_ID'], catalog: CAT }).checks.some((c) => c.name === 'oauth-google-registro'));
  assert.equal(diagnose(d, { saved: ['GOOGLE_CLIENT_ID'], catalog: CAT, probes: { google: true } }).checks.find((c) => c.name === 'oauth-google-registro').ok, true);
  const r = diagnose(d, { saved: ['GOOGLE_CLIENT_ID'], catalog: CAT, probes: { google: false } });
  // Fila 47: sin llaves en la preview, OAuth es aviso (no MAL) y el camino recomendado es la identidad de Ghosty.
  assert.deepEqual(r.checks.map((c) => [c.name, c.ok]), [['lock', true], ['oauth-google-llaves', null], ['oauth-google-registro', null], ['oauth-callback', null]]);
  assert.match(r.checks[1].fix, /^primero la identidad de Ghosty .*cliente OAuth APARTE sólo para previews .*nunca el de producción/);
  const reg = r.checks[2];
  assert.equal(reg.detail, 'Sólo si usas OAuth en previews (mejor: la identidad de Ghosty): registra esta URL en un cliente de Google APARTE para previews, nunca en el de producción');
  assert.deepEqual([reg.copy, reg.consoleUrl, reg.steps.length], [URI, 'https://console.cloud.google.com/apis/credentials', 3]);
  assert.match(reg.fix, /pídeselo a Ghosty con ghosty-browser/);
  const text = doctorText({ repo: 'acme/demo', ...r });
  assert.match(text, new RegExp(`\\n\\n {6}${URI.replace(/[./]/g, '\\$&')}\\n\\n {6}consola: https://console\\.cloud\\.google\\.com/apis/credentials\\n {6}1\\. Abre la consola\\.`));
  assert.match(text, / ! {2}oauth-google-llaves: Google: a la vista previa le faltan GOOGLE_CLIENT_SECRET\. No copies ahí el secreto de producción/);
  // Con las llaves puestas (se quiere OAuth en previews) y sin el proxy, el callback sí es MAL.
  assert.equal(diagnose(d, { saved: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], catalog: CAT }).checks.find((c) => c.name === 'oauth-callback').ok, false);
  // Con el proxy en el código y las llaves: sólo queda el registro (aviso, no falla).
  writeFileSync(join(d, 'app/auth.server.ts'), 'new GoogleStrategy({ clientID: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, callbackURL: process.env.GS_PREVIEW_OAUTH_REDIRECT_URI })');
  const ok = diagnose(d, { saved: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], catalog: CAT, probes: { google: false } });
  assert.ok(ok.checks.every((c) => c.ok !== false));
  // La preview del PR ya vio un login por el proxy: registrado.
  const pv = parsePreviewOAuth({ redirectUri: URI, agentPrompt: 'Registra la URL en Google', providers: [{ id: 'google', name: 'Google', registered: true, consoleUrl: 'https://console.cloud.google.com/apis/credentials', steps: [], missingEnv: [] }] });
  const done = diagnose(d, { saved: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], catalog: CAT, previewOAuth: pv });
  assert.equal(done.checks.find((c) => c.name === 'oauth-google-registro').ok, true);
  // Sin catálogo: no se inventa nada.
  assert.equal(diagnose(d, { saved: [], catalog: null }).checks[1].ok, null);
  assert.equal(diagnose(repo({ 'package.json': {} }), { saved: [], catalog: CAT }).checks[1].detail, 'la app no inicia sesión con OAuth de un proveedor conocido');
});

test('fetchCatalog baja el catálogo público de gs sin sesión y sin seguir redirecciones (C31)', async () => {
  let seen;
  const fake = async (url, init) => {
    seen = { url, init };
    return { ok: true, json: async () => RAW };
  };
  const c = await fetchCatalog({ fetchImpl: fake });
  assert.equal(seen.url, 'https://www.ghosty.studio/api/v2/preview-oauth/providers');
  assert.equal(seen.init.redirect, 'error');
  assert.equal(seen.init.headers, undefined); // sin Authorization
  assert.equal(c.providers.length, 2);
  assert.equal(await fetchCatalog({ fetchImpl: async () => ({ ok: false }) }), null);
});

test('doctor sugiere la identidad de Ghosty en previews si la app tiene login y no la lee (Formmy, fila 40)', () => {
  const sin = diagnose(repo({ 'package.json': {}, 'app/session.server.ts': 'export const { getSession, commitSession } = createCookieSessionStorage({})' }), { catalog: null });
  const c = sin.checks.find((x) => x.name === 'login-en-previews');
  assert.equal(c.ok, null);
  assert.match(c.fix, /Login en previews/);
  const con = diagnose(repo({ 'package.json': {}, 'app/session.server.ts': 'getSession(); const jwks = process.env.GS_PREVIEW_IDENTITY_JWKS_URL' }), { catalog: null });
  assert.equal(con.checks.find((x) => x.name === 'login-en-previews').ok, true);
  assert.equal(diagnose(repo({ 'package.json': {} }), { catalog: null }).checks.find((x) => x.name === 'login-en-previews'), undefined);
});

test('doctor: variables faltantes de la preview del PR → check env-faltantes con nombres y sin valores', async () => {
  const { missingEnvCheck } = await import('../src/doctor.mjs');
  assert.equal(missingEnvCheck(null), null);
  assert.equal(missingEnvCheck([]).ok, true);
  const c = missingEnvCheck(['FORMMY_MCP_TOKEN_SECRET', 'GHOSTY_PARTNER_KEY'], ['FORMMY_MCP_TOKEN_SECRET']);
  assert.equal(c.name, 'env-faltantes');
  assert.equal(c.ok, false);
  assert.match(c.detail, /faltan 2 que usa este PR o el arranque: FORMMY_MCP_TOKEN_SECRET, GHOSTY_PARTNER_KEY/); // sin prioridad (gs viejo): todas cuentan
  assert.match(c.fix, /ghosty-dev env push/);
  const d = diagnose(repo({ 'app/x.ts': 'export const x = 1;\n' }), { catalog: CAT, previewMissingEnv: ['FOO_SECRET'] });
  assert.equal(d.checks.find((k) => k.name === 'env-faltantes').ok, false);
});

test('doctor: llave de partner sin token de caja → partner-en-previews sugiere la receta; con token, la llave deja de faltar', async () => {
  const sin = diagnose(repo({ 'package.json': {}, 'server/b.ts': 'const k = process.env.GHOSTY_PARTNER_KEY;' }), { catalog: null, previewMissingEnv: ['GHOSTY_PARTNER_KEY', 'GHOSTY_PARTNER_KEY_SECRET'] });
  const c = sin.checks.find((x) => x.name === 'partner-en-previews');
  assert.equal(c.ok, null);
  assert.match(c.fix, /GHOSTY_PREVIEW_TOKEN/);
  assert.equal(sin.checks.find((x) => x.name === 'env-faltantes').ok, false);
  const con = diagnose(repo({ 'package.json': {}, 'server/b.ts': 'const k = process.env.GHOSTY_PARTNER_KEY || process.env.GHOSTY_PREVIEW_TOKEN;' }), { catalog: null, previewMissingEnv: ['GHOSTY_PARTNER_KEY', 'GHOSTY_PARTNER_KEY_SECRET'] });
  assert.equal(con.checks.find((x) => x.name === 'partner-en-previews').ok, true);
  assert.equal(con.checks.find((x) => x.name === 'env-faltantes').ok, true);
  assert.equal(diagnose(repo({ 'package.json': {} }), { catalog: null }).checks.find((x) => x.name === 'partner-en-previews'), undefined);
});

test('envNames: sólo nombres de variable válidos', async () => {
  const { envNames } = await import('../src/preview.mjs');
  assert.deepEqual(envNames(['A_B', 'A_B', 'mal valor', 'x=1', 3, 'OK']), ['A_B', 'OK']);
  assert.equal(envNames(undefined), null);
});

test('doctor: la identidad de Ghosty va primero; adoptada, OAuth deja de pedir llaves; base de la preview (filas 43 y 47)', () => {
  const d = repo({
    'package.json': { dependencies: { 'remix-auth-google': '^2' } },
    'app/auth.server.ts': 'new GoogleStrategy({ clientID: process.env.GOOGLE_CLIENT_ID }); createCookieSessionStorage({})',
  });
  let r = diagnose(d, { saved: ['DATABASE_URL', 'MONGO_ATLAS_URI'], catalog: CAT });
  assert.deepEqual(r.checks.slice(0, 3).map((c) => c.name), ['lock', 'login-en-previews', 'base-de-la-preview']);
  assert.match(r.checks[1].detail, /camino recomendado: sin OAuth/);
  assert.match(r.checks[2].detail, /DATABASE_URL, MONGO_ATLAS_URI/);
  assert.match(r.checks[2].fix, /base desechable .*nunca la URL de producción/);
  // Adoptada la identidad: un solo renglón de OAuth en verde, sin llaves ni registro ni callback.
  writeFileSync(join(d, 'app/preview-identity.server.js'), 'const JWKS_URL = process.env.GS_PREVIEW_IDENTITY_JWKS_URL;');
  r = diagnose(d, { saved: ['GOOGLE_CLIENT_ID'], catalog: CAT });
  assert.deepEqual(r.checks.map((c) => [c.name, c.ok]), [['lock', true], ['login-en-previews', true], ['oauth', true]]);
  assert.match(r.checks[2].detail, /no hace falta, la app entra con la identidad de Ghosty/);
  assert.ok(r.checks.every((c) => c.ok !== false));
});

test('sólo proveedores de LOGIN: Shopify de tienda y el diálogo de Facebook no se avisan (Formmy)', () => {
  const cat = parseCatalog({
    grepPattern: 'GoogleStrategy|admin/oauth/authorize|facebook\\.com/v[0-9.]+/dialog/oauth',
    redirectUri: URI,
    providers: [
      { id: 'google', name: 'Google', codeHints: ['GoogleStrategy'], loginHints: ['GoogleStrategy'], probe: 'google', env: [['GOOGLE_CLIENT_ID']], consoleUrl: 'https://console.cloud.google.com/apis/credentials', steps: [] },
      { id: 'shopify', name: 'Shopify', codeHints: ['admin/oauth/authorize'], loginHints: [], env: [], consoleUrl: 'https://partners.shopify.com', steps: [] },
      { id: 'facebook', name: 'Facebook', codeHints: ['facebook\\.com/v[0-9.]+/dialog/oauth'], loginHints: ['FacebookStrategy'], env: [], consoleUrl: 'https://developers.facebook.com/apps', steps: [] },
    ],
  });
  const d = repo({ 'package.json': {}, 'a.ts': 'GoogleStrategy admin/oauth/authorize https://www.facebook.com/v19.0/dialog/oauth' });
  const names = diagnose(d, { saved: ['GOOGLE_CLIENT_ID'], catalog: cat, probes: { google: true } }).checks.map((c) => c.name);
  assert.ok(names.includes('oauth-google-registro'));
  assert.ok(!names.some((n) => n.includes('shopify') || n.includes('facebook')));
});

test('probeProviders: lee sólo el client id del .env y pregunta a gs', async () => {
  const cat = parseCatalog({ grepPattern: 'GoogleStrategy', redirectUri: URI, providers: [{ id: 'google', name: 'Google', codeHints: ['GoogleStrategy'], loginHints: ['GoogleStrategy'], probe: 'google', env: [['GOOGLE_CLIENT_ID'], ['GOOGLE_CLIENT_SECRET']], consoleUrl: 'https://x.test', steps: [] }] });
  const d = repo({ 'package.json': {}, 'a.ts': 'GoogleStrategy', '.env': 'GOOGLE_CLIENT_ID=123-abc.apps.googleusercontent.com\nGOOGLE_CLIENT_SECRET=shh' });
  const seen = [];
  const out = await probeProviders(d, cat, { fetchImpl: async (u) => { seen.push(String(u)); return { ok: true, json: async () => ({ registered: true }) }; } });
  assert.deepEqual(out, { google: true });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /provider=google&client_id=123-abc\.apps\.googleusercontent\.com$/);
  assert.ok(!seen[0].includes('shh'));
});

test('doctor: env-faltantes falla sólo por las prioritarias (PR o arranque); el resto es informativo', async () => {
  const { missingEnvCheck } = await import('../src/doctor.mjs');
  const c = missingEnvCheck(['A_PR', 'B_BOOT', 'C', 'D'], ['A_PR'], ['A_PR', 'B_BOOT']);
  assert.equal(c.ok, false);
  assert.match(c.detail, /faltan 2 que usa este PR o el arranque: A_PR, B_BOOT · y 2 más del resto de la app/);
  const info = missingEnvCheck(['C', 'D'], [], []);
  assert.equal(info.ok, null);
  assert.match(info.detail, /^informativo: faltan 2 del resto de la app/);
});

test('agentes de partner: el código llama a uno que no existe → MAL con el comando para crearlo (fila 50)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-pa-'));
  mkdirSync(join(dir, 'app', 'routes', '__tests__'), { recursive: true });
  mkdirSync(join(dir, '.ghosty'));
  writeFileSync(join(dir, 'app', 'routes', 'api.crear.agui.ts'), 'const AGENT = () => process.env.GHOSTY_CREAR_AGENT ?? "crear";\nfetch(`${BASE}/api/v2/partner/agui`, { body: JSON.stringify({ agent: AGENT() }) });\n');
  writeFileSync(join(dir, 'app', 'routes', '__tests__', 'x.test.ts'), 'fetch("/api/v2/partner/turns", { agent: "otro" })\n');
  writeFileSync(join(dir, 'app', 'routes', 'menu.tsx'), 'const agentName = "ventas"; // no llama a la API de partner\n');
  writeFileSync(join(dir, '.ghosty', 'factory.md'), '---\npartner: formmy\n---\n');
  const refs = partnerAgentRefs(dir);
  assert.deepEqual(refs, [{ slug: 'crear', file: 'app/routes/api.crear.agui.ts' }]);
  assert.equal(factoryPartner(dir), 'formmy');
  const missing = partnerAgentsCheck(refs, { partners: [{ workspace: 'formmy', disabled: false, agents: [null, 'otro'] }, { workspace: 'mailmask', disabled: false, agents: ['crear'] }] }, 'formmy');
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /«crear» \(app\/routes\/api\.crear\.agui\.ts\) y no existe en formmy/);
  assert.match(missing.fix, /partner agent apply --workspace formmy --agent crear --prompt-file ghosty\/agents\/crear\.md --mcp .* --dry-run/);
  assert.equal(partnerAgentsCheck(refs, { partners: [{ workspace: 'formmy', disabled: false, agents: ['crear'] }] }, 'formmy').ok, true);
  assert.equal(partnerAgentsCheck(refs, null).ok, null);
  assert.equal(partnerAgentsCheck(refs, { partners: [] }).ok, false);
  assert.equal(partnerAgentsCheck([], null), null);
  // diagnose lo suma con lo que contestó gs.
  const r = diagnose(dir, { partnerAgents: { partners: [{ workspace: 'formmy', disabled: false, agents: [] }] } });
  assert.equal(r.checks.find((c) => c.name === 'agentes-de-partner').ok, false);
});

test('doctor: la prueba real de login (filas 53–54) — ok con sesión, MAL sin ella, sin probar en ruta pública', async () => {
  const { loginProbeCheck } = await import('../src/doctor.mjs');
  assert.equal(loginProbeCheck(null), null);
  const ok = loginProbeCheck({ pr: 101, verdict: 'session', path: '/dashboard', message: 'con identidad /dashboard responde 200; sin ella, 302 → /' });
  assert.equal(ok.name, 'login-en-previews-de-verdad');
  assert.equal(ok.ok, true);
  const bad = loginProbeCheck({ pr: 101, verdict: 'no_session', path: '/dashboard/chat', message: 'la app no aceptó X-Ghosty-Identity' });
  assert.equal(bad.ok, false);
  assert.match(bad.fix, /ghosty-dev preview 101 --login --check --path \/dashboard\/chat/);
  assert.equal(loginProbeCheck({ pr: 1, verdict: 'public_path', path: '/', message: 'x' }).ok, null);
});

test('doctor: login_path de .ghosty/factory.md, si no /dashboard', async () => {
  const { loginPathOf } = await import('../src/doctor.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'gd-login-'));
  assert.equal(loginPathOf(dir), '/dashboard');
  mkdirSync(join(dir, '.ghosty'));
  writeFileSync(join(dir, '.ghosty', 'factory.md'), '---\nmemory: 4gb\nlogin_path: /dashboard/chat\n---\n# x\n');
  assert.equal(loginPathOf(dir), '/dashboard/chat');
});

test('doctor: Formmy fila 61 — el recorrido completo (entrar, cerrar sesión, no se reabre, volver a entrar) y logout:/relogin: de factory.md', async () => {
  const { loginProbeCheck, loginFlowOf } = await import('../src/doctor.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const step = (name, ok, detail = 'x') => ({ name, ok, detail });
  const all = loginProbeCheck({ pr: 101, verdict: 'session', path: '/dashboard', flow: 'ok', steps: [step('enter', true), step('logout', true), step('stays_out', true), step('reenter', true), step('no_identity', true)] });
  assert.equal(all.ok, true);
  assert.match(all.detail, /entrar ok · cerrar sesión ok · no se reabre ok · volver a entrar ok · sin identidad ok/);
  const reopens = loginProbeCheck({ pr: 101, verdict: 'session', path: '/dashboard', flow: 'failed', steps: [step('enter', true), step('logout', true), step('stays_out', false, 'se reabre sola')] });
  assert.equal(reopens.ok, false);
  assert.match(reopens.detail, /no se reabre MAL\. se reabre sola/);
  assert.match(reopens.fix, /preview_logged_out/);
  const half = loginProbeCheck({ pr: 101, verdict: 'session', path: '/dashboard', flow: 'untested', steps: [step('enter', true), step('logout', null)] });
  assert.equal(half.ok, null);
  assert.match(half.fix, /logout: POST \/api\/login intent=logout/);
  const dir = mkdtempSync(join(tmpdir(), 'gd-flow-'));
  assert.deepEqual(loginFlowOf(dir), { logout: null, relogin: null });
  mkdirSync(join(dir, '.ghosty'));
  writeFileSync(join(dir, '.ghosty', 'factory.md'), '---\nlogin_path: /dashboard\nlogout: POST /api/login intent=logout\nrelogin: "/api/login intent=ghosty-login"\n---\n');
  assert.deepEqual(loginFlowOf(dir), { logout: 'POST /api/login intent=logout', relogin: 'POST /api/login intent=ghosty-login' });
});
