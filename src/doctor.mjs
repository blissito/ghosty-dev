// `ghosty-dev doctor`: lo que va a fallar en la vista previa antes de que falle. Hoy: el lock contra package.json
// (C30) y OAuth (C31). Para OAuth NO hay catálogo propio: se baja el de Ghosty Studio
// (GET /api/v2/preview-oauth/providers, público) y se detecta igual que la caja: el `grepPattern` sobre el repo, un
// proveedor si casa alguna de sus `codeHints`, y una llave falta si el código cita un alias y ninguno está en el env de
// la preview. Si el PR de la rama ya tiene vista previa, manda lo que ella vio (`preview.oauth`, con `registered`).
// Sólo NOMBRES de variables: los valores no se leen ni del disco ni de gs.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { checkLock } from './lock.mjs';
import { baseUrl, plain } from './auth.mjs';

// Lo mismo que excluye el grep de la caja (`--exclude-dir`).
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'dist', '.next']);
const MAX_FILES = 20_000;
const MAX_SIZE = 1_000_000;

const httpsUrl = (v) => {
  if (typeof v !== 'string' || v.length > 2000 || /\s/.test(v)) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
};
const strs = (v, max = 200) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => plain(x, max)) : []);
const envName = (v) => typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,100}$/.test(v);

// El catálogo validado (null si no llega o no tiene forma). Sin sesión: es público.
export async function fetchCatalog({ fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`${baseUrl()}/api/v2/preview-oauth/providers`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return parseCatalog(await res.json());
  } catch {
    return null;
  }
}

export function parseCatalog(c) {
  if (!c || typeof c.grepPattern !== 'string' || !Array.isArray(c.providers)) return null;
  let pattern;
  try {
    pattern = new RegExp(c.grepPattern, 'g');
  } catch {
    return null;
  }
  const providers = c.providers
    .map((p) => {
      const hints = strs(p?.codeHints, 300).flatMap((h) => {
        try {
          return [new RegExp(h)];
        } catch {
          return [];
        }
      });
      return {
        id: plain(p?.id ?? '', 40),
        name: plain(p?.name ?? '', 60),
        hints,
        env: Array.isArray(p?.env) ? p.env.map((g) => (Array.isArray(g) ? g.filter(envName) : [])).filter((g) => g.length) : [],
        consoleUrl: httpsUrl(p?.consoleUrl),
        steps: strs(p?.steps, 400).slice(0, 5),
        signsCallback: p?.signsCallback === true,
      };
    })
    .filter((p) => p.id && p.hints.length);
  const env = c.env ?? {};
  return {
    redirectUri: httpsUrl(c.redirectUri),
    env: { redirectUri: envName(env.redirectUri) ? env.redirectUri : 'GS_PREVIEW_OAUTH_REDIRECT_URI', stateKey: envName(env.stateKey) ? env.stateKey : 'GS_PREVIEW_OAUTH_STATE_KEY', host: envName(env.host) ? env.host : 'PREVIEW_HOST' },
    pattern,
    providers,
    helperJs: typeof c.helperJs === 'string' ? c.helperJs.slice(0, 5000) : null,
    docs: httpsUrl(c.docs),
  };
}

// Como `grep -rhoIE`: todas las coincidencias del patrón en los archivos de texto del repo. Además: qué archivos
// citan ya la variable del redirect de gs.
export function grepRepo(dir, pattern, proxyVar) {
  const tokens = new Set();
  let usesProxy = false;
  const stack = [dir];
  let n = 0;
  while (stack.length && n < MAX_FILES) {
    const d = stack.pop();
    let items;
    try {
      items = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const it of items) {
      const p = join(d, it.name);
      if (it.isDirectory()) {
        if (!SKIP_DIRS.has(it.name)) stack.push(p);
        continue;
      }
      if (!it.isFile()) continue;
      let buf;
      try {
        if (statSync(p).size > MAX_SIZE) continue;
        buf = readFileSync(p);
      } catch {
        continue;
      }
      n++;
      if (buf.subarray(0, 8000).includes(0)) continue; // binario (-I)
      const text = buf.toString('utf8');
      for (const m of text.matchAll(pattern)) tokens.add(m[0]);
      if (proxyVar && text.includes(proxyVar) && relative(dir, p) !== 'AGENTS.md' && !relative(dir, p).startsWith('.claude')) usesProxy = true;
    }
  }
  return { tokens: [...tokens], usesProxy };
}

// Igual que detectOAuthProviders de gs: proveedor si casa una pista; llave faltante si el código cita un alias y
// ninguno está en el env.
export function detectProviders(catalog, tokens, envKeys) {
  const seen = new Set(tokens.map((t) => t.trim()).filter(Boolean));
  const have = new Set(envKeys ?? []);
  const uri = catalog.redirectUri ?? '{uri}';
  const out = [];
  for (const p of catalog.providers) {
    if (![...seen].some((t) => p.hints.some((re) => re.test(t)))) continue;
    const missingEnv = envKeys == null ? null : p.env.flatMap((aliases) => {
      const cited = aliases.filter((a) => seen.has(a));
      return cited.length && !aliases.some((a) => have.has(a)) ? [cited[0]] : [];
    });
    out.push({ id: p.id, name: p.name, registered: null, consoleUrl: p.consoleUrl, steps: p.steps.map((s) => s.replaceAll('{uri}', uri)), missingEnv, signsCallback: p.signsCallback });
  }
  return out;
}

// `preview.oauth` del PR (lo que vio la caja con el env real), validado.
export function parsePreviewOAuth(o) {
  if (!o || !Array.isArray(o.providers)) return null;
  return {
    redirectUri: httpsUrl(o.redirectUri),
    agentPrompt: typeof o.agentPrompt === 'string' ? plain(o.agentPrompt, 1000) : null,
    providers: o.providers
      .map((p) => ({
        id: plain(p?.id ?? '', 40),
        name: plain(p?.name ?? '', 60),
        registered: typeof p?.registered === 'boolean' ? p.registered : null,
        consoleUrl: httpsUrl(p?.consoleUrl),
        steps: strs(p?.steps, 400).slice(0, 5),
        missingEnv: Array.isArray(p?.missingEnv) ? p.missingEnv.filter(envName) : [],
        signsCallback: p?.signsCallback === true,
      }))
      .filter((p) => p.id),
  };
}

// Los chequeos. `saved`: nombres guardados en gs para la preview (null si no se pudieron leer). `catalog`: el de gs
// (null si no llegó). `previewOAuth`: el `oauth` de la preview del PR, si hay.
export function diagnose(dir, opts = {}) {
  const r = diagnoseOAuth(dir, opts);
  const id = identityCheck(dir);
  if (id) r.checks.push(id);
  return r;
}

// Identidad de Ghosty en previews (Formmy, fila 40): el proxy de la preview manda `X-Ghosty-Identity` (JWT de quien la
// abre, verificado con el JWKS de gs). Si la app tiene login y no lo lee, un PR basado en main no prueba logueado.
const LOGIN_HINT = /createCookieSessionStorage|getSession\(|commitSession|next-auth|@auth\/|better-auth|lucia|passport|signIn\(|\/login\b/g;
// La variable cuenta sólo en el código (grepRepo no cuenta AGENTS.md ni .claude, donde viene la receta).
export function identityCheck(dir) {
  const { tokens: login, usesProxy: uses } = grepRepo(dir, LOGIN_HINT, 'GS_PREVIEW_IDENTITY_JWKS_URL');
  if (!login.length) return null;
  if (uses) return { name: 'login-en-previews', ok: true, detail: 'la app crea sesión con la identidad de Ghosty en la vista previa (X-Ghosty-Identity)', fix: null };
  return {
    name: 'login-en-previews',
    ok: null,
    detail: 'la app tiene login pero no lee X-Ghosty-Identity: un PR basado en main no puede probar con sesión en su vista previa',
    fix: 'adopta la receta «Login en previews» de AGENTS.md (≈15 líneas con jose; sólo actúa si existe GS_PREVIEW_IDENTITY_JWKS_URL) y súbela a main',
  };
}

function diagnoseOAuth(dir, { saved = null, catalog = null, previewOAuth = null } = {}) {
  const checks = [];
  const lock = checkLock(dir);
  checks.push(lock.lock ? { name: 'lock', ok: lock.ok, detail: lock.ok ? `${lock.lock} coincide con package.json` : lock.message, fix: lock.ok ? null : lock.fix } : { name: 'lock', ok: true, detail: 'sin lock que comparar', fix: null });
  if (!catalog) {
    checks.push({ name: 'oauth', ok: null, detail: 'no pude bajar el catálogo de proveedores OAuth de Ghosty Studio: no se revisó OAuth', fix: null });
    return { checks, oauth: null };
  }
  const { tokens, usesProxy } = grepRepo(dir, catalog.pattern, catalog.env.redirectUri);
  const local = detectProviders(catalog, tokens, saved);
  // La caja manda (vio el env real y sabe si ya volvió un code por el proxy); lo local cubre lo que ella no listó.
  const providers = previewOAuth ? [...previewOAuth.providers, ...local.filter((l) => !previewOAuth.providers.some((p) => p.id === l.id))] : local;
  const redirectUri = previewOAuth?.redirectUri ?? catalog.redirectUri;
  const oauth = { redirectUri, providers, agentPrompt: previewOAuth?.agentPrompt ?? null, env: catalog.env, docs: catalog.docs, helperJs: catalog.helperJs };
  if (!providers.length) {
    checks.push({ name: 'oauth', ok: true, detail: 'el repo no usa OAuth de un proveedor conocido', fix: null });
    return { checks, oauth };
  }
  for (const p of providers) {
    if (p.missingEnv === null) checks.push({ name: `oauth-${p.id}-llaves`, ok: null, detail: `${p.name}: no pude leer las variables de la vista previa (ghosty-dev login)`, fix: 'ghosty-dev env ls' });
    else if (p.missingEnv.length) checks.push({ name: `oauth-${p.id}-llaves`, ok: false, detail: `${p.name}: a la vista previa le faltan ${p.missingEnv.join(', ')}`, fix: 'ghosty-dev env push <archivo con esas variables>' });
    else checks.push({ name: `oauth-${p.id}-llaves`, ok: true, detail: `${p.name}: la vista previa tiene sus llaves`, fix: null });
    if (p.registered === true) checks.push({ name: `oauth-${p.id}-registro`, ok: true, detail: `${p.name}: ya regresó un login por el callback de Ghosty`, fix: null });
    else
      checks.push({
        name: `oauth-${p.id}-registro`,
        ok: null,
        detail: `Para entrar con ${p.name} en tus vistas previas falta un paso único: registrar esta URL en tu proyecto de ${p.name}`,
        copy: redirectUri,
        consoleUrl: p.consoleUrl,
        steps: p.steps,
        fix: `o pídeselo a Ghosty con ghosty-browser: «${oauth.agentPrompt ?? `registra ${redirectUri ?? 'la URL de callback de Ghosty'} como redirect URI de ${p.name} en ${p.consoleUrl ?? 'su consola'}`}»`,
      });
  }
  checks.push(
    usesProxy
      ? { name: 'oauth-callback', ok: true, detail: `el código usa ${catalog.env.redirectUri}`, fix: null }
      : {
          name: 'oauth-callback',
          ok: false,
          detail: `el redirect_uri no usa ${catalog.env.redirectUri}: en la vista previa el proveedor rechaza el callback`,
          fix: `si existe ${catalog.env.redirectUri}, úsalo como redirect_uri (también al canjear el code) y arma el state con previewOAuthState(state, '/ruta/callback')${providers.some((p) => p.signsCallback) ? '; en el callback de Shopify, previewOAuthUnwrap(state)' : ''}${catalog.docs ? ` (${catalog.docs})` : ''}`,
        },
  );
  return { checks, oauth };
}

// Texto para la terminal: la URL a copiar va sola en su renglón.
export function doctorText(x) {
  const mark = (ok) => (ok === true ? 'ok ' : ok === false ? 'MAL' : ' ! ');
  const lines = [`ghosty-dev doctor · ${x.repo}`];
  for (const c of x.checks) {
    lines.push(`  ${mark(c.ok)} ${c.name}: ${c.detail}`);
    if (c.copy) lines.push('', `      ${c.copy}`, '');
    if (c.consoleUrl) lines.push(`      consola: ${c.consoleUrl}`);
    (c.steps ?? []).forEach((step, i) => lines.push(`      ${i + 1}. ${step}`));
    if (c.fix) lines.push(`      → ${c.fix}`);
  }
  return lines.join('\n');
}
