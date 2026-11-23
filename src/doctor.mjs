// `ghosty-dev doctor`: lo que va a fallar en la vista previa antes de que falle. Hoy: el lock contra package.json
// (C30) y OAuth (C31). Para OAuth NO hay catálogo propio: se baja el de Ghosty Studio
// (GET /api/v2/preview-oauth/providers, público) y se detecta igual que la caja: el `grepPattern` sobre el repo, un
// proveedor si casa alguna de sus `codeHints`, y una llave falta si el código cita un alias y ninguno está en el env de
// la preview. Si el PR de la rama ya tiene vista previa, manda lo que ella vio (`preview.oauth`, con `registered`).
// Sólo NOMBRES de variables: los valores no se leen ni del disco ni de gs. Única excepción: el CLIENT ID de OAuth
// (público, va en la URL de login de cualquier app) se lee del .env local para preguntarle a gs
// (GET /api/v2/preview-oauth/probe) si el proveedor ya acepta el callback; nunca un secreto.
// Sólo cuentan los proveedores con los que la app INICIA SESIÓN (`loginHints`): Shopify de tienda o el diálogo de
// Facebook de WhatsApp son integraciones y no se avisan. Registro: true = ok; false = falta el paso; null = no se dice.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { checkLock } from './lock.mjs';
import { baseUrl, checkRepo, plain, request } from './auth.mjs';

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

// Los agentes de partner de la dueña del repo (sólo slugs). null si no se pudo preguntar (sin sesión, sin red, gs viejo).
export async function fetchPartnerAgents(repo) {
  try {
    const [owner, name] = checkRepo(repo);
    const r = await request('GET', `/api/v2/me/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/partner-agents`, undefined, { scope: 'dev' });
    if (!Array.isArray(r?.partners)) return null;
    const slug = (v) => (typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(v) ? v : null);
    return {
      partners: r.partners
        .map((p) => ({ workspace: slug(p?.workspace), disabled: p?.disabled === true, agents: Array.isArray(p?.agents) ? p.agents.map(slug).filter(Boolean) : [] }))
        .filter((p) => p.workspace),
    };
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
      // Catálogo viejo (sin loginHints): toda pista cuenta como login, como antes.
      const login = Array.isArray(p?.loginHints)
        ? strs(p.loginHints, 300).flatMap((h) => {
            try {
              return [new RegExp(h)];
            } catch {
              return [];
            }
          })
        : hints;
      return {
        id: plain(p?.id ?? '', 40),
        name: plain(p?.name ?? '', 60),
        hints,
        login,
        probe: typeof p?.probe === 'string' ? plain(p.probe, 20) : null,
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
  walkText(dir, (rel, text) => {
    for (const m of text.matchAll(pattern)) tokens.add(m[0]);
    if (proxyVar && text.includes(proxyVar) && rel !== 'AGENTS.md' && !rel.startsWith('.claude')) usesProxy = true;
  });
  return { tokens: [...tokens], usesProxy };
}

// Cada archivo de texto del repo (sin SKIP_DIRS, binarios ni gigantes), con su ruta relativa.
function walkText(dir, fn) {
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
      fn(relative(dir, p), buf.toString('utf8'));
    }
  }
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
    const login = [...seen].some((t) => p.login.some((re) => re.test(t)));
    out.push({ id: p.id, name: p.name, registered: null, login, consoleUrl: p.consoleUrl, steps: p.steps.map((s) => s.replaceAll('{uri}', uri)), missingEnv, signsCallback: p.signsCallback });
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
        login: p?.login !== false,
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
  // La prueba de punta a punta va junto a la identidad: el código la lee (estático) y la app entra (real).
  const live = id?.ok ? loginProbeCheck(opts.loginProbe ?? null) : null;
  r.checks.unshift(...[lock, id, live, db].filter(Boolean));
  const partner = partnerTokenCheck(dir);
  if (partner) r.checks.push(partner);
  const agents = partnerAgentsCheck(partnerAgentRefs(dir), opts.partnerAgents ?? null, factoryPartner(dir));
  if (agents) r.checks.push(agents);
  // Con la receta del token de caja, la llave de partner ya no le hace falta a la vista previa.
  let missing = Array.isArray(opts.previewMissingEnv) && partner?.ok ? opts.previewMissingEnv.filter((n) => !PARTNER_KEY_VARS.has(n)) : opts.previewMissingEnv ?? null;
  // Con la identidad de Ghosty adoptada, las llaves OAuth no le hacen falta a la vista previa (fila 47).
  const oauthVars = new Set((opts.catalog?.providers ?? []).flatMap((p) => p.env.flat()));
  if (Array.isArray(missing) && id?.ok) missing = missing.filter((n) => !oauthVars.has(n));
  const env = missingEnvCheck(missing, opts.previewMissingEnvTouched ?? [], opts.previewMissingEnvPriority ?? null);
  if (env) r.checks.push(env);
  return r;
}

// Variables que el código lee y la vista previa del PR no tiene (lo vio la caja; sólo nombres). null = sin preview.
// `priority`: las que lee el PR o el arranque del servidor (gs); sólo ésas hacen fallar el check. El resto de la app es
// informativo (la preview no necesita todas las de producción). null = gs viejo: todas cuentan.
export function missingEnvCheck(names, touched = [], priority = null) {
  if (!Array.isArray(names)) return null;
  if (!names.length) return { name: 'env-faltantes', ok: true, detail: 'la vista previa tiene todas las variables que lee el código', fix: null };
  const list = (l) => `${l.slice(0, 8).join(', ')}${l.length > 8 ? ` y ${l.length - 8} más` : ''}`;
  const top = Array.isArray(priority) ? priority.filter((n) => names.includes(n)) : names;
  const rest = names.filter((n) => !top.includes(n));
  const fix = 'ghosty-dev env push <archivo con esas variables> (se toman en el siguiente armado: box rebuild o un push)';
  if (!top.length)
    return { name: 'env-faltantes', ok: null, detail: `informativo: faltan ${rest.length} del resto de la app (${list(rest)}); ninguna la usa este PR ni el arranque`, fix: null };
  const t = touched.filter((n) => top.includes(n));
  return {
    name: 'env-faltantes',
    ok: false,
    detail: `a la vista previa le faltan ${top.length} que usa ${t.length === top.length ? 'este PR' : 'este PR o el arranque'}: ${list(top)}${rest.length ? ` · y ${rest.length} más del resto de la app (informativo)` : ''}: lo que las use falla aunque las páginas abran`,
    fix,
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

// Formmy filas 53–54: «login-en-previews: ok» se daba por bueno leyendo el código y la vista previa seguía sin sesión.
// Con la vista previa del PR lista, gs pide una ruta protegida con y sin la identidad (petición real). null = no hubo
// prueba (sin PR, sin vista previa lista o sin sesión de ghosty-dev).
export function loginProbeCheck(probe) {
  if (!probe) return null;
  const name = 'login-en-previews-de-verdad';
  const fix = `revisa que el loader de ${probe.path} lea X-Ghosty-Identity, que el proceso tenga GS_PREVIEW_IDENTITY_JWKS_URL y PREVIEW_HOST, y repite: ghosty-dev preview ${probe.pr ?? '<pr>'} --login --check --path ${probe.path}`;
  if (probe.verdict === 'session') return { name, ok: true, detail: `petición real a la vista previa: ${probe.message}`, fix: null };
  if (probe.verdict === 'public_path')
    return { name, ok: null, detail: `sin probar: ${probe.message}`, fix: 'pon en .ghosty/factory.md «login_path: /una/ruta/con/sesion» o corre doctor --path /una/ruta/con/sesion' };
  return { name, ok: false, detail: `petición real a la vista previa: ${probe.message ?? probe.verdict}`, fix };
}

// La ruta protegida para la prueba de login: `login_path:` del frontmatter de .ghosty/factory.md; si no, /dashboard.
export function loginPathOf(dir) {
  try {
    const front = readFileSync(join(dir, '.ghosty', 'factory.md'), 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const m = front.match(/^login_path:\s*["']?(\/[^\s"']*)/m);
    return m ? m[1] : '/dashboard';
  } catch {
    return '/dashboard';
  }
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

// Recursos externos que el código da por hechos (Formmy, fila 50): un agente de partner al que la app le habla por
// `/api/v2/partner/*` y que nunca se creó deja el PR «Listo para merge» con la función rota. Se buscan, en archivos
// que llaman a la API de partner (sin pruebas), literales asignados a algo que se llama «agent»:
// `const AGENT = () => process.env.X ?? "crear"`, `agent: "crear"`, `agentSlug = 'crear'`.
const AGENT_REF = /\b(?:const|let|var)\s+\w*agent\w*\s*=[^\n;]*?["'`]([a-z0-9][a-z0-9-]{0,39})["'`]|\b(?:agent|agentSlug|agent_slug)\s*:\s*["'`]([a-z0-9][a-z0-9-]{0,39})["'`]/gi;
const TEST_FILE = /(^|\/)(__tests__|tests?|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
export function partnerAgentRefs(dir) {
  const refs = new Map();
  walkText(dir, (rel, text) => {
    if (TEST_FILE.test(rel) || !/\.[cm]?[jt]sx?$/.test(rel) || !text.includes('/api/v2/partner/')) return;
    for (const m of text.matchAll(AGENT_REF)) {
      const slug = (m[1] ?? m[2]).toLowerCase();
      if (!refs.has(slug)) refs.set(slug, rel);
    }
  });
  return [...refs].map(([slug, file]) => ({ slug, file }));
}

// `remote`: lo que dice gs de los partners de la dueña del repo ({ partners: [{ workspace, disabled, agents }] }), o
// null si no se pudo preguntar. `partner`: el espacio que fija `.ghosty/factory.md` (`partner: <espacio>`), si hay.
export function partnerAgentsCheck(refs, remote, partner = null) {
  if (!refs.length) return null;
  const names = refs.map((r) => r.slug).join(', ');
  if (!remote) return { name: 'agentes-de-partner', ok: null, detail: `el código llama ${refs.length > 1 ? 'a los agentes' : 'al agente'} de partner ${names} y no pude preguntar a Ghosty Studio si existe${refs.length > 1 ? 'n' : ''} (ghosty-dev login)`, fix: null };
  const pool = (remote.partners ?? []).filter((p) => !p.disabled && (!partner || p.workspace === partner));
  if (!pool.length)
    return { name: 'agentes-de-partner', ok: false, detail: `el código llama a ${names} por la API de partner, pero ${partner ? `el espacio de partner ${partner}` : 'la dueña del repo'} no tiene espacio de partner activo en Ghosty Studio`, fix: 'ghosty partner enable <espacio> (CLI @ghostystudio/cli) y luego crea el agente' };
  const have = new Set(pool.flatMap((p) => p.agents ?? []));
  const missing = refs.filter((r) => !have.has(r.slug));
  if (!missing.length) return { name: 'agentes-de-partner', ok: true, detail: `existe${refs.length > 1 ? 'n' : ''} ${names} en ${pool.map((p) => p.workspace).join(', ')}`, fix: null };
  const ws = pool.length === 1 ? ` --workspace ${pool[0].workspace}` : '';
  const m = missing[0];
  return {
    name: 'agentes-de-partner',
    ok: false,
    detail: `el código llama al agente de partner ${missing.map((x) => `«${x.slug}» (${x.file})`).join(', ')} y no existe en ${pool.map((p) => p.workspace).join(', ')}: la función falla en producción aunque el PR se vea verde`,
    fix: `créalo con el prompt versionado en el repo y la llave de partner del env: npx @ghostystudio/cli@latest partner agent apply${ws} --agent ${m.slug} --prompt-file ghosty/agents/${m.slug}.md --mcp <url https de tu MCP en prod> --dry-run (y sin --dry-run)`,
  };
}

// `partner: <espacio>` del frontmatter de `.ghosty/factory.md` o `.ghosty/dev.md`.
export function factoryPartner(dir) {
  for (const f of ['.ghosty/factory.md', '.ghosty/dev.md']) {
    try {
      const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(dir, f), 'utf8'))?.[1] ?? '';
      const m = /^partner:\s*["']?([a-z0-9][a-z0-9-]{0,62})["']?\s*$/m.exec(fm);
      if (m) return m[1];
    } catch {}
  }
  return null;
}

function diagnoseOAuth(dir, { saved = null, catalog = null, previewOAuth = null, identity = false, probes = {} } = {}) {
  const checks = [];
  const lock = checkLock(dir);
  checks.push(lock.lock ? { name: 'lock', ok: lock.ok, detail: lock.ok ? `${lock.lock} coincide con package.json` : lock.message, fix: lock.ok ? null : lock.fix } : { name: 'lock', ok: true, detail: 'sin lock que comparar', fix: null });
  if (!catalog) {
    checks.push({ name: 'oauth', ok: null, detail: 'no pude bajar el catálogo de proveedores OAuth de Ghosty Studio: no se revisó OAuth', fix: null });
    return { checks, oauth: null };
  }
  const { tokens, usesProxy } = grepRepo(dir, catalog.pattern, catalog.env.redirectUri);
  const local = detectProviders(catalog, tokens, saved)
    .filter((p) => p.login)
    .map((p) => ({ ...p, registered: typeof probes[p.id] === 'boolean' ? probes[p.id] : null }));
  // La caja manda (vio el env real, sondeó al proveedor y sabe si ya volvió un code por el proxy); lo local cubre lo
  // que ella no listó.
  const providers = previewOAuth ? [...previewOAuth.providers.filter((p) => p.login), ...local.filter((l) => !previewOAuth.providers.some((p) => p.id === l.id))] : local;
  const redirectUri = previewOAuth?.redirectUri ?? catalog.redirectUri;
  const oauth = { redirectUri, providers, agentPrompt: previewOAuth?.agentPrompt ?? null, env: catalog.env, docs: catalog.docs, helperJs: catalog.helperJs };
  if (!providers.length) {
    checks.push({ name: 'oauth', ok: true, detail: 'la app no inicia sesión con OAuth de un proveedor conocido', fix: null });
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
    if (p.registered === true) checks.push({ name: `oauth-${p.id}-registro`, ok: true, detail: `${p.name}: el callback de Ghosty ya está registrado`, fix: null });
    // Si no se pudo saber (sin client id, proveedor que pide login antes de validar), no se avisa.
    else if (p.registered === false)
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

// Pregunta a gs si cada proveedor de login ya acepta el callback, con el client id del .env local (público).
// { [id]: true | false | null }. Sin red o sin client id: nada (no se avisa).
export async function probeProviders(dir, catalog, { fetchImpl = fetch } = {}) {
  if (!catalog) return {};
  const vals = new Map();
  for (const f of ['.env', '.env.local', '.env.development']) {
    let text = '';
    try {
      text = readFileSync(join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const m = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=["']?([A-Za-z0-9._-]{4,120})["']?\s*$/.exec(line.trim());
      if (m && !vals.has(m[1])) vals.set(m[1], m[2]);
    }
  }
  const { tokens } = grepRepo(dir, catalog.pattern, catalog.env.redirectUri);
  const out = {};
  await Promise.all(
    detectProviders(catalog, tokens, [])
      .filter((p) => p.login)
      .map(async (d) => {
        const p = catalog.providers.find((x) => x.id === d.id);
        const id = (p?.env[0] ?? []).map((a) => vals.get(a)).find(Boolean);
        if (!p?.probe || !id) return;
        try {
          const res = await fetchImpl(`${baseUrl()}/api/v2/preview-oauth/probe?provider=${encodeURIComponent(p.id)}&client_id=${encodeURIComponent(id)}`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
          const j = res.ok ? await res.json() : null;
          out[p.id] = typeof j?.registered === 'boolean' ? j.registered : null;
        } catch {}
      }),
  );
  return out;
}
