// `doctor` (C31): consume el catálogo de proveedores OAuth de Ghosty Studio (no tiene uno propio), detecta como la
// caja (grepPattern + codeHints + alias de env), dice la URL a registrar con consola y pasos, y prefiere lo que vio
// la preview del PR (`registered`). Sólo nombres: ningún valor del disco ni de gs sale en la salida.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectProviders, diagnose, doctorText, fetchCatalog, parseCatalog, parsePreviewOAuth } from '../src/doctor.mjs';

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
  const r = diagnose(d, { saved: ['GOOGLE_CLIENT_ID'], catalog: CAT });
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
  const ok = diagnose(d, { saved: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], catalog: CAT });
  assert.ok(ok.checks.every((c) => c.ok !== false));
  // La preview del PR ya vio un login por el proxy: registrado.
  const pv = parsePreviewOAuth({ redirectUri: URI, agentPrompt: 'Registra la URL en Google', providers: [{ id: 'google', name: 'Google', registered: true, consoleUrl: 'https://console.cloud.google.com/apis/credentials', steps: [], missingEnv: [] }] });
  const done = diagnose(d, { saved: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], catalog: CAT, previewOAuth: pv });
  assert.equal(done.checks.find((c) => c.name === 'oauth-google-registro').ok, true);
  // Sin catálogo: no se inventa nada.
  assert.equal(diagnose(d, { saved: [], catalog: null }).checks[1].ok, null);
  assert.equal(diagnose(repo({ 'package.json': {} }), { saved: [], catalog: CAT }).checks[1].detail, 'el repo no usa OAuth de un proveedor conocido');
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
  assert.match(c.detail, /FORMMY_MCP_TOKEN_SECRET, GHOSTY_PARTNER_KEY \(las lee este PR: FORMMY_MCP_TOKEN_SECRET\)/);
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
