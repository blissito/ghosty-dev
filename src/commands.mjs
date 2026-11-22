// Comandos de la bitácora. Cada uno se traza a una ley o a una fuente (ver SPEC.md, «Qué copiamos y de quién»).
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { api, apiAll, git } from './gh.mjs';
import { validateEvidence, formatEvidence, findValidEvidence, findRevisionFor, validateRevision, formatRevision } from './evidence.mjs';
import { closingRefs, evaluatePullRequest, unlinkedPolicy } from './gate.mjs';
import { pushWorkflows } from './workflows.mjs';
import { HOOK_MARK, PRE_PUSH, checkLock } from './lock.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Estado interno → etiqueta visible. Los nombres de la etiqueta son los de un tablero: por hacer, en curso…
export const STATES = ['listo', 'tomado', 'esperando', 'bloqueado'];
const LABEL_NAME = { listo: 'por-hacer', tomado: 'en-curso', esperando: 'esperando-ci', bloqueado: 'bloqueado' };
export const label = (state) => `ghosty-dev:${LABEL_NAME[state]}`;
// Etiquetas de la v0.1: init las renombra (los issues las conservan) y stateOf todavía las entiende.
const LEGACY = { listo: 'ghosty-dev:listo', tomado: 'ghosty-dev:tomado', esperando: 'ghosty-dev:esperando' };
const LABEL_STYLE = {
  listo: ['0E8A16', 'Por hacer: un agente lo puede tomar en cuanto no tenga bloqueos'],
  tomado: ['1D76DB', 'En curso: un agente lo está trabajando en su rama (nadie más lo toca)'],
  esperando: ['FBCA04', 'Esperando el CI del PR; el agente lo retoma cuando termine'],
  bloqueado: ['B60205', 'Bloqueado por otro pendiente (sólo en repos sin el «Blocked» nativo de GitHub)'],
};

const REPO = 'repos/{owner}/{repo}';
const API_ISSUE = (n) => `${REPO}/issues/${n}`;
// La forma interna de un pendiente, a partir de la respuesta REST.
const toIssue = (i) => ({
  number: i.number,
  id: i.id,
  title: i.title,
  state: String(i.state).toUpperCase(),
  labels: (i.labels || []).map((l) => ({ name: typeof l === 'string' ? l : l.name })),
  assignees: (i.assignees || []).map((a) => ({ login: a.login })),
  body: i.body || '',
  url: i.html_url,
});
// La lista de issues de REST incluye los PR: se quitan.
const openIssues = () => apiAll(`${REPO}/issues?state=open`).filter((i) => !i.pull_request).map(toIssue);
export const openPrs = () =>
  apiAll(`${REPO}/pulls?state=open`).map((p) => ({ number: p.number, title: p.title ?? '', url: p.html_url, body: p.body ?? '', draft: Boolean(p.draft), headRefName: p.head.ref, headRefOid: p.head.sha }));

export class UserError extends Error {}

// ---------- lectura ----------

export const stateOf = (issue) =>
  STATES.find((s) => (issue.labels || []).some((l) => l.name === label(s) || l.name === LEGACY[s])) ?? null;

// «Bloqueado por: #n» en el cuerpo: respaldo cuando el repo no tiene la API de dependencias.
export function parseBlockedBy(body = '') {
  const m = body.match(/^##\s+Bloqueado por\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  return m ? [...m[1].matchAll(/#(\d+)/g)].map((x) => Number(x[1])) : [];
}

export function addBlockedBy(body = '', n) {
  if (parseBlockedBy(body).includes(n)) return body;
  if (/^##\s+Bloqueado por\s*$/m.test(body)) return body.replace(/^(##\s+Bloqueado por\s*\n)/m, `$1- #${n}\n`);
  return `${body.trimEnd()}\n\n## Bloqueado por\n- #${n}\n`;
}

function viewIssue(n, { comments = false } = {}) {
  const issue = toIssue(api('GET', API_ISSUE(n)));
  if (comments) issue.comments = apiAll(`${API_ISSUE(n)}/comments`).map((c) => ({ body: c.body || '', author: { login: c.user?.login } }));
  return issue;
}

// Bloqueos abiertos de un pendiente: dependencias nativas de GitHub + la lista del cuerpo.
function openBlockers(issue, openNumbers) {
  const native = api('GET', `${API_ISSUE(issue.number)}/dependencies/blocked_by`, undefined, { allowFail: true }) ?? [];
  const all = new Set([...native.map((i) => i.number), ...parseBlockedBy(issue.body)]);
  return [...all].filter((n) => openNumbers.has(n));
}

// Checks que publica la plataforma (Ghosty Studio) y que NO son el CI del repo: la revisión, la puerta de evidencia,
// la vista previa y las revisiones del push. Lista normativa (SPEC §5c), la misma que el CI_IGNORE de gs. El
// «Ghosty · Smoke» NO va aquí: una ruta que truena contra la vista previa sí frena el merge, así que cuenta como CI.
export const REVIEW_CHECK = 'Ghosty Review';
export const PREVIEW_CHECK = 'Ghosty · Preview';
export const PUSH_CHECK = 'Ghosty · Revisiones del push';
export const SMOKE_CHECK = 'Ghosty · Smoke';
export const NOT_CI_CHECKS = Object.freeze([REVIEW_CHECK, 'ghosty-dev/evidencia', PREVIEW_CHECK, PUSH_CHECK]);
// Además de la lista, todo lo que empiece con `ghosty-dev` es de la propia bitácora (la puerta y sus variantes).
export const isCiCheck = (name = '') => !NOT_CI_CHECKS.includes(name) && !name.startsWith('ghosty-dev');

const RED = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'error'];

// Check-runs (Actions y apps) + statuses clásicos del commit del PR, en una sola lectura.
function commitChecks(sha) {
  const runs = apiAll(`${REPO}/commits/${sha}/check-runs`, { pick: (r) => r.check_runs, allowFail: true }) ?? [];
  const statuses = api('GET', `${REPO}/commits/${sha}/status`, undefined, { allowFail: true })?.statuses ?? [];
  return { runs, statuses };
}

// Veredicto del CI con lo ya leído: sólo los checks que cuentan como CI.
export function ciVerdict({ runs = [], statuses = [] }) {
  const checks = [
    ...runs.map((c) => ({ name: c.name, done: c.status === 'completed', result: c.conclusion })),
    ...statuses.map((c) => ({ name: c.context, done: c.state !== 'pending', result: c.state })),
  ].filter((c) => isCiCheck(c.name || ''));
  // Justo después de un push GitHub aún no registra los checks del commit nuevo: cero checks NO es verde.
  if (checks.length === 0) return 'sin-checks';
  if (checks.some((c) => !c.done)) return 'pendiente';
  return checks.some((c) => RED.includes(c.result)) ? 'rojo' : 'verde';
}

// El check más reciente con ese nombre (al volver a «en curso» la plataforma crea uno nuevo; GitHub enseña el último).
function latestRun(runs, name) {
  const same = runs.filter((r) => r.name === name);
  return same.sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0] ?? null;
}

// Estado de un servicio de la plataforma a partir de su check: pendiente | listo | fallo | neutral | sin-check.
export function serviceOf(run) {
  if (!run) return { status: 'sin-check', title: null, url: null };
  const status = run.status !== 'completed' ? 'pendiente' : run.conclusion === 'success' ? 'listo' : RED.includes(run.conclusion) ? 'fallo' : 'neutral';
  return { status, title: run.output?.title ?? null, url: run.details_url ?? run.html_url ?? null };
}

// Servicios del PR leídos de los checks del commit HEAD. Con `deep`, además la liga del Deployment de la vista
// previa y cuántos comentarios en línea dejó Ghosty Review sobre ese commit (dos llamadas más, sólo cuando se piden).
export function prServices(pr, { deep = false, checks } = {}) {
  const got = checks ?? commitChecks(pr.headRefOid);
  const out = {
    sha: pr.headRefOid,
    preview: serviceOf(latestRun(got.runs, PREVIEW_CHECK)),
    review: serviceOf(latestRun(got.runs, REVIEW_CHECK)),
    smoke: serviceOf(latestRun(got.runs, SMOKE_CHECK)),
    ci: ciVerdict(got),
  };
  if (deep) {
    const dep = (api('GET', `${REPO}/deployments?sha=${pr.headRefOid}&per_page=5`, undefined, { allowFail: true }) ?? [])[0];
    if (dep) {
      const st = (api('GET', `${REPO}/deployments/${dep.id}/statuses?per_page=1`, undefined, { allowFail: true }) ?? [])[0];
      if (st?.environment_url) out.preview.deployment = st.environment_url;
    }
    if (out.review.status !== 'sin-check') {
      const comments = apiAll(`${REPO}/pulls/${pr.number}/comments`, { allowFail: true });
      if (comments) out.review.comments = comments.filter((c) => c.commit_id === pr.headRefOid && c.user?.type === 'Bot').length;
    }
  }
  return out;
}

// CI del PR del pendiente (rama ghosty-dev/<n>-…), sin contar los checks de la plataforma (NOT_CI_CHECKS).
function ciOf(n) {
  const pr = prOf(n);
  if (!pr) return { status: 'sin-pr' };
  const checks = commitChecks(pr.headRefOid);
  return { status: ciVerdict(checks), pr, checks };
}

const me = () => api('GET', 'user').login;

// «dueño/nombre» del repo del cwd: gh lo resuelve con el `git remote`.
export const repoFullName = () => api('GET', REPO).full_name;

// ---------- ready (Beads: bd ready) ----------

export function ready() {
  const open = openIssues();
  const openNumbers = new Set(open.map((i) => i.number));
  let login = null;
  const out = [];
  for (const issue of open.sort((a, b) => a.number - b.number)) {
    const state = stateOf(issue);
    const base = { number: issue.number, title: issue.title, url: issue.url, state };
    if (state === 'tomado' || state === 'esperando') {
      login ??= me();
      const mine = issue.assignees.length === 0 || issue.assignees.some((a) => a.login === login);
      // Ley 3: un pedido nuevo de la persona lo vuelve a ofrecer a su escritor, esté donde esté.
      if (mine && unseenAsks(issue.number).length) {
        out.push({ ...base, reason: 'pedido' });
        continue;
      }
    }
    if (state === 'listo' || state === 'bloqueado') {
      if (openBlockers(issue, openNumbers).length === 0) out.push({ ...base, reason: state === 'listo' ? 'por-hacer' : 'desbloqueado' });
    } else if (state === 'esperando') {
      // Ley 3: se ofrece de nuevo sólo cuando el evento (CI) ya resolvió, y sólo a su escritor.
      login ??= me();
      const mine = issue.assignees.length === 0 || issue.assignees.some((a) => a.login === login);
      const ci = ciOf(issue.number);
      if (mine && ci.status !== 'pendiente' && ci.status !== 'sin-checks') out.push({ ...base, reason: `ci-${ci.status}`, pr: ci.pr?.url ?? null });
    }
  }
  return out;
}

// ---------- claim (Beads: bd update --claim; un solo escritor, Cognition) ----------

const slug = (title) =>
  title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

function setState(issue, state, { assign } = {}) {
  const remove = (issue.labels || []).map((l) => l.name).filter((name) => name.startsWith('ghosty-dev:') && name !== label(state));
  api('POST', `${API_ISSUE(issue.number)}/labels`, { labels: [label(state)] });
  for (const name of remove) api('DELETE', `${API_ISSUE(issue.number)}/labels/${encodeURIComponent(name)}`, undefined, { allowFail: true });
  if (assign) api('POST', `${API_ISSUE(issue.number)}/assignees`, { assignees: [assign] });
}

// La rama del pendiente parte SIEMPRE de la base (origin/<rama principal> o --base), nunca de la rama donde está
// parado el clon (Formmy, fila 34: `claim 83` desde la rama del PR #73 arrastró todo ese PR).
export function claimBase(base) {
  const name = base || api('GET', REPO, undefined, { allowFail: true })?.default_branch || 'main';
  if (!/^[\w./-]{1,200}$/.test(name) || name.startsWith('-')) throw new UserError('--base va con el nombre de una rama.');
  git(['fetch', '--quiet', 'origin', name], { allowFail: true, timeout: 60_000 });
  const remote = `origin/${name}`;
  const ref = git(['rev-parse', '--verify', '--quiet', `${remote}^{commit}`], { allowFail: true }) ? remote : git(['rev-parse', '--verify', '--quiet', `${name}^{commit}`], { allowFail: true }) ? name : null;
  if (!ref) throw new UserError(`No encuentro la rama base ${name} (ni origin/${name}): git fetch origin o --base <rama>.`);
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })?.trim() || null;
  const warning = current && current !== name && current !== 'HEAD' ? `Estás en ${current}; la rama nueva parte de ${ref}, no de ${current}.` : null;
  return { name, ref, warning };
}

export function claim(n, { worktree = true, base, onWarning = () => {} } = {}) {
  const from = worktree ? claimBase(base) : null;
  if (from?.warning) onWarning(from.warning);
  const issue = viewIssue(n);
  if (issue.state !== 'OPEN') throw new UserError(`#${n} está cerrado.`);
  const login = me();
  const other = issue.assignees.find((a) => a.login !== login);
  if (other) throw new UserError(`Un solo escritor por pendiente: #${n} ya lo tiene @${other.login}.`);
  const open = openIssues();
  const blockers = openBlockers(issue, new Set(open.map((i) => i.number)));
  if (blockers.length) throw new UserError(`#${n} está bloqueado por ${blockers.map((b) => '#' + b).join(', ')}.`);

  setState(issue, 'tomado', { assign: login });
  // El primero gana: si otro se asignó al mismo tiempo, me retiro.
  const after = viewIssue(n);
  if (after.assignees.some((a) => a.login !== login)) {
    api('DELETE', `${API_ISSUE(n)}/assignees`, { assignees: [login] });
    throw new UserError(`#${n} lo tomó alguien más al mismo tiempo; toma otro con ghosty-dev ready.`);
  }

  const branch = `ghosty-dev/${n}-${slug(issue.title)}`;
  let path = null;
  if (worktree) {
    const top = git(['rev-parse', '--show-toplevel']).trim();
    path = join(dirname(top), `${basename(top)}-${n}`);
    if (!existsSync(path)) {
      const exists = git(['rev-parse', '--verify', '--quiet', branch], { allowFail: true }) !== null;
      git(exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, from.ref], { cwd: top });
    }
  }
  return { number: n, title: issue.title, branch, worktree: path, base: from?.ref ?? null, warning: from?.warning ?? null };
}

// Adopta lo que ya existe (Formmy, fila 32): un PR abierto a mano o desde una rama propia queda como el trabajo del
// pendiente #n sin rehacer rama ni worktree. Mismas reglas que claim (un solo escritor, sin bloqueos), y el PR gana
// «Closes #n» en su descripción si no lo tenía (así la puerta, gs y `ready` lo ven).
export function adopt(n, m) {
  const issue = viewIssue(n);
  if (issue.state !== 'OPEN') throw new UserError(`#${n} está cerrado.`);
  const login = me();
  const other = issue.assignees.find((a) => a.login !== login);
  if (other) throw new UserError(`Un solo escritor por pendiente: #${n} ya lo tiene @${other.login}.`);
  const blockers = openBlockers(issue, new Set(openIssues().map((i) => i.number)));
  if (blockers.length) throw new UserError(`#${n} está bloqueado por ${blockers.map((b) => '#' + b).join(', ')}.`);
  const pr = prOf(n, m);
  const others = closingRefs(pr.body).filter((x) => x !== n);
  let linked = false;
  if (!closingRefs(pr.body).includes(n)) {
    api('PATCH', `${REPO}/pulls/${m}`, { body: `${pr.body.replace(/\s+$/, '')}${pr.body.trim() ? '\n\n' : ''}Closes #${n}\n` });
    linked = true;
  }
  const state = stateOf(issue);
  if (state !== 'tomado' && state !== 'esperando') setState(issue, 'tomado', { assign: login });
  else if (!issue.assignees.length) api('POST', `${API_ISSUE(n)}/assignees`, { assignees: [login] });
  return { number: n, title: issue.title, pr: m, url: pr.url, branch: pr.headRefName, adopted: true, linked, alsoCloses: others };
}

// ---------- pedidos de la persona (Ley 1 y Ley 3: el comentario es la bitácora y el evento) ----------

// Un pedido = comentario del issue o del PR que menciona a @ghosty o lleva la marca (lo que la persona escribió
// en Ghosty Studio, iOS o Teams se publica así). La evidencia y la revisión no cuentan aunque mencionen.
export const ASK_MARK = '<!-- ghosty-dev:pedido -->';
const MENTION = /(^|[\s(])@ghosty(?![\w-])/i;
export const isAsk = (body = '') =>
  !body.includes('<!-- ghosty-dev:evidencia') && !body.includes('<!-- ghosty-dev:revision') && (body.includes(ASK_MARK) || MENTION.test(body));
const askText = (body) => body.replace(ASK_MARK, '').replace(/(^|[\s(])@ghosty(?![\w-])/gi, '$1').trim();

// Lo ya leído vive en el clon (`.git/ghosty-dev/`), no en GitHub: es de este escritor, no de la bitácora.
function seenFile(n) {
  const dir = join(git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(), 'ghosty-dev');
  return { dir, file: join(dir, `pedidos-${n}.json`) };
}
function readSeen(n) {
  try {
    return JSON.parse(readFileSync(seenFile(n).file, 'utf8'));
  } catch {
    return {};
  }
}
function markSeen(n, list) {
  if (!list.length) return;
  const seen = readSeen(n);
  for (const a of list) seen[a.from] = Math.max(seen[a.from] ?? 0, a.index + 1);
  const { dir, file } = seenFile(n);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(seen));
}
// Un aviso del BOT (no de la persona) que ya no aplica a la cabeza del PR (Formmy, fila 36): nombra un commit que
// no es la cabeza («pasó en el commit bfc298a»), un check que el commit de la cabeza ya no tiene («falló
// (claude-review)»), o es anterior al commit de la cabeza. Un pedido de una persona nunca es obsoleto.
const isBot = (u) => u?.type === 'Bot' || /\[bot\]$/.test(u?.login ?? '');
function staleReason(c, head) {
  if (!head || !isBot(c.user)) return null;
  if (head.closed) return head.closed;
  if (!head.sha) return null;
  const body = String(c.body ?? '');
  const shas = [...body.matchAll(/\bcommit\s+`?([0-9a-f]{7,40})\b/gi)].map((x) => x[1].toLowerCase());
  if (shas.length && !shas.some((s) => head.sha.startsWith(s))) return `habla del commit ${shas[0].slice(0, 7)}; la cabeza del PR es ${head.sha.slice(0, 7)}`;
  const check = body.match(/\bfall[óo]\s*\(([^)\n]{1,100})\)/i)?.[1]?.trim();
  if (check && head.checks && !head.checks.has(check.toLowerCase())) return `el check «${check}» ya no existe en ${head.sha.slice(0, 7)}`;
  if (head.date && c.created_at && Date.parse(c.created_at) < head.date) return `es anterior al commit ${head.sha.slice(0, 7)}`;
  return null;
}

function headOf(pr) {
  if (!pr?.headRefOid) return null;
  const sha = pr.headRefOid.toLowerCase();
  const { runs, statuses } = commitChecks(sha);
  const checks = new Set([...runs.map((r) => r.name), ...statuses.map((s) => s.context)].filter(Boolean).map((x) => String(x).toLowerCase()));
  const c = api('GET', `${REPO}/commits/${sha}`, undefined, { allowFail: true });
  const date = Date.parse(c?.commit?.committer?.date ?? '') || null;
  return { sha, checks: checks.size ? checks : null, date };
}

// { fresh, stale }: los pedidos sin leer; los obsoletos van aparte, nunca se proponen.
function readAsks(n) {
  const seen = readSeen(n);
  const sources = [['issue', n]];
  let pr = prOf(n);
  let head;
  if (pr) sources.push(['pr', pr.number]);
  else {
    // #n mismo es un PR (sus avisos viven en su conversación): su cabeza manda; cerrado, ningún aviso del bot aplica.
    const p = api('GET', `${REPO}/pulls/${n}`, undefined, { allowFail: true });
    if (p?.number) {
      if (p.state !== 'open') head = { closed: `el PR #${n} ya está ${p.merged_at ? 'mezclado' : 'cerrado'}` };
      else pr = { number: p.number, headRefOid: p.head?.sha };
    }
  }
  const fresh = [];
  const stale = [];
  for (const [from, number] of sources) {
    const comments = apiAll(`${API_ISSUE(number)}/comments`, { allowFail: true }) ?? [];
    comments.forEach((c, index) => {
      if (index < (seen[from] ?? 0) || !isAsk(c.body || '')) return;
      const a = { from, index, by: c.user?.login ?? null, text: askText(c.body || ''), url: c.html_url ?? null };
      if (isBot(c.user) && head === undefined) head = headOf(pr);
      const why = staleReason(c, head);
      (why ? stale : fresh).push(why ? { ...a, stale: why } : a);
    });
  }
  return { fresh, stale };
}
const unseenAsks = (n) => readAsks(n).fresh;
const publicAsk = ({ from, by, text, url }) => ({ from, by, text, url });

// Los pedidos nuevos de la persona; al leerlos quedan vistos (con peek, no).
export function asks(n, { peek = false } = {}) {
  const { fresh, stale } = readAsks(n);
  if (!peek) markSeen(n, [...fresh, ...stale]);
  return { number: n, asks: fresh.map(publicAsk), stale: stale.map((a) => ({ ...publicAsk(a), reason: a.stale })) };
}

// ---------- wait (Ley 3; Beads gates «so agents never need to poll») ----------

// Ley 3: esperar no es sondear. Con --watch, una sola llamada bloqueante del CLI espera al CI (el CLI mira cada
// 10 s; el agente no gasta tokens); si tarda más que el tope, el pendiente queda en esperando-ci y el agente sigue con otro.
// La vista previa y la revisión del commit actual se reportan cuando terminan (`onService`), pero no detienen la
// espera ni deciden el veredicto: el CI manda. Al volver, `services` trae su estado final.
const DONE = (s) => s !== 'pendiente' && s !== 'sin-check';
export function wait(n, { watch = false, minutes = 5, onService = () => {} } = {}) {
  const issue = viewIssue(n);
  const state = stateOf(issue);
  if (state !== 'tomado' && state !== 'esperando') throw new UserError(`#${n} no está tomado; primero ghosty-dev claim ${n}.`);
  if (state === 'tomado') setState(issue, 'esperando');
  if (!watch) return { number: n, state: 'esperando' };
  // Un pedido de la persona también es el evento: despierta antes que el CI.
  const news = () => {
    const fresh = unseenAsks(n);
    markSeen(n, fresh);
    return fresh.map(publicAsk);
  };
  let got = news();
  if (got.length) return { number: n, state: 'esperando', asks: got };
  let before = ciOf(n);
  if (!before.pr) return { number: n, state: 'esperando', ci: 'sin-pr' };
  // Lo que ya terminó al empezar no se vuelve a anunciar; sólo los cambios mientras se espera.
  const reported = {};
  const track = (ci) => {
    if (!ci.pr) return;
    const sv = prServices(ci.pr, { checks: ci.checks });
    for (const key of ['preview', 'review']) {
      const sig = `${ci.pr.headRefOid}|${sv[key].status}`;
      if (DONE(sv[key].status) && reported[key] !== sig) onService(key, sv[key]);
      reported[key] = sig;
    }
  };
  const first = prServices(before.pr, { checks: before.checks });
  for (const key of ['preview', 'review']) reported[key] = `${before.pr.headRefOid}|${first[key].status}`;
  // Tras un push, los checks tardan unos segundos en aparecer: se espera a que existan (tope ~90 s).
  const step = Number(process.env.GHOSTY_DEV_REGISTER_WAIT_MS ?? 10_000);
  for (let i = 0; before.status === 'sin-checks' && i < 9; i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, step);
    before = ciOf(n);
    track(before);
  }
  let ci = before;
  const every = Number(process.env.GHOSTY_DEV_WATCH_MS ?? 10_000);
  for (const until = Date.now() + minutes * 60_000; ci.status === 'pendiente' && Date.now() < until; ) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, every);
    got = news();
    if (got.length) return { number: n, state: 'esperando', ci: ci.status, pr: ci.pr?.url ?? null, asks: got };
    ci = ciOf(n);
    track(ci);
  }
  const services = ci.pr ? (prServices(ci.pr, { deep: true, checks: ci.checks })) : null;
  return { number: n, state: 'esperando', ci: ci.status, pr: ci.pr?.url ?? null, timedOut: ci.status === 'pendiente', services };
}


// PR abierto del pendiente: el que se nombra (`--pr <m>`), el de su rama ghosty-dev/<n>-…, o cualquier PR abierto que lo
// cierre («Closes #n»): el trabajo real casi nunca nace con `claim` (un PR a mano, una rama propia), y eso no debe
// dejarlo fuera de la bitácora (Formmy, fila 32).
export function prOf(n, m) {
  const prs = openPrs();
  if (m) {
    const pr = prs.find((p) => p.number === m);
    if (!pr) throw new UserError(`El PR #${m} no está abierto en este repo.`);
    return pr;
  }
  return prs.find((p) => p.headRefName.startsWith(`ghosty-dev/${n}-`)) ?? prs.find((p) => closingRefs(p.body).includes(n)) ?? null;
}

// Los PR abiertos que no cierran ningún pendiente: fuera de la bitácora, la puerta no los puede juzgar.
export const unlinkedPrs = () => openPrs().filter((p) => !p.draft && closingRefs(p.body).length === 0);
// ---------- conflicto con la base (Formmy, fila 33: #73 en CONFLICTING/DIRTY y nada lo dijo) ----------

const sleepMs = (ms) => ms > 0 && Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// `mergeable`/`mergeable_state` del PR. GitHub los calcula en segundo plano: llegan `null` en la primera lectura
// después de un push o de un cambio en la base, así que se reintenta (`tries`).
export function mergeState(m, { tries = 3 } = {}) {
  const delay = Number(process.env.GHOSTY_DEV_MERGE_RETRY_MS ?? 1500);
  for (let i = 0; ; i++) {
    const p = api('GET', `${REPO}/pulls/${m}`, undefined, { allowFail: true });
    if (!p) return null;
    if (p.mergeable !== null || i >= tries - 1) return { mergeable: p.mergeable ?? null, state: p.mergeable_state ?? null, base: p.base?.ref || 'main', head: p.head?.ref ?? null, sha: p.head?.sha ?? null };
    sleepMs(delay);
  }
}

// Archivos en conflicto, calculados en local sin tocar el árbol (git merge-tree, git ≥ 2.38) si ya están los dos
// commits; si no, [] (el comando de abajo los enseña igual).
function conflictFiles(base, sha) {
  if (!sha) return [];
  const r = spawnSync('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', `origin/${base}`, sha], { encoding: 'utf8' });
  if (r.status !== 1) return [];
  return r.stdout.split('\n').slice(1).map((l) => l.trim()).filter(Boolean).slice(0, 50);
}

// null si el PR mezcla limpio (o GitHub no lo sabe aún); si está en conflicto: base, archivos y el comando exacto.
export function conflictOf(m, opts) {
  const st = mergeState(m, opts);
  if (!st || !(st.state === 'dirty' || st.mergeable === false)) return null;
  const files = conflictFiles(st.base, st.sha);
  const command = `git fetch origin && git switch ${st.head ?? '<rama-del-PR>'} && git merge origin/${st.base}`;
  return { base: st.base, head: st.head, files, command, then: 'resuelve los archivos marcados, git add <archivo>, git commit y git push' };
}

export const conflictLine = (pr, c) =>
  `el PR #${pr} está en conflicto con ${c.base}${c.files.length ? ` (${c.files.join(', ')})` : ''}: ${c.command} → ${c.then}`;

export const linkHint = (m) => `ghosty-dev claim --pr ${m} --issue <n>  (sin pendiente: ghosty-dev add "título" --goal … --criteria … y luego ese claim)`;

// Vuelve a correr la puerta del PR del pendiente: publicar evidencia o revisión es el evento que la despierta.
// Se busca el run de la puerta del commit HEAD del PR (head_sha), no de la rama: así sirve para un PR de cualquier rama.
// Si el run sigue corriendo, no hace falta: lee los comentarios en vivo.
function rerunGate(n, pr = prOf(n)) {
  if (!pr?.headRefOid) return null;
  const runs = api('GET', `${REPO}/actions/workflows/evidence-gate.yml/runs?head_sha=${pr.headRefOid}&per_page=1`, undefined, { allowFail: true })?.workflow_runs;
  if (runs?.[0] && api('POST', `${REPO}/actions/runs/${runs[0].id}/rerun`, undefined, { allowFail: true }) !== null) return runs[0].id;
  return null;
}

// ---------- evidence (Ley 2; «proof of work», Symphony) ----------

// Sólo validar, sin `gh` ni red: lo usa una caja de trabajo que no tiene credenciales (la publicación la hace
// quien sí las tiene). `issueFile` = el cuerpo del pendiente, para comparar los criterios.
export function checkEvidence(file, issueFile) {
  if (!file || !existsSync(file)) throw new UserError('Falta --file <evidencia.md>.');
  if (issueFile && !existsSync(issueFile)) throw new UserError(`No existe ${issueFile}.`);
  const { ok, errors } = validateEvidence(readFileSync(file, 'utf8'), issueFile ? readFileSync(issueFile, 'utf8') : '');
  if (!ok) throw new UserError(`Evidencia inválida:\n- ${errors.join('\n- ')}`);
  return { ok: true, criteriaChecked: Boolean(issueFile) };
}

export function checkReview(file) {
  if (!file || !existsSync(file)) throw new UserError('Falta --file <revision.md>.');
  const { ok, errors, open } = validateRevision(readFileSync(file, 'utf8'));
  if (!ok) throw new UserError(`Revisión inválida:\n- ${errors.join('\n- ')}`);
  return { ok: true, open };
}

export function evidence(n, file, { pr: m } = {}) {
  if (!file || !existsSync(file)) throw new UserError('Falta --file <evidencia.md>.');
  const md = readFileSync(file, 'utf8');
  // El lock tiene que coincidir con package.json en lo que se subió: si no, la caja de la preview truena en `npm ci`
  // y la evidencia sería de algo que no arma.
  const lock = repoLock();
  if (lock && !lock.ok) throw new UserError(lock.message);
  const issue = viewIssue(n);
  const { ok, errors } = validateEvidence(md, issue.body);
  if (!ok) throw new UserError(`Evidencia inválida para #${n}:\n- ${errors.join('\n- ')}`);
  const pr = prOf(n, m);
  const url = api('POST', `${API_ISSUE(n)}/comments`, { body: formatEvidence(n, md, pr) }).html_url;
  // Ley 3: publicar la evidencia es el evento que vuelve a correr la puerta del PR (y el workflow también lo hace
  // solo con issue_comment, para la evidencia que se publique por otro lado).
  const rerun = rerunGate(n, pr);
  return { number: n, posted: true, url: url || null, rerun };
}

// ---------- add (Beads: bd create): el agente abre el pendiente desde la plática ----------

export function pendienteBody({ goal, criteria = [], context, discoveredIn }) {
  if (!goal?.trim()) throw new UserError('Falta el objetivo: --goal "qué debe quedar cierto".');
  if (!criteria.length) throw new UserError('Falta al menos un criterio: --criteria "…" (se puede repetir).');
  const parts = ['## Objetivo', goal.trim(), '', '## Criterios de aceptación', ...criteria.map((x) => `- [ ] ${x.trim()}`)];
  const ctx = [discoveredIn ? `Descubierto en #${discoveredIn}.` : '', context?.trim() ?? ''].filter(Boolean).join(' ');
  if (ctx) parts.push('', '## Contexto', ctx);
  return parts.join('\n') + '\n';
}

export function add(title, { goal, criteria, context, blockedBy, discoveredIn } = {}) {
  if (!title?.trim()) throw new UserError('Uso: ghosty-dev add "título" --goal "…" --criteria "…" [--criteria "…"] [--by <m>].');
  const body = pendienteBody({ goal, criteria, context, discoveredIn });
  const created = api('POST', `${REPO}/issues`, { title: title.trim(), body, labels: [label('listo')] });
  const { number, html_url: url } = created;
  if (!number) throw new Error('GitHub no devolvió el número del pendiente.');
  const blocked = blockedBy ? block(number, blockedBy) : null;
  // La persona ve sus pendientes en GitHub: se abre el tablero una vez por tanda (no en cada add).
  const board = openBoardOncePerBatch(url);
  return { number, title: title.trim(), url, blockedBy: blocked?.blockedBy ?? null, board };
}

// ---------- review (Cognition: un escritor, el revisor no comparte contexto; Anthropic: evaluador separado) ----------

// El encargo del revisor: el mismo texto que usa el subagente de Claude Code, sin su frontmatter.
export function reviewBrief(n) {
  const raw = readFileSync(join(ROOT, 'agents', 'ghosty-dev-revisor.md'), 'utf8');
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  return `Revisa el pendiente #${n} de este repo.\n\n${body}\n`;
}

export function review(n, { file, pr: m } = {}) {
  if (!file) return { number: n, brief: reviewBrief(n) };
  if (!existsSync(file)) throw new UserError(`No existe ${file}.`);
  const md = readFileSync(file, 'utf8');
  const { ok, errors, open } = validateRevision(md);
  if (!ok) throw new UserError(`Revisión inválida para #${n}:\n- ${errors.join('\n- ')}`);
  const pr = prOf(n, m);
  if (!pr?.headRefOid) throw new UserError(`#${n} no tiene PR abierto que lo cierre. Si el PR ya existe: ghosty-dev review ${n} --pr <m> (o ghosty-dev claim --pr <m> --issue ${n}).`);
  const url = api('POST', `${API_ISSUE(n)}/comments`, { body: formatRevision(n, pr.headRefOid, md, pr) }).html_url;
  return { number: n, sha: pr.headRefOid, pr: pr.number, open, url: url || null, rerun: rerunGate(n, pr) };
}

// ---------- board: la persona ve los pendientes en GitHub, no en la terminal ----------

const BATCH_MS = 2 * 60_000;
function openBoardOncePerBatch(issueUrl) {
  const repoUrl = issueUrl.replace(/\/issues\/\d+\s*$/, '');
  const stamp = join(tmpdir(), `ghosty-dev-board-${repoUrl.replace(/[^a-z0-9]+/gi, '_')}`);
  try {
    if (Date.now() - statSync(stamp).mtimeMs < BATCH_MS) return null;
  } catch {}
  writeFileSync(stamp, '');
  return board(repoUrl).url;
}

export function board(repoUrl) {
  const base = repoUrl ?? api('GET', REPO).html_url;
  const labels = STATES.map(label).join(',');
  const url = `${base}/issues?q=${encodeURIComponent(`is:issue is:open label:${labels}`)}`;
  if (!process.env.GHOSTY_DEV_NO_OPEN) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    spawnSync(opener, [url], { stdio: 'ignore' });
  }
  return { url };
}

// ---------- block (dependencias nativas de GitHub; Beads: bd dep add) ----------

export function block(n, by) {
  if (!by || by === n) throw new UserError('Uso: ghosty-dev block <n> --by <m> (m distinto de n).');
  const issue = viewIssue(n);
  const blocker = api('GET', API_ISSUE(by));
  const native = api('POST', `${API_ISSUE(n)}/dependencies/blocked_by`, { issue_id: blocker.id }, { allowFail: true });
  if (native === null) {
    api('PATCH', API_ISSUE(n), { body: addBlockedBy(issue.body, by) });
    setState(issue, 'bloqueado');
  } else if (stateOf(issue) !== 'listo') {
    setState(issue, 'listo'); // GitHub ya lo marca «Blocked»: la etiqueta sigue en «por hacer»
  }
  return { number: n, blockedBy: by, via: native === null ? 'cuerpo' : 'github' };
}

// ---------- show (Beads: bd show) ----------

// La ficha del pendiente que publica la plataforma (comentario fijo, editado en su lugar). SPEC §5b.
export const FICHA_MARK = '<!-- ghosty-dev:ficha -->';
export function fichaOf(comments) {
  const c = [...(comments || [])].reverse().find((x) => (x.body || '').startsWith(FICHA_MARK));
  return c ? c.body.slice(FICHA_MARK.length).replace(/<sub>[\s\S]*?<\/sub>/g, '').trim() : null;
}

export function show(n) {
  // #n puede ser un PR (el endpoint de issues también los devuelve): entonces se dice y se muestra como PR, con el
  // pendiente que cierra (Formmy, fila 35: `show 73` decía «cerrado» con #73 PR abierto).
  const raw = api('GET', API_ISSUE(n), undefined, { allowFail: true });
  if (!raw || raw.pull_request) {
    const p = api('GET', `${REPO}/pulls/${n}`, undefined, { allowFail: true });
    if (p?.number) return { kind: 'pr', ...showPr(n) };
  }
  const issue = viewIssue(n, { comments: true });
  const open = openIssues();
  // La ficha vive en el PR (y hoy también en el issue): primero la del PR, si no hay, la del issue.
  const pr = issue.state === 'OPEN' ? prOf(n) : null;
  const prComments = pr ? apiAll(`${API_ISSUE(pr.number)}/comments`, { allowFail: true }) ?? [] : [];
  return {
    kind: 'issue',
    number: issue.number,
    title: issue.title,
    state: issue.state === 'OPEN' ? stateOf(issue) : 'cerrado',
    assignees: issue.assignees.map((a) => a.login),
    blockedBy: openBlockers(issue, new Set(open.map((i) => i.number))),
    evidence: Boolean(findValidEvidence(issue.comments, issue.body)),
    asks: unseenAsks(n).map(publicAsk),
    ficha: fichaOf(prComments) ?? fichaOf(issue.comments),
    pr: pr?.url ?? null,
    // Servicios del PR (vista previa, revisión, smoke y CI) leídos de los checks del commit HEAD del PR.
    services: pr ? prServices(pr, { deep: true }) : null,
    url: issue.url,
  };
}

// Lo mismo que `show`, pero por número de PR: un PR escrito desde la terminal (sin pendiente ni rama
// ghosty-dev/<n>-…) también tiene ficha, servicios y CI. No depende de ningún run de la nube.
export function showPr(m) {
  const p = api('GET', `${REPO}/pulls/${m}`, undefined, { allowFail: true });
  if (!p?.number) throw new UserError(`No encontré el PR #${m} en este repo.`);
  const pr = { number: p.number, url: p.html_url, headRefName: p.head?.ref, headRefOid: p.head?.sha };
  const comments = apiAll(`${API_ISSUE(m)}/comments`, { allowFail: true }) ?? [];
  return {
    pr: p.number,
    title: p.title ?? '',
    state: p.merged_at ? 'mezclado' : p.state === 'open' ? (p.draft ? 'borrador' : 'abierto') : 'cerrado',
    branch: pr.headRefName ?? null,
    closes: [...String(p.body ?? '').matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)].map((x) => Number(x[1])),
    ficha: fichaOf(comments),
    url: pr.url,
    services: pr.headRefOid ? prServices(pr, { deep: true }) : null,
    conflict: p.state === 'open' && !p.merged_at ? conflictOf(m) : null,
  };
}

// ---------- next: el siguiente paso correcto, según el estado del repo (sobrevive a la compactación) ----------

// Lo que se pierde al resumir una sesión es el camino («empieza por claim»), no el destino («publica evidencia»)
// (Formmy, fila 32). `next` lo reconstruye desde la bitácora: rama actual, su PR, el pendiente que cierra, CI,
// revisión del commit HEAD, evidencia y pedidos. Regresa { step, command, why, … }.
// Chequeo del lock en la raíz del clon (null fuera de un repo).
export function repoLock() {
  const top = git(['rev-parse', '--show-toplevel'], { allowFail: true })?.trim();
  return top ? checkLock(top) : null;
}

export function next() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })?.trim() || null;
  const info = api('GET', REPO);
  const def = info.default_branch || 'main';
  const prs = openPrs();
  const pr = branch && branch !== def ? prs.find((p) => p.headRefName === branch) : null;
  const out = (step, command, why, extra = {}) => ({ step, command, why, branch, ...extra });
  if (pr) {
    // Un pedido (de la persona o el automático de gs en el PR, marca ghosty-dev:pedido) va antes que todo.
    const linked = closingRefs(pr.body)[0];
    if (linked && unseenAsks(linked).length) return out('pedido', `ghosty-dev asks ${linked}`, `hay un pedido nuevo en #${linked} o en el PR #${pr.number}: va antes que todo`, { pr: pr.number, issue: linked });
    const lock = repoLock();
    if (lock && !lock.ok) return out('lock', lock.fix, lock.message, { pr: pr.number });
    // Un PR en conflicto no se mezcla aunque todo lo demás esté verde (Formmy, fila 33).
    const conflict = conflictOf(pr.number);
    if (conflict) return out('conflicto', conflict.command, `${conflictLine(pr.number, conflict)}; va antes que revisión o evidencia`, { pr: pr.number, conflict });
    const refs = closingRefs(pr.body);
    if (!refs.length) return out('ligar', `ghosty-dev claim --pr ${pr.number} --issue <n>`, `el PR #${pr.number} no está ligado a un pendiente; si no hay pendiente: ghosty-dev add "título" --goal … --criteria … y luego ese claim`, { pr: pr.number });
    const n = refs[0];
    const extra = { pr: pr.number, issue: n };
    if (pr.draft) return out('iterar', `gh pr ready ${pr.number}`, 'el PR es borrador: la puerta no exige nada hasta marcarlo listo; termina y márcalo', extra);
    const checks = commitChecks(pr.headRefOid);
    const ci = ciVerdict(checks);
    if (ci === 'pendiente' || ci === 'sin-checks') return out('esperar-ci', `ghosty-dev wait --pr ${pr.number} --until ci`, `el CI del commit ${pr.headRefOid.slice(0, 7)} no ha resuelto`, extra);
    if (ci === 'rojo') return out('arreglar-ci', `ghosty-dev show --pr ${pr.number}`, 'el CI salió rojo: arréglalo en la rama y vuelve a subir', extra);
    const issue = viewIssue(n, { comments: true });
    const rev = findRevisionFor(issue.comments, pr.headRefOid);
    if (!rev) return out('revision', `ghosty-dev review ${n} --pr ${pr.number}`, `falta la revisión del commit ${pr.headRefOid.slice(0, 7)} (otra sesión con contexto limpio: subagente ghosty-dev-revisor)`, extra);
    if (rev.open > 0) return out('hallazgos', `ghosty-dev review ${n} --pr ${pr.number}`, `la revisión tiene ${rev.open} hallazgo(s) abierto(s): arréglalos, sube y pide revisión otra vez`, extra);
    if (!findValidEvidence(issue.comments, issue.body))
      return out('evidencia', `ghosty-dev evidence ${n} --pr ${pr.number} --file evidencia.md`, 'CI verde y revisión limpia: prueba la vista previa (ghosty-dev preview --wait) y publica la evidencia', extra);
    return out('listo', null, `#${n} tiene revisión y evidencia del commit actual: la persona lee la evidencia y mezcla el PR #${pr.number}`, extra);
  }
  const own = branch?.match(/^ghosty-dev\/(\d+)-/);
  if (own) return out('abrir-pr', `git push -u origin HEAD && gh pr create --fill --body "Closes #${own[1]}"`, `la rama de #${own[1]} no tiene PR abierto`, { issue: Number(own[1]) });
  if (branch && branch !== def) return out('ligar', `gh pr create --fill --body "Closes #<n>"  (o, si es de un pendiente: ghosty-dev claim <n>)`, `la rama ${branch} no tiene PR ni pendiente: el trabajo tiene que vivir en la bitácora`);
  const list = ready();
  if (list.length) {
    const first = list[0];
    const command = first.reason === 'pedido' ? `ghosty-dev asks ${first.number}` : first.state === 'esperando' ? `ghosty-dev show ${first.number}` : `ghosty-dev claim ${first.number}`;
    return out('tomar', command, `#${first.number} ${first.title} (${first.reason})`, { issue: first.number });
  }
  const loose = prs.filter((p) => !p.draft && closingRefs(p.body).length === 0);
  if (loose.length) return out('ligar', `ghosty-dev claim --pr ${loose[0].number} --issue <n>`, `el PR #${loose[0].number} no está ligado a un pendiente`, { pr: loose[0].number });
  return out('nada', 'ghosty-dev add "título" --goal … --criteria …', 'no hay pendientes listos: abre uno con lo que la persona pida');
}

// ---------- close (Beads: bd close, pero sólo con evidencia — Ley 2) ----------

export function close(n) {
  const issue = viewIssue(n, { comments: true });
  if (!findValidEvidence(issue.comments, issue.body)) {
    throw new UserError(`#${n} no tiene comentario de evidencia válido: no se cierra. Usa ghosty-dev evidence ${n} --file evidencia.md.`);
  }
  api('PATCH', API_ISSUE(n), { state: 'closed', state_reason: 'completed' });
  return { number: n, state: 'cerrado' };
}

// ---------- init (Beads: bd init escribe AGENTS.md e instala la skill) ----------

const AGENTS_MARK = '<!-- ghosty-dev:agents -->';
const AGENTS_END = '<!-- /ghosty-dev:agents -->';

// Reemplaza sólo la sección de ghosty-dev en un AGENTS.md ajeno. Sin marca de cierre (v0.1), la sección termina
// en el siguiente encabezado «## » que no sea el suyo, o al final del archivo.
export function replaceAgentsSection(text, section) {
  const start = text.indexOf(AGENTS_MARK);
  let end = text.indexOf(AGENTS_END, start);
  if (end !== -1) end += AGENTS_END.length;
  else {
    const own = text.indexOf('\n## ', start);
    const next = own === -1 ? -1 : text.indexOf('\n## ', own + 1);
    end = next === -1 ? text.length : next;
  }
  return `${text.slice(0, start)}${section.trimEnd()}\n${text.slice(end).replace(/^\n*/, '\n')}`.replace(/\n+$/, '\n');
}

// ---------- puerta obligatoria (Ley 2): el check ghosty-dev/evidencia se exige en la rama principal ----------

export const GATE_CHECK = 'ghosty-dev/evidencia';

// Agrega el check a la protección de la rama sin pisar la que ya exista. Usa el gh de la persona: hace falta ser
// admin del repo (en privados, además, un plan de pago de GitHub). Si no se puede, devuelve el motivo.
export function protect(dir) {
  const info = api('GET', REPO, undefined, { cwd: dir, allowFail: true });
  if (!info) return { ok: false, reason: 'no se pudo leer el repo con gh' };
  const repo = { nameWithOwner: info.full_name };
  const branch = info.default_branch || 'main';
  // La Action corre la puerta desde la rama base: si todavía no está ahí, exigir el check bloquearía TODOS los PR.
  const onBase = api('GET', `repos/${repo.nameWithOwner}/contents/.github/ghosty-dev/gate.mjs?ref=${branch}`, undefined, { cwd: dir, allowFail: true });
  if (onBase == null) return { ok: false, later: true, branch, reason: `la puerta todavía no está en ${branch}` };
  const base = `repos/${repo.nameWithOwner}/branches/${branch}/protection`;
  const has = api('GET', base, undefined, { cwd: dir, allowFail: true });
  let done;
  if (has == null) {
    const body = { required_status_checks: { strict: false, contexts: [GATE_CHECK] }, enforce_admins: false, required_pull_request_reviews: null, restrictions: null };
    done = api('PUT', base, body, { cwd: dir, allowFail: true });
  } else {
    const current = has.required_status_checks;
    if (current?.contexts?.includes(GATE_CHECK)) return { ok: true, repo: repo.nameWithOwner, branch, already: true };
    done = current
      ? api('POST', `${base}/required_status_checks/contexts`, { contexts: [GATE_CHECK] }, { cwd: dir, allowFail: true })
      : api('PATCH', `${base}/required_status_checks`, { strict: false, contexts: [GATE_CHECK] }, { cwd: dir, allowFail: true });
  }
  if (done == null) return { ok: false, branch, reason: 'GitHub no dejó proteger la rama (¿eres admin? en repos privados pide plan de pago)' };
  return { ok: true, repo: repo.nameWithOwner, branch };
}

// `protect --dry-run`: qué PR abiertos quedarían bloqueados si el check se vuelve obligatorio, y por qué. No escribe
// nada. Un borrador no bloquea (la puerta lo deja pasar hasta marcarlo listo), pero se lista aparte.
export function protectPreview(dir) {
  const info = api('GET', REPO, undefined, { cwd: dir, allowFail: true });
  if (!info) throw new UserError('No se pudo leer el repo con gh.');
  const repo = info.full_name;
  const branch = info.default_branch || 'main';
  const gateOnBase = api('GET', `repos/${repo}/contents/.github/ghosty-dev/gate.mjs?ref=${branch}`, undefined, { cwd: dir, allowFail: true }) != null;
  const protection = api('GET', `repos/${repo}/branches/${branch}/protection`, undefined, { cwd: dir, allowFail: true });
  const already = Boolean(protection?.required_status_checks?.contexts?.includes(GATE_CHECK));
  const fetchIssue = (n) => ({
    body: api('GET', API_ISSUE(n), undefined, { cwd: dir, allowFail: true })?.body || '',
    comments: apiAll(`${API_ISSUE(n)}/comments`, { cwd: dir, allowFail: true }) ?? [],
  });
  const prs = (apiAll(`${REPO}/pulls?state=open`, { cwd: dir, allowFail: true }) ?? []).filter((p) => p.base?.ref === undefined || p.base.ref === branch);
  const blocked = [];
  const drafts = [];
  const passing = [];
  const informative = [];
  for (const p of prs) {
    const row = { pr: p.number, title: p.title ?? '', url: p.html_url ?? null };
    if (p.draft) {
      drafts.push({ ...row, reason: 'borrador: la puerta no lo bloquea hasta marcarlo listo' });
      continue;
    }
    let unlinked = 'block';
    try {
      unlinked = unlinkedPolicy(readFileSync(join(dir, '.github/ghosty-dev/config.json'), 'utf8'));
    } catch {}
    const r = evaluatePullRequest(p, fetchIssue, null, { unlinked });
    if (r.informative) informative.push({ ...row, reason: r.lines[0] });
    else if (r.ok) passing.push(row);
    else blocked.push({ ...row, reasons: r.lines.filter((l) => !/válida\.$|sin hallazgos abiertos\.$|sin hallazgos\.$|^Informativo:/.test(l)) });
  }
  return { repo, branch, gateOnBase, already, blocked, drafts, informative, passing };
}

// Antes de escribir: a qué repo y rama va, qué etiquetas faltan y qué workflows dispara un push a la rama principal.
export function initTarget(dir) {
  const info = api('GET', REPO, undefined, { cwd: dir, allowFail: true });
  if (!info) throw new UserError('No se pudo leer el repo con gh: ¿esta carpeta tiene un remoto de GitHub?');
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, allowFail: true })?.trim() || null;
  const defaultBranch = info.default_branch || 'main';
  const have = (apiAll(`${REPO}/labels`, { cwd: dir, allowFail: true }) ?? []).map((l) => l.name);
  return {
    repo: info.full_name,
    branch,
    defaultBranch,
    labelsToCreate: STATES.map(label).filter((n) => !have.includes(n)),
    pushWorkflows: pushWorkflows(dir, defaultBranch),
  };
}

// ---------- manifiesto de la fábrica: .ghosty/factory.md con la memoria de la caja ----------

// gs lee `memory:` del frontmatter (4gb la de siempre, 8gb el tope, múltiplos de 1 GB) y Teams lee del mismo
// archivo los roles y el cuerpo. Sin el archivo, la caja nace con 4 GB y un build pesado revienta (Formmy, 22-nov).
export const FACTORY_FILE = '.ghosty/factory.md';
const MONOREPO_FILES = ['pnpm-workspace.yaml', 'lerna.json', 'turbo.json', 'nx.json', 'rush.json'];

// Valor inicial sin correr nada: sólo mira archivos. Devuelve { memory, why }.
export function detectBoxMemory(dir) {
  let pkg = null;
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {}
  const signals = [];
  if (pkg?.workspaces) signals.push('package.json declara workspaces (monorepo)');
  for (const f of MONOREPO_FILES) if (existsSync(join(dir, f))) signals.push(`hay ${f} (monorepo)`);
  const heavy = Object.entries(pkg?.scripts ?? {}).find(([, s]) => /--max[-_]old[-_]space[-_]size/.test(String(s)));
  if (heavy) signals.push(`el script «${heavy[0]}» sube el heap de Node (--max-old-space-size)`);
  if (signals.length) return { memory: '8gb', why: signals.join('; ') };
  return { memory: '4gb', why: 'no hay señales de monorepo ni de build pesado (la caja de siempre)' };
}

export function factoryManifest({ memory, why }) {
  return `---
# Memoria de la caja de trabajo de Ghosty (instalar, construir y probar): de 4gb a 8gb, múltiplos de 1 GB.
memory: ${memory}
---
Configuración de la fábrica de Ghosty Studio para este repo.

- \`memory:\` es la memoria de la caja donde los agentes instalan, construyen y prueban este repo (y la de su
  preview). Va de 4gb (la de siempre) a 8gb (el tope), en múltiplos de 1 GB; la de 8gb cuenta como dos cajas
  del plan. \`ghosty-dev init\` eligió ${memory} porque ${why}.
- Si el build revienta por memoria («JavaScript heap out of memory», «Killed», código 137), mide el pico con
  \`/usr/bin/time -v npm run build\` en Linux («Maximum resident set size») o \`/usr/bin/time -l npm run build\`
  en macOS, deja ~1 GB de holgura y sube \`memory:\`. El cambio aplica a la siguiente caja que nazca.
- Abajo de esta lista van las convenciones del repo que deben saber los agentes (pruebas, estilo, qué no tocar).
`;
}

// Dónde va el pre-push: core.hooksPath si lo hay (husky, lefthook), si no .git/hooks. Un hook ajeno no se pisa.
function prePushTarget(dir) {
  const custom = git(['config', '--get', 'core.hooksPath'], { cwd: dir, allowFail: true })?.trim();
  const hooks = custom ? resolve(dir, custom) : git(['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], { cwd: dir, allowFail: true })?.trim();
  if (!hooks) return { action: 'skip', shown: 'pre-push', why: 'no es un clon de git' };
  const path = join(hooks, 'pre-push');
  const shown = custom ? join(custom, 'pre-push') : '.git/hooks/pre-push';
  if (existsSync(path) && !readFileSync(path, 'utf8').includes(HOOK_MARK)) return { action: 'skip', path, shown, why: 'ya hay un pre-push propio: agrégale «ghosty-dev check-lock»' };
  return { action: 'write', path, shown };
}

// `labels: false`: no crea las etiquetas en GitHub (la persona no lo confirmó); quedan en el plan como «skip».
export function init(dir, { dryRun = false, force = false, protectBranch = true, labels = true } = {}) {
  const files = [
    ['templates/pendiente.md', '.github/ISSUE_TEMPLATE/pendiente.md'],
    ['.github/workflows/evidence-gate.yml', '.github/workflows/evidence-gate.yml'],
    // Revisiones de Ghosty: llama al workflow reutilizable blissito/ghosty-dev/.github/workflows/checks.yml@v1.
    ['templates/ghosty-checks.yml', '.github/workflows/ghosty-checks.yml'],
    ['src/evidence.mjs', '.github/ghosty-dev/evidence.mjs'],
    ['src/gate.mjs', '.github/ghosty-dev/gate.mjs'],
    ['skill/SKILL.md', '.claude/skills/ghosty-dev/SKILL.md'],
    ['agents/ghosty-dev-revisor.md', '.claude/agents/ghosty-dev-revisor.md'],
  ];
  const plan = [];
  for (const state of STATES) plan.push(labels ? { action: 'label', name: label(state) } : { action: 'skip', name: `${label(state)} (etiqueta no creada: confirma con ghosty-dev init --yes)` });
  for (const [, to] of files) {
    const exists = existsSync(join(dir, to));
    plan.push({ action: exists && !force ? 'skip' : 'write', path: to });
  }
  const agentsPath = join(dir, 'AGENTS.md');
  const agentsText = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : null;
  const agentsAction =
    agentsText === null ? 'write' : !agentsText.includes(AGENTS_MARK) ? 'append' : force ? 'update' : 'skip';
  plan.push({ action: agentsAction, path: 'AGENTS.md' });
  // El manifiesto es configuración del repo (memoria, equipo, setup): ni --force lo pisa, porque la persona
  // pudo haberlo ajustado a mano y un --force al actualizar ghosty-dev se lo borraría.
  const factoryPath = join(dir, FACTORY_FILE);
  const box = existsSync(factoryPath) ? null : detectBoxMemory(dir);
  plan.push(
    box
      ? { action: 'write', path: FACTORY_FILE, memory: box.memory, why: box.why, name: `${FACTORY_FILE} (memory: ${box.memory}: ${box.why})` }
      : { action: 'skip', path: FACTORY_FILE, name: `${FACTORY_FILE} (ya existe: no se toca, ni con --force)` },
  );
  const hook = prePushTarget(dir);
  plan.push(hook.action === 'write' ? { action: 'write', path: hook.shown, name: `${hook.shown} (chequeo del lock antes de subir)` } : { action: 'skip', path: hook.shown, name: `${hook.shown} (${hook.why})` });
  if (protectBranch) plan.push({ action: 'gate', name: `${GATE_CHECK} obligatorio en la rama principal` });
  if (dryRun) return plan;
  if (hook.action === 'write') {
    mkdirSync(dirname(hook.path), { recursive: true });
    writeFileSync(hook.path, PRE_PUSH, { mode: 0o755 });
  }

  for (const state of labels ? STATES : []) {
    const [color, description] = LABEL_STYLE[state];
    if (LEGACY[state]) api('PATCH', `${REPO}/labels/${encodeURIComponent(LEGACY[state])}`, { new_name: label(state) }, { cwd: dir, allowFail: true });
    // Crear; si ya existe (422), actualizar color y descripción.
    if (api('POST', `${REPO}/labels`, { name: label(state), color, description }, { cwd: dir, allowFail: true }) === null)
      api('PATCH', `${REPO}/labels/${encodeURIComponent(label(state))}`, { color, description }, { cwd: dir });
  }
  for (const [from, to] of files) {
    const target = join(dir, to);
    if (existsSync(target) && !force) continue;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(ROOT, from), target);
  }
  if (box) {
    mkdirSync(dirname(factoryPath), { recursive: true });
    writeFileSync(factoryPath, factoryManifest(box));
  }
  const agentsSection = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  if (agentsAction === 'write') writeFileSync(agentsPath, agentsSection);
  if (agentsAction === 'append') appendFileSync(agentsPath, `\n${agentsSection}`);
  if (agentsAction === 'update') writeFileSync(agentsPath, replaceAgentsSection(agentsText, agentsSection));
  if (protectBranch) {
    const r = protect(dir);
    const step = plan[plan.length - 1];
    if (r.ok) step.name = `${GATE_CHECK} obligatorio en ${r.branch}${r.already ? ' (ya estaba)' : ''}`;
    else if (r.later) Object.assign(step, { action: 'later', name: `${GATE_CHECK}: sube estos archivos directo a ${r.branch} y luego corre ghosty-dev protect` });
    else Object.assign(step, { action: 'skip', name: `${GATE_CHECK}: ${r.reason}. Márcalo en Settings → Branches.` });
  }
  return plan;
}
