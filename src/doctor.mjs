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
// Orden (Formmy, fila 47): lock → identidad de Ghosty (el camino sin OAuth va PRIMERO) → base de la preview → OAuth.
export function diagnose(dir, opts = {}) {
  const id = identityCheck(dir);
  const r = diagnoseOAuth(dir, { ...opts, identity: id?.ok === true });
  const lock = r.checks.shift();
  const db = databaseCheck(opts.saved);
  r.checks.unshift(...[lock, id, db].filter(Boolean));
  const partner = partnerTokenCheck(dir);
  if (partner) r.checks.push(partner);
  // Con la receta del token de caja, la llave de partner ya no le hace falta a la vista previa.
  let missing = Array.isArray(opts.previewMissingEnv) && partner?.ok ? opts.previewMissingEnv.filter((n) => !PARTNER_KEY_VARS.has(n)) : opts.previewMissingEnv ?? null;
  // Con la identidad de Ghosty adoptada, las llaves OAuth no le hacen falta a la vista previa (fila 47).
  const oauthVars = new Set((opts.catalog?.providers ?? []).flatMap((p) => p.env.flat()));
  if (Array.isArray(missing) && id?.ok) missing = missing.filter((n) => !oauthVars.has(n));
  const env = missingEnvCheck(missing, opts.previewMissingEnvTouched ?? []);
  if (env) r.checks.push(env);
  return r;
}

// Variables que el código lee y la vista previa del PR no tiene (lo vio la caja; sólo nombres). null = sin preview.
export function missingEnvCheck(names, touched = []) {
  if (!Array.isArray(names)) return null;
  if (!names.length) return { name: 'env-faltantes', ok: true, detail: 'la vista previa tiene todas las variables que lee el código', fix: null };
  const t = touched.filter((n) => names.includes(n));
  return {
    name: 'env-faltantes',
    ok: false,
    detail: `a la vista previa le faltan ${names.slice(0, 8).join(', ')}${names.length > 8 ? ` y ${names.length - 8} más` : ''}${t.length ? ` (las lee este PR: ${t.join(', ')})` : ''}: lo que las use falla aunque las páginas abran`,
    fix: 'ghosty-dev env push <archivo con esas variables> (se toman en el siguiente armado: box rebuild o un push)',
  };
}

// Fila 43: probar con sesión escribe en la base. Si la vista previa trae la variable de una base (sólo NOMBRES: gs no
// da valores), se avisa que debe ser una desechable (copia o vacía con seed), nunca la de producción.
const DB_ENV = /^(DATABASE_URL|DB_URL|DIRECT_URL|MONGO(DB)?_[A-Z0-9_]*|[A-Z0-9_]*MONGO_(URI|URL|ATLAS)[A-Z0-9_]*|MONGO_ATLAS[A-Z0-9_]*|POSTGRES[A-Z0-9_]*|PG(HOST|DATABASE|URL)|MYSQL[A-Z0-9_]*|SUPABASE_(URL|DB_URL|SERVICE_ROLE_KEY)|TURSO_DATABASE_URL|LIBSQL_URL|REDIS_URL|PLANETSCALE[A-Z0-9_]*|NEON[A-Z0-9_]*)$/;
export function databaseCheck(saved) {
  const hits = (saved ?? []).filter((k) => DB_ENV.test(k));
  if (!hits.length) return null;
  return {
    name: 'base-de-la-preview',
    ok: null,
    detail: `la vista previa trae ${hits.slice(0, 4).join(', ')}: si apunta a la base de producción, cada prueba con sesión escribe en datos reales de clientes`,
    fix: 'que la vista previa use una base desechable (una copia o una base vacía con seed y un usuario de prueba), guardada con ghosty-dev env push; nunca la URL de producción',
  };
}

// Identidad de Ghosty en previews (Formmy, fila 40): el proxy de la preview manda `X-Ghosty-Identity` (JWT de quien la
// abre, verificado con el JWKS de gs). Si la app tiene login y no lo lee, un PR basado en main no prueba logueado.
const LOGIN_HINT = /createCookieSessionStorage|getSession\(|commitSession|next-auth|@auth\/|better-auth|lucia|passport|signIn\(|\/login\b/g;
// La variable cuenta sólo en el código (grepRepo no cuenta AGENTS.md ni .claude, donde viene la receta).
export function identityCheck(dir) {
  const { tokens: login, usesProxy: uses } = grepRepo(dir, LOGIN_HINT, 'GS_PREVIEW_IDENTITY_JWKS_URL');
  if (!login.length) return null;
  if (uses) return { name: 'login-en-previews', ok: true, detail: 'la app crea sesión con la identidad de Ghosty en la vista previa (X-Ghosty-Identity): no hace falta OAuth ahí', fix: null };
  return {
    name: 'login-en-previews',
    ok: null,
    detail: 'la app tiene login pero no lee X-Ghosty-Identity: un PR basado en main no puede probar con sesión en su vista previa. Es el camino recomendado: sin OAuth, sin tocar tus clientes de producción ni copiar secretos',
    fix: 'adopta la receta «Login en previews» de AGENTS.md (≈15 líneas con jose; sólo actúa si existe GS_PREVIEW_IDENTITY_JWKS_URL; la identidad entra como un usuario de prueba de la base de la preview) y súbela a main',
  };
}

// Identidad de la caja (22-nov): cada vista previa trae `GHOSTY_PREVIEW_TOKEN` y la API de partner de Ghosty lo acepta
// como Bearer (sólo pruebas). Si el código firma con la llave de partner y no usa el token, la vista previa necesitaría
// copiar llaves de producción.
const PARTNER_KEY_VARS = new Set(['GHOSTY_PARTNER_KEY', 'GHOSTY_PARTNER_KEY_SECRET', 'GHOSTY_PARTNER_SECRET']);
export function partnerTokenCheck(dir) {
  const { tokens, usesProxy: uses } = grepRepo(dir, /GHOSTY_PARTNER_KEY/g, 'GHOSTY_PREVIEW_TOKEN');
  if (!tokens.length) return null;
  if (uses) return { name: 'partner-en-previews', ok: true, detail: 'la app usa GHOSTY_PREVIEW_TOKEN en la vista previa: no necesita la llave de partner', fix: null };
  return {
    name: 'partner-en-previews',
    ok: null,
    detail: 'la app firma la API de partner de Ghosty con GHOSTY_PARTNER_KEY y la vista previa no la tiene: lo que llame a Ghosty falla en el PR',
    fix: 'adopta la receta «API de partner en previews» de AGENTS.md (3 líneas: Bearer con GHOSTY_PREVIEW_TOKEN si no hay llave) y súbela a main',
  };
}

function diagnoseOAuth(dir, { saved = null, catalog = null, previewOAuth = null, identity = false } = {}) {
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
  // Con la identidad de Ghosty adoptada, OAuth no hace falta en la vista previa: nada de llaves ni callback (fila 47).
  if (identity) {
    checks.push({ name: 'oauth', ok: true, detail: `${providers.map((p) => p.name).join(', ')}: en la vista previa no hace falta, la app entra con la identidad de Ghosty (no copies llaves ni toques tus clientes OAuth de producción)`, fix: null });
    return { checks, oauth };
  }
  // Riesgo (fila 47): el cliente OAuth de producción no se edita ni su secreto se copia a un entorno de pruebas.
  const separate = 'si de verdad necesitas OAuth en previews: un cliente OAuth APARTE sólo para previews (su propio ID y secreto), nunca el de producción';
  for (const p of providers) {
    if (p.missingEnv === null) checks.push({ name: `oauth-${p.id}-llaves`, ok: null, detail: `${p.name}: no pude leer las variables de la vista previa (ghosty-dev login)`, fix: 'ghosty-dev env ls' });
    else if (p.missingEnv.length) checks.push({ name: `oauth-${p.id}-llaves`, ok: null, detail: `${p.name}: a la vista previa le faltan ${p.missingEnv.join(', ')}. No copies ahí el secreto de producción`, fix: `primero la identidad de Ghosty (receta «Login en previews» de AGENTS.md, sin OAuth); ${separate}, y sus llaves con ghosty-dev env push <archivo>` });
    else checks.push({ name: `oauth-${p.id}-llaves`, ok: true, detail: `${p.name}: la vista previa tiene sus llaves`, fix: null });
    if (p.registered === true) checks.push({ name: `oauth-${p.id}-registro`, ok: true, detail: `${p.name}: ya regresó un login por el callback de Ghosty`, fix: null });
    else
      checks.push({
        name: `oauth-${p.id}-registro`,
        ok: null,
        detail: `Sólo si usas OAuth en previews (mejor: la identidad de Ghosty): registra esta URL en un cliente de ${p.name} APARTE para previews, nunca en el de producción`,
        copy: redirectUri,
        consoleUrl: p.consoleUrl,
        steps: p.steps,
        fix: `o pídeselo a Ghosty con ghosty-browser: «${oauth.agentPrompt ?? `registra ${redirectUri ?? 'la URL de callback de Ghosty'} como redirect URI de ${p.name} en ${p.consoleUrl ?? 'su consola'}`}»`,
      });
  }
  // MAL sólo si ya hay llaves en la preview (se quiere OAuth ahí); si no, es un aviso más del camino con OAuth.
  const intendsOAuth = providers.some((p) => Array.isArray(p.missingEnv) && !p.missingEnv.length);
  checks.push(
    usesProxy
      ? { name: 'oauth-callback', ok: true, detail: `el código usa ${catalog.env.redirectUri}`, fix: null }
      : {
          name: 'oauth-callback',
          ok: intendsOAuth ? false : null,
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
