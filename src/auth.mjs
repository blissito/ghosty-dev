// Identidad de persona en Ghosty Studio, sólo para lo que GitHub no cubre: las variables (secretos) de la vista
// previa. GitHub sigue siendo `gh`; su token nunca viaja a Ghosty. SPEC §8.
//
// OAuth2 estándar contra gs, cliente público `ghosty-dev` (sin secreto), scope `profile repo:env`:
// - con navegador en esta máquina: loopback RFC 8252 (http://127.0.0.1:<puerto>/cb) + PKCE S256 + state;
// - sin navegador (SSH, CI, Linux sin pantalla) o con --device: device flow RFC 8628.
// Endpoints por metadata RFC 8414 (/.well-known/oauth-authorization-server). La sesión vive en
// ${XDG_CONFIG_HOME:-~/.config}/ghosty-dev/auth.json (0600). GHOSTY_DEV_TOKEN manda sobre el archivo (CI).
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const CLIENT_ID = 'ghosty-dev';
export const SCOPE = 'profile repo:env';
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const USER_AGENT = `ghosty-dev/${VERSION}`;

export class AuthError extends Error {}

export const baseUrl = () => (process.env.GHOSTY_DEV_BASE_URL || 'https://www.ghosty.studio').replace(/\/+$/, '');

// ---------- almacenamiento ----------

export const authPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'ghosty-dev', 'auth.json');

export function readAuth() {
  try {
    return JSON.parse(readFileSync(authPath(), 'utf8'));
  } catch {
    return null;
  }
}

const writeAuth = (data) => writeSecret(authPath(), data);

function writeSecret(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600); // por si el archivo ya existía con otro modo
}

const clearAuth = () => rmSync(authPath(), { force: true });

// ---------- metadata (RFC 8414) ----------

async function endpoints(base) {
  let meta = {};
  try {
    const res = await fetch(`${base}/.well-known/oauth-authorization-server`, { headers: { 'user-agent': USER_AGENT } });
    if (res.ok) meta = await res.json();
  } catch {}
  return {
    authorize: meta.authorization_endpoint || `${base}/oauth2/authorize`,
    token: meta.token_endpoint || `${base}/oauth2/token`,
    device: meta.device_authorization_endpoint || `${base}/oauth2/device`,
    revoke: meta.revocation_endpoint || `${base}/oauth2/revoke`,
  };
}

const form = (url, fields) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': USER_AGENT },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...fields }),
  });

async function jsonOf(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

// Lo que se guarda de una respuesta del token endpoint. Nunca se imprime.
function session(base, tok, prev = {}) {
  return {
    baseUrl: base,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? prev.refreshToken ?? null,
    expiresAt: Date.now() + (Number(tok.expires_in) || 3600) * 1000,
    scope: tok.scope ?? prev.scope ?? SCOPE,
    email: prev.email ?? null,
  };
}

// ---------- login ----------

// ¿Hay un navegador en ESTA máquina? Por SSH, en CI o en un Linux sin pantalla, no: ahí el loopback nunca
// recibiría el regreso y se usa el device flow.
export function hasLocalBrowser(env = process.env, platform = process.platform) {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.CI) return false;
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return true;
}

function openBrowser(url) {
  if (process.env.GHOSTY_DEV_NO_OPEN) return;
  const [bin, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try {
    spawn(bin, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}

const b64url = (buf) => buf.toString('base64url');

const CLOSE_PAGE = (ok) => `<!doctype html><html lang="es"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>ghosty-dev</title>
<body style="font-family:system-ui,sans-serif;background:#F4F5FB;color:#191A20;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px">
<div style="text-align:center;max-width:420px"><h1 style="font-size:26px;margin:0 0 8px">${ok ? '¡Listo, ya entraste!' : 'No se pudo entrar'}</h1>
<p style="margin:0;color:#4b4d57;line-height:1.5">${ok ? 'Ya puedes cerrar esta pestaña y volver a la terminal.' : 'Vuelve a la terminal y corre <code>ghosty-dev login</code> otra vez.'}</p></div>`;

// Loopback RFC 8252 + PKCE S256 + state. `onPrompt` recibe {method, url} para que el CLI lo imprima.
async function loginLoopback(base, ep, onPrompt) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  let redirectUri = '';
  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (u.pathname !== '/cb') {
        res.writeHead(404).end();
        return;
      }
      // Un regreso con otro state no es nuestro (CSRF): se rechaza y se sigue esperando el bueno.
      if (u.searchParams.get('state') !== state) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(CLOSE_PAGE(false));
        return;
      }
      const got = u.searchParams.get('code');
      res.writeHead(got ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' }).end(CLOSE_PAGE(!!got));
      clearTimeout(timer);
      server.close();
      if (got) resolve(got);
      else reject(new AuthError(`No se completó el inicio de sesión (${u.searchParams.get('error') ?? 'sin código'}). Siguiente paso: ghosty-dev login --no-wait`));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new AuthError('El inicio de sesión caducó a los 5 minutos. Siguiente paso: ghosty-dev login --no-wait'));
    }, LOGIN_TIMEOUT_MS);
    server.on('error', (e) => {
      clearTimeout(timer);
      reject(new AuthError(`No se pudo abrir el puerto local para el regreso (${e.code ?? e.message}). Prueba: ghosty-dev login --device`));
    });
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${server.address().port}/cb`;
      const url = `${ep.authorize}?${new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
        scope: SCOPE,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })}`;
      onPrompt({ method: 'loopback', url });
      openBrowser(url);
    });
  });
  const res = await form(ep.token, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
  const tok = await jsonOf(res);
  if (!res.ok || !tok.access_token) throw new AuthError(`Falló el inicio de sesión (${tok.error ?? res.status}). Siguiente paso: ghosty-dev login --no-wait`);
  return tok;
}

// Device flow RFC 8628: la persona abre la liga en cualquier dispositivo y confirma el código; aquí se sondea.
// En dos pasos para un agente (timeouts de ~2 min, no ve stdout hasta que termina): `login --no-wait` pide el
// código, lo guarda en pending-login.json (0600) y sale; `login --wait` retoma y sondea con tope. SPEC §8.
// GHOSTY_DEV_POLL_UNIT_MS cambia la unidad del intervalo (los tests la bajan).
const AGAIN = 'Corre ghosty-dev login --no-wait otra vez.';
export const PENDING_EXIT = 75; // EX_TEMPFAIL: sigue pendiente, vuelve a intentar

export const pendingPath = () => join(dirname(authPath()), 'pending-login.json');
function readPending() {
  try {
    return JSON.parse(readFileSync(pendingPath(), 'utf8'));
  } catch {
    return null;
  }
}
const clearPending = () => rmSync(pendingPath(), { force: true });

async function startDevice(ep) {
  const res = await form(ep.device, { scope: SCOPE });
  const d = await jsonOf(res);
  if (!res.ok || !d.device_code) throw new AuthError(`No se pudo iniciar el inicio de sesión (${d.error ?? res.status}).`);
  const pending = {
    deviceCode: d.device_code,
    userCode: d.user_code,
    verificationUri: d.verification_uri,
    verificationUriComplete: d.verification_uri_complete || d.verification_uri,
    interval: Number(d.interval ?? 5),
    expiresAt: Date.now() + (Number(d.expires_in) || 600) * 1000,
  };
  writeSecret(pendingPath(), pending);
  return pending;
}

// Sondea hasta tener tokens, o hasta `until` (devuelve null: sigue pendiente). El intervalo nuevo tras slow_down
// se guarda en el pendiente, para que el siguiente `--wait` lo respete.
async function pollDevice(ep, pending, until = Infinity) {
  const unit = Number(process.env.GHOSTY_DEV_POLL_UNIT_MS ?? 1000);
  for (;;) {
    if (Date.now() >= pending.expiresAt) {
      clearPending();
      throw new AuthError(`El código caducó antes de confirmarse. ${AGAIN}`);
    }
    if (Date.now() + pending.interval * unit > until) return null;
    await new Promise((r) => setTimeout(r, pending.interval * unit));
    const r = await form(ep.token, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: pending.deviceCode });
    const body = await jsonOf(r);
    if (r.ok && body.access_token) {
      clearPending();
      return body;
    }
    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') {
      pending.interval += 5; // RFC 8628 §3.5
      writeSecret(pendingPath(), pending);
      continue;
    }
    clearPending();
    if (body.error === 'expired_token') throw new AuthError(`El código caducó antes de confirmarse. ${AGAIN}`);
    if (body.error === 'access_denied') throw new AuthError(`Se rechazó el inicio de sesión. ${AGAIN}`);
    throw new AuthError(`Falló el inicio de sesión (${body.error ?? r.status}). ${AGAIN}`);
  }
}

const promptOf = (p) => ({ method: 'device', url: p.verificationUriComplete, verificationUri: p.verificationUri, code: p.userCode });

// Guarda la sesión y trae el correo (si /api/v2/me falla, la sesión sirve igual).
async function finish(method, tok) {
  const s = session(baseUrl(), tok);
  writeAuth(s);
  let email = null;
  try {
    email = (await request('GET', '/api/v2/me'))?.email ?? null;
    if (email) writeAuth({ ...s, email });
  } catch {}
  return { status: 'ok', method, email, expiresAt: new Date(s.expiresAt).toISOString(), scope: s.scope, path: authPath() };
}

// Orden de credenciales ANTES de iniciar un login (como fly.io/auth.md): GHOSTY_DEV_TOKEN → sesión del archivo
// vigente o renovable → sólo entonces login. Así un agente nunca pide login si ya hay sesión.
export async function existingSession() {
  if (process.env.GHOSTY_DEV_TOKEN) return { status: 'ok', already: true, source: 'env' };
  let auth = readAuth();
  if (!auth?.accessToken) return null;
  if (auth.expiresAt !== undefined && auth.expiresAt - Date.now() < 60_000) auth = await refresh(auth);
  if (!auth) return null;
  return { status: 'ok', already: true, source: 'file', path: authPath(), email: auth.email ?? null, expiresAt: new Date(auth.expiresAt).toISOString() };
}

// `agent`: sin TTY o con --json quien corre es un agente: nunca se abre el navegador, va el device flow.
export async function login({ device = false, agent = false, onPrompt = () => {} } = {}) {
  const ep = await endpoints(baseUrl());
  const method = device || agent || !hasLocalBrowser() ? 'device' : 'loopback';
  if (method === 'loopback') return finish(method, await loginLoopback(baseUrl(), ep, onPrompt));
  const pending = await startDevice(ep);
  onPrompt(promptOf(pending));
  return finish(method, await pollDevice(ep, pending));
}

// Paso 1 para agentes: pide el código, lo deja guardado y regresa de inmediato.
export async function loginStart() {
  const p = await startDevice(await endpoints(baseUrl()));
  return {
    status: 'pending',
    // `url` y `code`: los mismos nombres que `ghosty login` (una sola forma para los dos CLIs, ver ghosty.studio/auth.md).
    url: p.verificationUriComplete,
    code: p.userCode,
    verification_uri_complete: p.verificationUriComplete,
    verification_uri: p.verificationUri,
    user_code: p.userCode,
    expires_at: new Date(p.expiresAt).toISOString(),
    next: 'ghosty-dev login --wait',
  };
}

// Paso 2: retoma el pendiente y sondea hasta `timeoutSec`. Si sigue pendiente: {status: 'pending'} (exit 75).
export async function loginWait({ timeoutSec = 90 } = {}) {
  const pending = readPending();
  if (!pending?.deviceCode) throw new AuthError(`No hay un inicio de sesión pendiente. ${AGAIN}`);
  const tok = await pollDevice(await endpoints(baseUrl()), pending, Date.now() + timeoutSec * 1000);
  if (tok) return finish('device', tok);
  return { status: 'pending', url: pending.verificationUriComplete, code: pending.userCode, verification_uri_complete: pending.verificationUriComplete, user_code: pending.userCode, expires_at: new Date(pending.expiresAt).toISOString(), next: 'ghosty-dev login --wait' };
}

// ---------- refresh, peticiones ----------

// Cambia el refresh por un par nuevo (el servidor lo ROTA: se guarda el nuevo). null si no se pudo.
async function refresh(auth) {
  if (!auth?.refreshToken) return null;
  const ep = await endpoints(baseUrl());
  try {
    const res = await form(ep.token, { grant_type: 'refresh_token', refresh_token: auth.refreshToken });
    const tok = await jsonOf(res);
    if (!res.ok || !tok.access_token) return null;
    const next = session(baseUrl(), tok, auth);
    writeAuth(next);
    return next;
  } catch {
    return null;
  }
}

const NOT_LOGGED = 'No has iniciado sesión en Ghosty Studio. Siguiente paso: ghosty-dev login --no-wait (o pon GHOSTY_DEV_TOKEN)';

async function currentToken() {
  if (process.env.GHOSTY_DEV_TOKEN) return { token: process.env.GHOSTY_DEV_TOKEN, fromEnv: true };
  let auth = readAuth();
  if (!auth?.accessToken) throw new AuthError(NOT_LOGGED);
  if (auth.expiresAt !== undefined && auth.expiresAt - Date.now() < 60_000) {
    auth = await refresh(auth);
    if (!auth) throw new AuthError('Tu sesión de Ghosty Studio venció. Siguiente paso: ghosty-dev login --no-wait');
  }
  return { token: auth.accessToken, fromEnv: false };
}

// Error legible a partir de la respuesta de gs. Nunca incluye lo que se mandó (podría traer valores).
async function toError(res) {
  const body = await jsonOf(res);
  const text = body.message || body.error_description || (typeof body.error === 'string' ? body.error : '') || res.statusText;
  if (res.status === 401) return new AuthError('Tu sesión de Ghosty Studio ya no es válida. Siguiente paso: ghosty-dev login --no-wait');
  if (res.status === 403 && body.error === 'insufficient_scope')
    return new AuthError('Tu sesión no tiene el permiso repo:env. Siguiente paso: ghosty-dev login --no-wait');
  if (res.status === 403) return new AuthError(`No permitido: ${text}`);
  if (res.status === 404) return new AuthError(text || 'No se encontró.');
  return new AuthError(`Ghosty Studio respondió ${res.status}: ${text}`);
}

// Petición autenticada a gs: refresca si vence en < 60 s y reintenta UNA vez tras un 401 (no con GHOSTY_DEV_TOKEN).
export async function request(method, path, body, retried = false) {
  const { token, fromEnv } = await currentToken();
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'user-agent': USER_AGENT,
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !retried && !fromEnv) {
    if (await refresh(readAuth())) return request(method, path, body, true);
  }
  if (!res.ok) throw await toError(res);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// ---------- whoami, logout ----------

export async function whoami() {
  const fromEnv = Boolean(process.env.GHOSTY_DEV_TOKEN);
  const auth = fromEnv ? null : readAuth();
  if (!fromEnv && !auth?.accessToken) throw new AuthError(NOT_LOGGED);
  const out = { base: baseUrl(), source: fromEnv ? 'env' : 'file', path: fromEnv ? null : authPath(), email: auth?.email ?? null, id: null, scope: auth?.scope ?? null, expiresAt: null };
  try {
    const me = await request('GET', '/api/v2/me');
    Object.assign(out, { email: me.email ?? out.email, id: me.id ?? null, scope: Array.isArray(me.scopes) ? me.scopes.join(' ') : out.scope });
  } catch (e) {
    // Sin perfil (un token de CI sin `profile`): basta con decir que hay sesión. Un 401 sí es error.
    if (/ya no es válida|venció/.test(e.message)) throw e;
  }
  const after = fromEnv ? null : readAuth();
  if (after?.expiresAt) out.expiresAt = new Date(after.expiresAt).toISOString();
  return out;
}

export async function logout() {
  const auth = readAuth();
  let revoked = false;
  if (auth?.refreshToken) {
    // Revocar el refresh tumba la familia entera en el servidor; sin red, igual se borra local.
    try {
      const ep = await endpoints(baseUrl());
      const res = await form(ep.revoke, { token: auth.refreshToken, token_type_hint: 'refresh_token' });
      revoked = res.ok;
    } catch {}
  }
  clearAuth();
  return { loggedOut: Boolean(auth), revoked, envToken: Boolean(process.env.GHOSTY_DEV_TOKEN) };
}
