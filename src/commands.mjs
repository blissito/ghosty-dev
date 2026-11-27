// Comandos de la bitácora. Cada uno se traza a una ley o a una fuente (ver SPEC.md, «Qué copiamos y de quién»).
import { prepareWorktree } from './worktree-deps.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { api, apiAll, git } from './gh.mjs';
import { GATE_CHECKS, validateEvidence, formatEvidence, findValidEvidence, findRevisionFor, validateRevision, formatRevision, crossPreviewProblems, manualCriteria, pendingVerification, formatConfirmation, criterionKey } from './evidence.mjs';
import { closingRefs, evaluatePullRequest, unlinkedPolicy, reviewCheckConfig, externalReview, DEFAULT_REVIEW_CHECK } from './gate.mjs';
import { readinessOf, prepareBrief, isPreparationIssue, READINESS_READS, PREPARE_TITLE } from './readiness.mjs';
import { pushWorkflows } from './workflows.mjs';
import { isPrivateRepo, PRIVATE_WHY, ACTIONS_WORKFLOWS } from './private.mjs';
import { deployConfig, deployMarkers, DEPLOY_HOWTO } from './deploy-config.mjs';
import { HOOK_MARK, PRE_PUSH, checkLock } from './lock.mjs';
import { UserError, refText, fmtRef, sameRepo, repoOfDir, suspectRepo } from './ref.mjs';

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
// El repo sobre el que trabajan los comandos: GH_REPO (lo fija la referencia owner/repo#n) o el del directorio.
export const effectiveRepo = () => process.env.GH_REPO || repoOfDir();
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

export { UserError };

// Los shas de los commits de un PR (null = no se pudo leer).
export const prCommits = (n) => apiAll(`${REPO}/pulls/${n}/commits`, { allowFail: true })?.map((c) => c.sha) ?? null;

// ---------- lectura ----------

export const stateOf = (issue) =>
  STATES.find((s) => (issue.labels || []).some((l) => l.name === label(s) || l.name === LEGACY[s])) ?? null;

// «Bloqueado por: #n» en el cuerpo: respaldo cuando el repo no tiene la API de dependencias.
export function parseBlockedBy(body = '') {
  const m = body.match(/^##\s+Bloqueado por\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  return m ? [...m[1].matchAll(/(?<![\w./-])#(\d+)/g)].map((x) => Number(x[1])) : [];
}

// Los bloqueos de OTRO repo del cuerpo («- owner/repo#m»), como texto.
export function parseForeignBlockedBy(body = '') {
  const m = body.match(/^##\s+Bloqueado por\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  return m ? [...m[1].matchAll(/([A-Za-z0-9][\w-]*\/[\w.-]+#\d+)/g)].map((x) => x[1]) : [];
}

// `n` es un número del mismo repo o el texto «owner/repo#m» de otro.
export function addBlockedBy(body = '', n) {
  const text = typeof n === 'number' ? `#${n}` : n;
  if (typeof n === 'number' ? parseBlockedBy(body).includes(n) : parseForeignBlockedBy(body).includes(n)) return body;
  if (/^##\s+Bloqueado por\s*$/m.test(body)) return body.replace(/^(##\s+Bloqueado por\s*\n)/m, `$1- ${text}\n`);
  return `${body.trimEnd()}\n\n## Bloqueado por\n- ${text}\n`;
}

function viewIssue(n, { comments = false } = {}) {
  const issue = toIssue(api('GET', API_ISSUE(n)));
  if (comments) issue.comments = apiAll(`${API_ISSUE(n)}/comments`).map((c) => ({ body: c.body || '', author: { login: c.user?.login } }));
  return issue;
}

// Bloqueos abiertos de un pendiente: dependencias nativas de GitHub + la lista del cuerpo.
// Los de este repo van como número; los de otro repo (dependencia nativa o «owner/repo#m» en el cuerpo) como texto
// «owner/repo#m», y sólo si siguen abiertos.
function openBlockers(issue, openNumbers) {
  const native = api('GET', `${API_ISSUE(issue.number)}/dependencies/blocked_by`, undefined, { allowFail: true }) ?? [];
  const home = effectiveRepo() ?? null;
  const foreign = (i) => {
    const repo = String(i.repository_url ?? '').match(/repos\/([^/]+\/[^/]+)$/)?.[1];
    return repo && home && !sameRepo(repo, home) ? repo : null;
  };
  const all = new Set([...native.filter((i) => !foreign(i)).map((i) => i.number), ...parseBlockedBy(issue.body)]);
  const out = [...all].filter((n) => openNumbers.has(n));
  for (const i of native) {
    const repo = foreign(i);
    if (repo && String(i.state).toLowerCase() === 'open') out.push(fmtRef(repo, i.number));
  }
  for (const ref of parseForeignBlockedBy(issue.body)) {
    const [repo, num] = ref.split('#');
    const other = api('GET', `repos/${repo}/issues/${num}`, undefined, { allowFail: true });
    if (other && String(other.state).toLowerCase() === 'open' && !out.includes(ref)) out.push(ref);
  }
  return out;
}
const blockerText = (b) => (typeof b === 'number' ? `#${b}` : b);

// Checks que publica la plataforma (Ghosty Studio) y que NO son el CI del repo: la revisión, la puerta de evidencia,
// la vista previa y las revisiones del push. Lista normativa (SPEC §5c), la misma que el CI_IGNORE de gs. El
// «Ghosty · Smoke» NO va aquí: una ruta que truena contra la vista previa sí frena el merge, así que cuenta como CI.
export const REVIEW_CHECK = 'Ghosty Review';
export const PREVIEW_CHECK = 'Ghosty · Preview';
export const PUSH_CHECK = 'Ghosty · Revisiones del push';
export const SMOKE_CHECK = 'Ghosty · Smoke';
export const NOT_CI_CHECKS = Object.freeze([REVIEW_CHECK, ...GATE_CHECKS, PREVIEW_CHECK, PUSH_CHECK]);
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
    // La puerta de evidencia (Ley 2): lo que casi siempre falta al final, y lo que `wait` debe decir que falta.
    gate: serviceOf(latestRun(got.runs, GATE_CHECK)),
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

// ---------- build antes del push (Formmy, fila 52) ----------

// Archivos que sólo el build juzga bien: rutas, módulos *.server / *.client, config del bundler. Un import de servidor
// en el cliente pasa pruebas y tsc y rompe el build de Vite («Server-only module referenced by client»).
export const BUILD_SENSITIVE = /(^|\/)(routes?|pages|app\/routes)\/|(^|\/)(routes|root|entry\.(client|server))\.[cm]?[jt]sx?$|\.(server|client)\.[cm]?[jt]sx?$|(^|\/)(vite|remix|next|astro|svelte)\.config\.[cm]?[jt]s$/;
export function buildHint({ files } = {}) {
  const top = repoTop();
  if (!top) return null;
  let script = null;
  try {
    const pkg = JSON.parse(readFileSync(join(top, 'package.json'), 'utf8'));
    script = pkg.scripts?.build ? 'npm run build' : null;
  } catch {}
  if (!script) return null;
  if (!files) {
    const base = git(['rev-parse', '--abbrev-ref', 'origin/HEAD'], { allowFail: true, cwd: top })?.trim() || 'origin/main';
    files = (git(['diff', '--name-only', `${base}...HEAD`], { allowFail: true, cwd: top }) ?? '').split('\n').filter(Boolean);
  }
  const hit = files.filter((f) => BUILD_SENSITIVE.test(f));
  if (!hit.length) return null;
  return `este push toca ${hit.length === 1 ? hit[0] : `${hit.length} archivos de rutas o servidor/cliente (${hit.slice(0, 3).join(', ')}${hit.length > 3 ? '…' : ''})`}: corre ${script} antes de subir. Pruebas y tsc no ven un import de servidor en el cliente; la vista previa sí, y con el build roto el merge se frena.`;
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
export function claimBase(base, { onProgress = () => {} } = {}) {
  const name = base || api('GET', REPO, undefined, { allowFail: true })?.default_branch || 'main';
  if (!/^[\w./-]{1,200}$/.test(name) || name.startsWith('-')) throw new UserError('--base va con el nombre de una rama.');
  onProgress(`trayendo origin/${name}…`);
  const fetched = git(['fetch', '--quiet', 'origin', name], { allowFail: true, timeout: 60_000 }) !== null;
  const remote = `origin/${name}`;
  const ref = git(['rev-parse', '--verify', '--quiet', `${remote}^{commit}`], { allowFail: true }) ? remote : git(['rev-parse', '--verify', '--quiet', `${name}^{commit}`], { allowFail: true }) ? name : null;
  if (!ref) throw new UserError(`No encuentro la rama base ${name} (ni origin/${name}): git fetch origin o --base <rama>.`);
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })?.trim() || null;
  const warning =
    [current && current !== name && current !== 'HEAD' ? `Estás en ${current}; la rama nueva parte de ${ref}, no de ${current}.` : null, fetched ? null : `no pude traer origin/${name} en 60 s; parto de lo que ya hay en tu clon (${ref}).`]
      .filter(Boolean)
      .join(' ') || null;
  return { name, ref, warning };
}

// Tope del `git worktree add` (Formmy, fila 51: 4 min sin decir nada). GHOSTY_DEV_WORKTREE_TIMEOUT_MS lo cambia.
const WORKTREE_TIMEOUT_MS = () => Number(process.env.GHOSTY_DEV_WORKTREE_TIMEOUT_MS ?? 180_000);

/**
 * Suelta tu claim local de #n (lo contrario de `claim`, sin tocar la nube): quita tu assignee, restituye
 * `ghosty-dev:por-hacer` y deja un comentario de rastro con el motivo. Rechaza si otra persona lo tiene.
 * (El run vivo en la nube lo revisa el CLI antes: aquí sólo se habla con GitHub.)
 */
export function unclaim(n, { reason } = {}) {
  const issue = viewIssue(n);
  if (issue.state !== 'OPEN') throw new UserError(`#${n} está cerrado: no hay nada que soltar.`);
  const login = me();
  const other = issue.assignees.find((a) => a.login !== login);
  if (other) throw new UserError(`#${n} lo tiene @${other.login}, no tú: sólo esa persona puede soltarlo.`);
  const mine = issue.assignees.some((a) => a.login === login);
  const wasState = stateOf(issue);
  if (!mine && wasState === 'listo') return { number: n, title: issue.title, released: false, state: 'listo', url: issue.url };
  if (mine) api('DELETE', `${API_ISSUE(n)}/assignees`, { assignees: [login] });
  setState(issue, 'listo');
  const why = String(reason ?? '').replace(/<!--[\s\S]*?-->/g, '').trim().slice(0, 500);
  const posted = api('POST', `${API_ISSUE(n)}/comments`, { body: `Soltado por @${login} con \`ghosty-dev unclaim\`: vuelve a «por hacer».${why ? ` Motivo: ${why}` : ''}` }, { allowFail: true });
  return { number: n, title: issue.title, released: true, wasState, state: 'listo', reason: why || null, traced: Boolean(posted), url: issue.url };
}

export function claim(n, { worktree = true, base, deps = 'install', onWarning = () => {}, onProgress = () => {} } = {}) {
  const from = worktree ? claimBase(base, { onProgress }) : null;
  if (from?.warning) onWarning(from.warning);
  const issue = viewIssue(n);
  if (issue.state !== 'OPEN') throw new UserError(`#${n} está cerrado.`);
  const home = effectiveRepo();
  const suspect = suspectRepo(issue, home);
  if (suspect) onWarning(`este pendiente parece de ${suspect}; usa \`ghosty-dev claim ${suspect}#N\` (el número que tenga allá) o ábrelo allí con \`ghosty-dev add --repo ${suspect}\`. Sigo en ${home ?? 'este repo'}#${n}.`);
  const login = me();
  const other = issue.assignees.find((a) => a.login !== login);
  if (other) throw new UserError(`Un solo escritor por pendiente: #${n} ya lo tiene @${other.login}.`);
  const open = openIssues();
  const blockers = openBlockers(issue, new Set(open.map((i) => i.number)));
  if (blockers.length) throw new UserError(`#${n} está bloqueado por ${blockers.map(blockerText).join(', ')}.`);

  onProgress(`tomando #${n} en GitHub…`);
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
      const limit = WORKTREE_TIMEOUT_MS();
      onProgress(`creando worktree en ${path} (rama ${branch}; tope ${Math.round(limit / 1000)} s)…`);
      const t0 = Date.now();
      try {
        git(exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, from.ref], { cwd: top, timeout: limit });
      } catch (e) {
        if (!e.timedOut) throw e;
        // A medias no sirve: se quita para que el siguiente claim lo vuelva a crear entero.
        git(['worktree', 'remove', '--force', path], { cwd: top, allowFail: true });
        git(['worktree', 'prune'], { cwd: top, allowFail: true });
        throw new UserError(
          `git worktree add tardó más de ${Math.round(limit / 1000)} s y lo detuve (casi siempre un hook post-checkout que instala dependencias, Git LFS o un checkout muy grande). ` +
            `#${n} ya es tuyo; reintenta con ghosty-dev claim ${n}, súbele el tope con GHOSTY_DEV_WORKTREE_TIMEOUT_MS=600000, o trabaja en este clon con ghosty-dev claim ${n} --no-worktree.`,
        );
      }
      const secs = Math.round((Date.now() - t0) / 1000);
      if (secs >= 10) onProgress(`worktree listo en ${secs} s.`);
    }
    // Listo para trabajar: dependencias (y typegen de React Router) sin pasos a mano.
    const prep = prepareWorktree(path, top, { mode: deps, onProgress });
    if (prep.warning) onWarning(prep.warning);
  }
  return { number: n, title: issue.title, branch, worktree: path, base: from?.ref ?? null, warning: from?.warning ?? null };
}

// `ghosty-dev pr [<n>]`: sube la rama actual y abre (o adopta) su PR ligado a #n, sin pasar por gh. #n sale del
// argumento o del nombre de la rama (`ghosty-dev/<n>-…`). Funciona con cualquier rama: la que hizo claim o una hecha a
// mano (así lo que se trabajó fuera del CLI entra a la bitácora en un paso).
const currentBranch = () => git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })?.trim() || null;
const defaultBranchName = () => api('GET', REPO, undefined, { allowFail: true })?.default_branch || 'main';

export function openPr(n, { branch = currentBranch(), draft = false } = {}) {
  const def = defaultBranchName();
  if (!branch || branch === def) throw new UserError(`Estás en ${branch || 'ninguna rama'}: cambia a la rama del trabajo (o crea una con ghosty-dev claim <n>).`);
  const own = branch.match(/^ghosty-dev\/(\d+)-/);
  const number = n ?? (own ? Number(own[1]) : null);
  if (!number) throw new UserError(`¿De qué pendiente es la rama ${branch}? ghosty-dev pr <n>`);
  const issue = viewIssue(number);
  if (issue.state !== 'OPEN') throw new UserError(`#${number} está cerrado.`);
  git(['push', '-u', 'origin', 'HEAD']);
  const existing = openPrs().find((p) => p.headRefName === branch);
  let created = false;
  let m = existing?.number;
  if (!m) {
    const body = `Closes #${number}\n\n${MAIN_FLOW_LINE} <qué y cómo>\n`;
    m = api('POST', `${REPO}/pulls`, { title: issue.title, head: branch, base: def, body, draft }).number;
    created = true;
  }
  const r = adopt(number, m);
  return { ...r, created };
}

// `ghosty-dev note <n> "texto"`: avance que no es código (infra, DNS, una decisión) en la bitácora del pendiente.
export function note(n, text) {
  const body = String(text ?? '').trim();
  if (!body) throw new UserError('La nota está vacía: ghosty-dev note <n> "texto" (o --file nota.md, o - para leer de stdin).');
  const issue = viewIssue(n);
  const url = api('POST', `${API_ISSUE(n)}/comments`, { body: `📝 **Nota** (ghosty-dev)\n\n${body}\n` }).html_url;
  return { number: n, title: issue.title, url };
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
  if (blockers.length) throw new UserError(`#${n} está bloqueado por ${blockers.map(blockerText).join(', ')}.`);
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
      const a = { id: c.id ?? null, from, index, by: c.user?.login ?? null, text: askText(c.body || ''), url: c.html_url ?? null };
      if (isBot(c.user) && head === undefined) head = headOf(pr);
      const why = staleReason(c, head);
      (why ? stale : fresh).push(why ? { ...a, stale: why } : a);
    });
  }
  return { fresh, stale, pr: pr?.number ?? null };
}
const unseenAsks = (n) => readAsks(n).fresh;
// `id` = el del comentario de GitHub: con él gs marca el pedido como leído («Lo leyó tu agente», `writer.ack`).
const publicAsk = ({ id, from, by, text, url }) => ({ id, from, by, text, url });

// Los pedidos nuevos de la persona; al leerlos quedan vistos (con peek, no).
export function asks(n, { peek = false } = {}) {
  const { fresh, stale, pr } = readAsks(n);
  if (!peek) markSeen(n, [...fresh, ...stale]);
  return { number: n, pr, asks: fresh.map(publicAsk), stale: stale.map((a) => ({ ...publicAsk(a), reason: a.stale })) };
}

// ---------- wait (Ley 3; Beads gates «so agents never need to poll») ----------

// Ley 3: esperar no es sondear. Con --watch, una sola llamada bloqueante del CLI espera al CI (el CLI mira cada
// 10 s; el agente no gasta tokens); si tarda más que el tope, el pendiente queda en esperando-ci y el agente sigue con otro.
// La vista previa y la revisión del commit actual se reportan cuando terminan (`onService`), pero no detienen la
// espera ni deciden el veredicto: el CI manda. Al volver, `services` trae su estado final.
const DONE = (s) => s !== 'pendiente' && s !== 'sin-check';
export async function wait(n, { watch = false, minutes = 5, onService = () => {} } = {}) {
  const issue = viewIssue(n);
  const state = stateOf(issue);
  if (state !== 'tomado' && state !== 'esperando') throw new UserError(`#${n} no está tomado; primero ghosty-dev claim ${n}.`);
  if (state === 'tomado') setState(issue, 'esperando');
  // Un PR cerrado sin merge es lo primero que se dice (Formmy, fila 42): nadie corre CI ni vista previa sobre él.
  const closedFirst = () => (prOf(n) ? null : closedPrOf({ n }));
  if (!watch) {
    const closed = closedFirst();
    return closed ? { number: n, state: 'esperando', ci: 'sin-pr', closed } : { number: n, state: 'esperando' };
  }
  // Un pedido de la persona también es el evento: despierta antes que el CI.
  const news = () => {
    const fresh = unseenAsks(n);
    markSeen(n, fresh);
    return fresh.map(publicAsk);
  };
  let got = news();
  if (got.length) return { number: n, state: 'esperando', asks: got };
  let before = ciOf(n);
  if (!before.pr) return { number: n, state: 'esperando', ci: 'sin-pr', closed: closedFirst() };
  // Lo que ya terminó al empezar no se vuelve a anunciar; sólo los cambios mientras se espera.
  const reported = {};
  const track = (ci) => {
    if (!ci.pr) return;
    const sv = prServices(ci.pr, { checks: ci.checks });
    for (const key of ['preview', 'review', 'smoke', 'gate']) {
      const sig = `${ci.pr.headRefOid}|${sv[key].status}`;
      if (DONE(sv[key].status) && reported[key] !== sig) onService(key, sv[key]);
      reported[key] = sig;
    }
  };
  const first = prServices(before.pr, { checks: before.checks });
  for (const key of ['preview', 'review', 'smoke', 'gate']) reported[key] = `${before.pr.headRefOid}|${first[key].status}`;
  // En vivo: el aviso de Ghosty Studio (webhook de GitHub) corta la espera en segundos; sin sesión, sondeo normal.
  const { openLive } = await import('./live.mjs');
  const live = await openLive(repoFullName).catch(() => null);
  const nap = (ms) => (live ? live.sleep(ms) : new Promise((r) => setTimeout(r, ms)));
  try {
    // Tras un push, los checks tardan unos segundos en aparecer: se espera a que existan (tope ~90 s).
    const step = Number(process.env.GHOSTY_DEV_REGISTER_WAIT_MS ?? 10_000);
    for (let i = 0; before.status === 'sin-checks' && i < 9; i++) {
      await nap(step);
      before = ciOf(n);
      track(before);
    }
    let ci = before;
    const every = Number(process.env.GHOSTY_DEV_WATCH_MS ?? 10_000);
    for (const until = Date.now() + minutes * 60_000; ci.status === 'pendiente' && Date.now() < until; ) {
      await nap(every);
      // La persona pausó la fábrica mientras esperabas: se corta aquí con su línea (termina lo que traes y detente).
      if (live?.takeFactory?.() === 'pause') {
        const fs = await import('./factory.mjs').then((m) => m.status()).catch(() => null);
        if (fs && fs.active === false) return { number: n, state: 'esperando', ci: ci.status, pr: ci.pr?.url ?? null, factory: fs };
      }
      got = news();
      if (got.length) return { number: n, state: 'esperando', ci: ci.status, pr: ci.pr?.url ?? null, asks: got };
      ci = ciOf(n);
      track(ci);
    }
    const services = ci.pr ? (prServices(ci.pr, { deep: true, checks: ci.checks })) : null;
    return { number: n, state: 'esperando', ci: ci.status, pr: ci.pr?.url ?? null, timedOut: ci.status === 'pendiente', services };
  } finally {
    live?.close();
  }
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
// Tras el merge: GitHub cierra los issues de «Closes #n», pero las etiquetas de la bitácora se quedaban («en curso»
// en un issue cerrado, #78 de Formmy). Se quitan.
export function closingIssueLabels(numbers = []) {
  for (const n of numbers) {
    const issue = api('GET', API_ISSUE(n), undefined, { allowFail: true });
    for (const l of issue?.labels ?? []) {
      const name = typeof l === 'string' ? l : l.name;
      if (name?.startsWith('ghosty-dev:')) api('DELETE', `${API_ISSUE(n)}/labels/${encodeURIComponent(name)}`, undefined, { allowFail: true });
    }
  }
}

// ---------- PR cerrado sin merge (Formmy, fila 42: #73 apareció CLOSED sin decir quién ni por qué) ----------

// Quién lo cerró y cuándo (el evento `closed` del PR) y el motivo: el comentario de una persona más cercano al cierre
// (±15 min). null si el PR está abierto o ya tiene merge.
export function closedInfo(m, p) {
  p ??= api('GET', `${REPO}/pulls/${m}`, undefined, { allowFail: true });
  if (!p?.number || p.state === 'open' || p.merged_at) return null;
  const events = apiAll(`${API_ISSUE(m)}/events`, { allowFail: true }) ?? [];
  const ev = [...events].reverse().find((e) => e.event === 'closed');
  const at = ev?.created_at ?? p.closed_at ?? null;
  const t = Date.parse(at ?? '');
  const comments = Number.isFinite(t) ? apiAll(`${API_ISSUE(m)}/comments`, { allowFail: true }) ?? [] : [];
  const near = comments.filter((c) => !isBot(c.user) && Math.abs(Date.parse(c.created_at ?? '') - t) <= 15 * 60_000).pop();
  const reason = near ? String(near.body ?? '').replace(/<!--[\s\S]*?-->/g, '').split('\n').map((l) => l.replace(/[\u0000-\u001f]/g, '').trim()).find(Boolean)?.slice(0, 160) ?? null : null;
  return { pr: p.number, by: ev?.actor?.login ?? null, at, reason, branch: p.head?.ref ?? null, url: p.html_url ?? null };
}

const whenText = (at) => (Number.isFinite(Date.parse(at ?? '')) ? ` el ${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '');
export const closedLine = (c) =>
  `PR #${c.pr} cerrado sin merge${c.by ? ` por @${c.by}` : ''}${whenText(c.at)} (${c.reason ? `motivo: «${c.reason}»` : 'sin comentario de motivo'}): ¿reabrir? gh pr reopen ${c.pr}`;

// El PR cerrado sin merge más reciente de un pendiente (`n`: rama ghosty-dev/<n>-… o «Closes #n») o de una rama.
export function closedPrOf({ n, branch }) {
  const list = api('GET', `${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=50`, undefined, { allowFail: true }) ?? [];
  const p = list.find((x) => !x.merged_at && (branch ? x.head?.ref === branch : (x.head?.ref ?? '').startsWith(`ghosty-dev/${n}-`) || closingRefs(x.body ?? '').includes(n)));
  return p ? closedInfo(p.number, p) : null;
}

// Para el pre-push y `preview`: la rama actual no tiene PR abierto pero sí uno cerrado sin merge (un push ahí no corre
// CI, vista previa ni revisión). null si no aplica o no hay red.
export function closedPrOfBranch() {
  try {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })?.trim();
    if (!branch || branch === 'HEAD') return null;
    const open = api('GET', `${REPO}/pulls?state=open&per_page=100`, undefined, { allowFail: true });
    if (!open || open.some((p) => p.head?.ref === branch)) return null;
    return closedPrOf({ branch });
  } catch {
    return null;
  }
}

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
// Repo privado: no hay Actions; devuelve { gsGate: <pr> } y quien llama (bin, async) le pide a Ghosty Studio que la
// evalúe (gateViaGs). gs también la evalúa sola con el webhook del comentario: esto sólo la adelanta.
export function rerunGate(n, pr = prOf(n)) {
  if (!pr?.headRefOid) return { rerun: null };
  if (isPrivateRepo()) return { rerun: null, gsGate: pr.number };
  return { rerun: rerunGateRun(pr.headRefOid) };
}
export function rerunGateRun(sha) {
  const runs = api('GET', `${REPO}/actions/workflows/evidence-gate.yml/runs?head_sha=${sha}&per_page=1`, undefined, { allowFail: true })?.workflow_runs;
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
  return { ok: true, criteriaChecked: Boolean(issueFile), manual: manualCriteria(readFileSync(file, 'utf8')) };
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
  if (!ok) throw new UserError(`Evidencia inválida para #${n}:\n- ${errors.join('\n- ')}\n${blockHint(n)}`);
  const pr = prOf(n, m);
  // «Probado en la preview del PR #N» sólo vale si #N trae este mismo commit (Formmy, fila 40).
  const sha = pr?.headRefOid || git(['rev-parse', 'HEAD'], { allowFail: true })?.trim() || '';
  const cross = crossPreviewProblems(md, { pr: pr?.number, sha }, (k) => prCommits(k));
  if (cross.length) throw new UserError(`Evidencia inválida para #${n}:\n- ${cross.join('\n- ')}`);
  const url = api('POST', `${API_ISSUE(n)}/comments`, { body: formatEvidence(n, md, pr) }).html_url;
  // Ley 3: publicar la evidencia es el evento que vuelve a correr la puerta del PR (y el workflow también lo hace
  // solo con issue_comment, para la evidencia que se publique por otro lado).
  const gate = rerunGate(n, pr);
  const manual = manualCriteria(md);
  return { number: n, posted: true, url: url || null, ...gate, ...(manual.length ? { awaitingPerson: manual.map((m) => m.criterion) } : {}) };
}

// ---------- confirm (verificación de la persona: el sign-off de QA de los criterios `- [~]`) ----------

/** Confirma el criterio `i` (1 = el primero del pendiente) que la evidencia declaró `[~]`. Sólo con permiso de escritura. Deja comentario de rastro y vuelve a correr la puerta. */
export function confirm(n, { criterion, note, pr: m } = {}) {
  const i = Number(criterion);
  const issue = api('GET', `${REPO}/issues/${n}`);
  const list = parseCriteria(issue.body);
  if (!Number.isInteger(i) || i < 1 || i > list.length) throw new UserError(`Uso: ghosty-dev confirm ${n} --criterion <i> [--note "…"] (el pendiente tiene ${list.length} criterios: ghosty-dev criteria ${n}).`);
  const who = me();
  // Sólo quien puede escribir en el repo: si GitHub no contesta el permiso se deja pasar (el servidor ya exigió sesión).
  const perm = api('GET', `${REPO}/collaborators/${who}/permission`, undefined, { allowFail: true })?.permission;
  if (perm && !['admin', 'maintain', 'write'].includes(perm)) throw new UserError(`@${who} no tiene permiso de escritura en el repo (${perm}): sólo quien lo tiene confirma una verificación.`);
  const comments = apiAll(`${API_ISSUE(n)}/comments`);
  const pv = pendingVerification(comments, issue.body);
  if (!pv.evidence) throw new UserError(`#${n} no tiene evidencia válida: no hay nada que confirmar todavía.`);
  const c = list[i - 1];
  const hit = pv.manual.find((x) => criterionKey(x.criterion) === criterionKey(c.text));
  if (!hit) throw new UserError(`El criterio ${i} («${c.text}») no está declarado como «- [~]» en la evidencia vigente: ${pv.manual.length ? `los pendientes de tu verificación son ${pv.manual.map((x) => `«${x.criterion}»`).join(', ')}` : 'no hay ninguno pendiente de tu verificación'}.`);
  const pr = prOf(n, m);
  const sha = pr?.headRefOid || git(['rev-parse', 'HEAD'], { allowFail: true })?.trim() || '';
  if (!sha) throw new UserError('No pude saber el commit que se confirma (¿hay PR o un repo git aquí?).');
  const at = new Date().toISOString();
  const url = api('POST', `${API_ISSUE(n)}/comments`, { body: formatConfirmation(n, { sha, criterion: hit.criterion, index: i, by: who, at, note, check: hit.check }) }).html_url;
  return { number: n, index: i, criterion: hit.criterion, by: who, at, sha, url: url || null, ...rerunGate(n, pr) };
}

// ---------- add (Beads: bd create): el agente abre el pendiente desde la plática ----------

export function pendienteBody({ goal, criteria = [], context, discoveredIn, flow }) {
  if (!goal?.trim()) throw new UserError('Falta el objetivo: --goal "qué debe quedar cierto".');
  if (!criteria.length) throw new UserError('Falta al menos un criterio: --criteria "…" (se puede repetir).');
  const parts = ['## Objetivo', goal.trim(), '', '## Criterios de aceptación', ...criteria.map((x) => `- [ ] ${x.trim()}`)];
  // Obligatorio en la evidencia (Formmy, filas 44 y 46): el pendiente dice desde el inicio qué se va a ejercer.
  parts.push('', '## Flujo principal probado con sesión', flow?.trim() || '<!-- Qué función principal se usa con sesión en la vista previa y cómo (abrir la página no cuenta); la evidencia lo trae con captura o salida. Sin interfaz ni login: «no aplica: <motivo>». -->');
  const ctx = [discoveredIn ? `Descubierto en ${typeof discoveredIn === 'number' ? '#' + discoveredIn : discoveredIn}.` : '', context?.trim() ?? ''].filter(Boolean).join(' ');
  if (ctx) parts.push('', '## Contexto', ctx);
  return parts.join('\n') + '\n';
}

// `repo` abre el pendiente en OTRO repo («owner/repo»): las etiquetas del tablero se aseguran allí y queda el enlace cruzado
// (en el cuerpo «Descubierto en origen#n» y un comentario en el pendiente de origen). `discoveredIn` y `blockedBy` son
// referencias {repo, n}: sin repo, `--from` es del repo de origen (donde corres el comando) y `--by` del repo donde se abre.
export function add(title, { goal, criteria, context, blockedBy, discoveredIn, flow, repo } = {}) {
  if (!title?.trim()) throw new UserError('Uso: ghosty-dev add "título" --goal "…" --criteria "…" [--criteria "…"] [--flow "…"] [--by <m>] [--repo owner/repo].');
  const asRef = (x) => (x == null ? null : typeof x === 'object' ? x : { repo: null, n: x });
  const from = asRef(discoveredIn);
  const by = asRef(blockedBy);
  const origin = repo ? effectiveRepo() ?? repoFullName() : null;
  if (repo && !/^[A-Za-z0-9][\w-]*\/[\w.-]+$/.test(repo)) throw new UserError('--repo va como owner/repo.');
  const away = repo && !sameRepo(repo, origin);
  const prev = process.env.GH_REPO;
  if (away) process.env.GH_REPO = repo;
  try {
    // «Preparar el repo para ghosty-dev» no se duplica: si ya hay uno vivo, se reutiliza.
    if (title.trim() === PREPARE_TITLE) {
      const live = findPreparationIssue(openIssues());
      if (live) return { number: live.number, title: live.title, url: live.url, blockedBy: null, board: null, reused: true, repo: repo ?? null };
    }
    if (away) ensureBoardLabels();
    const fromText = from ? (from.repo ? refText(from) : away ? fmtRef(origin, from.n) : `#${from.n}`) : away ? `${origin}` : null;
    const body = pendienteBody({ goal, criteria, context, discoveredIn: fromText, flow });
    const created = api('POST', `${REPO}/issues`, { title: title.trim(), body, labels: [label('listo')] });
    const { number, html_url: url } = created;
    if (!number) throw new Error('GitHub no devolvió el número del pendiente.');
    const blocked = by ? block(number, by.repo && !sameRepo(by.repo, repo ?? origin) ? by : by.n) : null;
    // Enlace cruzado: el pendiente de origen se entera de dónde quedó el trabajo.
    if (away && from && !from.repo) {
      process.env.GH_REPO = origin;
      api('POST', `${API_ISSUE(from.n)}/comments`, { body: `Se abrió ${fmtRef(repo, number)} (${title.trim()}) para el trabajo que vive en ese repo.\n${url}` }, { allowFail: true });
      process.env.GH_REPO = repo;
    }
    // La persona ve sus pendientes en GitHub: se abre el tablero una vez por tanda (no en cada add).
    const board = openBoardOncePerBatch(url);
    return { number, repo: repo ?? null, ref: repo ? fmtRef(repo, number) : null, title: title.trim(), url, blockedBy: blocked?.blockedBy ?? null, board };
  } finally {
    if (away) {
      if (prev === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = prev;
    }
  }
}

// Las cuatro etiquetas del tablero en el repo actual (o GH_REPO): las crea si faltan, sin pisar las que ya hay.
function ensureBoardLabels() {
  const have = new Set((apiAll(`${REPO}/labels`, { allowFail: true }) ?? []).map((l) => l.name));
  for (const state of STATES) {
    if (have.has(label(state))) continue;
    const [color, description] = LABEL_STYLE[state];
    api('POST', `${REPO}/labels`, { name: label(state), color, description }, { allowFail: true });
  }
}

// ---------- criteria (enmendar un criterio incumplible, con rastro) ----------

// Los renglones «- [ ] …» de «## Criterios de aceptación»: línea del cuerpo, prefijo (con su casilla) y texto.
export function parseCriteria(body) {
  const out = [];
  let inside = false;
  String(body ?? '').split('\n').forEach((l, i) => {
    if (/^##\s+/.test(l)) inside = /^##\s+Criterios de aceptaci[oó]n/i.test(l);
    else if (inside) {
      const m = l.match(/^(\s*[-*]\s+\[[ xX]\]\s+)(.*\S)\s*$/);
      if (m) out.push({ line: i, prefix: m[1], text: m[2] });
    }
  });
  return out;
}

/** Sin `set`, lista los criterios. Con `set` (1 = el primero) cambia SÓLO ese renglón (conserva su casilla) y deja un comentario con quién, cuándo, el texto anterior, el nuevo y el motivo. */
export function criteria(n, { set, text, reason } = {}) {
  const issue = api('GET', `${REPO}/issues/${n}`);
  const list = parseCriteria(issue.body);
  if (set === undefined) return { number: n, criteria: list.map((c, i) => ({ index: i + 1, text: c.text })) };
  const i = Number(set);
  if (!Number.isInteger(i) || i < 1 || i > list.length) throw new UserError(`#${n} no tiene el criterio ${set} (tiene ${list.length}).`);
  const next = String(text ?? '').trim().replace(/\s*\n\s*/g, ' ');
  if (!next) throw new UserError('Uso: ghosty-dev criteria <n> --set <i> "texto nuevo" --reason "por qué".');
  if (!reason?.trim()) throw new UserError('Falta --reason "…": una enmienda sin motivo no deja rastro útil.');
  const c = list[i - 1];
  if (c.text === next) throw new UserError('El texto nuevo es igual al actual.');
  const lines = String(issue.body).split('\n');
  lines[c.line] = `${c.prefix}${next}`;
  api('PATCH', `${REPO}/issues/${n}`, { body: lines.join('\n') });
  const who = me();
  const when = new Date().toISOString();
  api('POST', `${REPO}/issues/${n}/comments`, {
    body: `✏️ Criterio ${i} enmendado.\n\n- Quién: ${who}\n- Cuándo: ${when}\n- Texto anterior: ${c.text}\n- Texto nuevo: ${next}\n- Motivo: ${reason.trim()}\n\n<sub>Enmendado con ghosty-dev criteria</sub>`,
  });
  return { number: n, index: i, before: c.text, after: next, reason: reason.trim(), by: who, at: when };
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
  return { number: n, sha: pr.headRefOid, pr: pr.number, open, url: url || null, ...rerunGate(n, pr) };
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

// Bloqueo con motivo (Formmy, fila 45): el PR pasó a borrador porque el chat no funcionaba y el tablero no decía nada.
// Etiqueta «bloqueado» + comentario con la marca en el issue y en su PR abierto (el tablero de Ghosty lo enseña).
export const BLOCK_MARK = '<!-- ghosty-dev:bloqueo -->';
export const blockHint = (n) => `Si la función principal no funciona y no lo puedes arreglar ahora, no lo marques listo: ghosty-dev block ${n} --reason "qué falla y qué falta" (queda «Bloqueado» con su motivo en el tablero) y avísale a la persona.`;

export const UNBLOCK_MARK = '<!-- ghosty-dev:desbloqueo -->';

export function block(n, byIn, { reason, person = false } = {}) {
  // `by` puede ser un número (mismo repo) o {repo, n} de otro repo.
  const byRef = byIn && typeof byIn === 'object' ? byIn : byIn ? { repo: null, n: byIn } : null;
  const by = byRef?.n;
  const foreignBy = byRef?.repo && !sameRepo(byRef.repo, effectiveRepo()) ? byRef.repo : null;
  const why = typeof reason === 'string' ? reason.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim() : '';
  if (reason !== undefined && !why) throw new UserError('--reason va con el motivo: qué falla y qué falta.');
  if (why.length > 1000) throw new UserError('--reason: máximo 1000 caracteres.');
  if (!by && why) {
    const issue = viewIssue(n);
    if (issue.state !== 'OPEN') throw new UserError(`#${n} está cerrado.`);
    setState(issue, 'bloqueado');
    // `--person`: le toca a la persona (credencial, acceso, decisión): el tablero dice «Te necesita» y manda push.
    const body = `${BLOCK_MARK}\n**Bloqueado${person ? ' (te necesita)' : ''}:** ${why}`;
    api('POST', `${API_ISSUE(n)}/comments`, { body });
    const pr = prOf(n);
    if (pr) api('POST', `${API_ISSUE(pr.number)}/comments`, { body: `${body}\n\n(#${n})` }, { allowFail: true });
    return { number: n, blockedBy: null, reason: why, pr: pr?.number ?? null, via: 'motivo', person: !!person };
  }
  if (person) throw new UserError('--person va con --reason "…" (qué necesitas de la persona).');
  if (!by || (by === n && !foreignBy)) throw new UserError('Uso: ghosty-dev block <n> --by <m> (m distinto de n) o ghosty-dev block <n> --reason "…".');
  if (why) api('POST', `${API_ISSUE(n)}/comments`, { body: `${BLOCK_MARK}\n**Bloqueado por ${foreignBy ? fmtRef(foreignBy, by) : '#' + by}:** ${why}` });
  const issue = viewIssue(n);
  const blocker = api('GET', foreignBy ? `repos/${foreignBy}/issues/${by}` : API_ISSUE(by));
  const native = api('POST', `${API_ISSUE(n)}/dependencies/blocked_by`, { issue_id: blocker.id }, { allowFail: true });
  if (native === null) {
    api('PATCH', API_ISSUE(n), { body: addBlockedBy(issue.body, foreignBy ? fmtRef(foreignBy, by) : by) });
    setState(issue, 'bloqueado');
  } else if (stateOf(issue) !== 'bloqueado') {
    // GitHub ya lo marca «Blocked»; la etiqueta también dice bloqueado para que GitHub y el tablero digan lo mismo
    // (bliss, 22-nov: #77 salía «Escribiendo» con «Blocked by #90»). Al cerrarse el que bloquea, `ready` lo ofrece
    // otra vez y el tablero lo suelta (la dependencia nativa manda).
    setState(issue, 'bloqueado');
  }
  return { number: n, blockedBy: foreignBy ? fmtRef(foreignBy, by) : by, reason: why || null, via: native === null ? 'cuerpo' : 'github' };
}

// Quita el bloqueo: las dependencias nativas «blocked_by» de GitHub (el tablero de Ghosty las lee, así que si se
// quedan, sigue diciendo «Bloqueado»), la lista «Bloqueado por» del cuerpo, la etiqueta (vuelve a «tomado» si tiene PR
// o asignado; si no, a «listo») y una marca de desbloqueo en el issue y su PR. Con `by` sólo quita ese bloqueador.
// Si GitHub rechaza quitar una dependencia, lo dice (nunca en silencio) y no toca etiqueta ni marca.
export function unblock(n, { by } = {}) {
  const issue = viewIssue(n);
  if (issue.state !== 'OPEN') throw new UserError(`#${n} está cerrado.`);
  if (by !== undefined && (!Number.isInteger(by) || by <= 0)) throw new UserError('--by va con el número del pendiente que bloquea.');
  const listed = api('GET', `${API_ISSUE(n)}/dependencies/blocked_by`, undefined, { allowFail: true });
  const native = (listed ?? []).filter((i) => by === undefined || i.number === by);
  const removed = [];
  const failed = [];
  for (const dep of native) {
    const ok = api('DELETE', `${API_ISSUE(n)}/dependencies/blocked_by/${dep.id}`, undefined, { allowFail: true });
    (ok === null ? failed : removed).push(dep.number);
  }
  if (failed.length) {
    throw new UserError(`GitHub no dejó quitar la dependencia de #${n} con ${failed.map((x) => '#' + x).join(', ')}${removed.length ? ` (sí se quitó la de ${removed.map((x) => '#' + x).join(', ')})` : ''}: revisa tus permisos (gh auth status) o quítala en GitHub, sección «Relationships» del issue.`);
  }
  const inBody = parseBlockedBy(issue.body).filter((x) => by === undefined || x === by);
  if (inBody.length) api('PATCH', API_ISSUE(n), { body: removeBlockedBy(issue.body, by) });
  if (by !== undefined && !removed.length && !inBody.length) throw new UserError(`#${n} no está bloqueado por #${by}.`);
  // Con --by y otros bloqueos vivos, la etiqueta se queda: sigue bloqueado.
  const rest = by === undefined ? [] : [...(listed ?? []).filter((i) => i.number !== by && String(i.state).toLowerCase() === 'open').map((i) => i.number), ...parseBlockedBy(issue.body).filter((x) => x !== by)];
  const labeled = (issue.labels || []).some((l) => l.name === label('bloqueado'));
  const pr = prOf(n);
  if (labeled && !rest.length) setState(issue, pr || (issue.assignees || []).length ? 'tomado' : 'listo');
  if (!rest.length) {
    const body = `${UNBLOCK_MARK}\n**Desbloqueado.**`;
    api('POST', `${API_ISSUE(n)}/comments`, { body });
    if (pr) api('POST', `${API_ISSUE(pr.number)}/comments`, { body: `${body} (#${n})` }, { allowFail: true });
  }
  return { number: n, wasLabeled: labeled, removed: [...new Set([...removed, ...inBody])], stillBlockedBy: rest, depsApi: listed !== null, pr: pr?.number ?? null };
}

// Quita de la lista «Bloqueado por» del cuerpo el #by (o todos los del repo si no hay `by`); el encabezado vacío se va. Puro.
export function removeBlockedBy(body = '', by) {
  const m = body.match(/^##\s+Bloqueado por\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  if (!m) return body;
  const hits = (line) => [...line.matchAll(/(?<![\w./-])#(\d+)/g)].some((x) => by === undefined || Number(x[1]) === by);
  const kept = m[1].split('\n').filter((line) => !hits(line));
  const left = kept.join('\n').trim();
  return body.replace(m[0], left ? `${m[0].split('\n')[0]}\n${left}\n${m[0].endsWith('\n\n') ? '\n' : ''}` : '').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// La etiqueta que pone Ghosty Studio cuando #n va en la nube. Si el run ya no vive (se detuvo o se perdió) y la
// etiqueta se quedó, `stop` la quita para que GitHub no siga diciendo «en la nube».
export const CLOUD_LABEL = 'ghosty-dev:en-nube';
// Issues abiertos con la etiqueta «en la nube» (la bitácora); quien llama decide cuáles ya no tienen run vivo.
export const cloudLabeled = () => openIssues().filter((i) => (i.labels || []).some((l) => l.name === CLOUD_LABEL)).map((i) => ({ number: i.number, title: i.title }));

export function clearCloudLabel(n) {
  const issue = viewIssue(n);
  if (!(issue.labels || []).some((l) => l.name === CLOUD_LABEL)) return { number: n, cleared: false, state: stateOf(issue) };
  const next = stateOf(issue) === 'bloqueado' ? 'bloqueado' : prOf(n) || (issue.assignees || []).length ? 'tomado' : 'listo';
  setState(issue, next);
  return { number: n, cleared: true, state: next };
}

// ---------- show (Beads: bd show) ----------

// La ficha del pendiente que publica la plataforma (comentario fijo, editado en su lugar). SPEC §5b.
export const FICHA_MARK = '<!-- ghosty-dev:ficha -->';
export function fichaOf(comments) {
  const c = [...(comments || [])].reverse().find((x) => (x.body || '').startsWith(FICHA_MARK));
  return c ? c.body.slice(FICHA_MARK.length).replace(/<sub>[\s\S]*?<\/sub>/g, '').trim() : null;
}

// ---------- traspaso local → nube ----------

/**
 * Lo que llevas en tu compu de #n viaja a la nube por git (patrón de Copilot `/delegate` y Devin Handoff): si el worktree
 * tiene cambios sin commitear o commits sin subir, se commitea un «WIP: traspaso a la nube» y todo se sube a la rama de
 * traspaso `ghosty-dev/<n>-traspaso` (nunca a la del PR). Devuelve { branch, wip } o null si no hay nada local que heredar.
 */
export function handoffToCloud(n, { onProgress = () => {} } = {}) {
  const top = git(['rev-parse', '--show-toplevel']).trim();
  const wt = join(dirname(top), `${basename(top)}-${n}`);
  const dir = existsSync(wt) ? wt : top;
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, allowFail: true })?.trim() ?? '';
  if (!current.startsWith(`ghosty-dev/${n}-`) || current.endsWith('-traspaso')) return null;
  const dirty = (git(['status', '--porcelain'], { cwd: dir, allowFail: true }) ?? '').trim() !== '';
  const unpushed = Number((git(['rev-list', '--count', 'HEAD', '--not', '--remotes'], { cwd: dir, allowFail: true }) ?? '0').trim()) > 0;
  if (!dirty && !unpushed) return null;
  if (dirty) {
    git(['add', '-A'], { cwd: dir });
    git(['commit', '-q', '--no-verify', '-m', 'WIP: traspaso a la nube'], { cwd: dir });
  }
  const branch = `ghosty-dev/${n}-traspaso`;
  onProgress(`subiendo lo tuyo a ${branch}…`);
  if (git(['push', '-q', '--no-verify', '--force', 'origin', `HEAD:refs/heads/${branch}`], { cwd: dir, allowFail: true }) === null) {
    throw new UserError(`No pude subir tu trabajo a ${branch}. Sube tu rama a mano y reintenta, o manda sin traspaso con --no-handoff.`);
  }
  return { branch, wip: dirty };
}

// ---------- preparación del repo ----------

/** Lee de la RAMA BASE lo que `readinessOf` necesita (archivos de la puerta y la protección) y lo evalúa. */
export function repoReadiness({ dir } = {}) {
  const opts = { cwd: dir, allowFail: true };
  const info = api('GET', REPO, undefined, opts);
  if (!info) throw new UserError('No se pudo leer el repo con gh.');
  const repo = info.full_name;
  const branch = info.default_branch || 'main';
  const files = {};
  for (const path of READINESS_READS) {
    const f = api('GET', `repos/${repo}/contents/${path}?ref=${branch}`, undefined, opts);
    files[path] = f?.content ? Buffer.from(f.content, 'base64').toString('utf8') : null;
  }
  // Protección clásica y rulesets: la misma lectura que hace `gateRequired` de Ghosty Studio.
  const classic = api('GET', `repos/${repo}/branches/${branch}/protection`, undefined, opts);
  const rules = api('GET', `repos/${repo}/rules/branches/${branch}`, undefined, opts);
  const rsc = classic?.required_status_checks;
  const requiredChecks = classic === null && rules === null ? null : [
    ...(rsc?.contexts ?? []),
    ...(rsc?.checks ?? []).map((c) => c.context ?? ''),
    ...(Array.isArray(rules) ? rules : []).filter((r) => r.type === 'required_status_checks').flatMap((r) => (r.parameters?.required_status_checks ?? []).map((c) => c.context ?? '')),
  ];
  const expected = { gate: readFileSync(join(ROOT, 'src/gate.mjs'), 'utf8'), evidence: readFileSync(join(ROOT, 'src/evidence.mjs'), 'utf8') };
  const isPrivate = info.private === true || info.visibility === 'private' || info.visibility === 'internal';
  return { repo, branch, ...readinessOf({ files, requiredChecks, branch, expected, isPrivate }) };
}

/** El pendiente de preparación vivo: primero por título exacto, luego por contenido. Puro. */
export function findPreparationIssue(open = []) {
  const issues = open.filter((i) => !i.pull_request);
  return issues.find((i) => String(i.title).trim() === PREPARE_TITLE) ?? issues.find((i) => isPreparationIssue(i)) ?? null;
}

/**
 * Antes de tomar #n: si el repo no está preparado, PREPARAR es el primer pendiente y #n queda bloqueado por él.
 * Devuelve null si todo está en orden (o #n es el propio pendiente de preparación); si no, { prep, created, blocking, blocked }.
 * El pendiente de preparación se reutiliza por título (nunca se abre uno por cada intento).
 */
export function ensurePreparation(n, { dir } = {}) {
  const r = repoReadiness({ dir });
  if (r.ready) return null;
  // Si #n YA es el trabajo de preparar (por título o porque sus criterios son los chequeos), se toma tal cual.
  if (n) {
    const own = api('GET', API_ISSUE(n), undefined, { allowFail: true });
    if (own && isPreparationIssue(own)) return null;
  }
  const open = apiAll(`${REPO}/issues?state=open&per_page=100`, { allowFail: true }) ?? [];
  const existing = findPreparationIssue(open);
  if (existing && existing.number === n) return null;
  const brief = prepareBrief(r.blocking);
  const prep = existing ? { number: existing.number, url: existing.html_url } : add(PREPARE_TITLE, { goal: brief.goal, criteria: brief.criteria });
  const blocked = n && n !== prep.number ? block(n, prep.number, { reason: 'El repo no está preparado para ghosty-dev: primero se prepara.' }) : null;
  return { prep: prep.number, url: prep.url, created: !existing, blocking: r.blocking, blocked: blocked ? n : null };
}

/** La preparación como filas de `doctor` ({name, ok, detail, fix}); lo que sólo avisa sale con ok: null. */
export function readinessChecks(r) {
  return r.checks.map((c) => ({ name: `puerta-${c.id}`, ok: c.ok ? true : c.severity === 'block' ? false : null, detail: c.why, ...(c.ok ? {} : { fix: c.fix }) }));
}

/** Commit (sha completo o corto) que declara un comentario de evidencia: su línea «Commit: <sha>». */
export function evidenceCommitOf(comment) {
  return (comment?.body ?? '').match(/^Commit:\s*`?([0-9a-f]{7,40})`?/im)?.[1] ?? null;
}

/**
 * Quién escribe #n AHORA y qué sigue para cambiar de lugar. Un solo escritor: la nube (un run vivo) o tu terminal
 * (rama/worktree local), nunca los dos. Puro: recibe lo ya leído.
 */
export function writerOf({ number, cloudRun = null, localBranch = null, blocked = false }) {
  const live = cloudRun && ['queued', 'working', 'waiting_ci', 'reviewing', 'needs_person', 'blocked', 'merging'].includes(cloudRun.phase);
  if (live) return { where: 'nube', detail: cloudRun.state, move: `ghosty-dev teleport ${number}   (la trae a tu compu y detiene la nube)` };
  // Bloqueado: ni nube ni claim hasta quitar el bloqueo.
  if (blocked) return { where: localBranch ? 'tu compu' : 'nadie', detail: localBranch ?? null, move: `ghosty-dev unblock ${number}   (está bloqueado: primero se desbloquea; --by <m> quita sólo ése)` };
  if (localBranch) return { where: 'tu compu', detail: localBranch, move: `ghosty-dev claim ${number} --cloud   (la manda a la nube; un solo escritor)` };
  return { where: 'nadie', detail: cloudRun ? `último intento en la nube: ${cloudRun.state}` : null, move: `ghosty-dev claim ${number}  (local) · ghosty-dev claim ${number} --cloud  (nube)` };
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
    // El commit que nombra la evidencia válida (la puerta la ata al commit): si no es la punta del PR, está vieja.
    evidenceCommit: evidenceCommitOf(findValidEvidence(issue.comments, issue.body)),
    asks: unseenAsks(n).map(publicAsk),
    ficha: fichaOf(prComments) ?? fichaOf(issue.comments),
    pr: pr?.url ?? null,
    closed: !pr && issue.state === 'OPEN' ? closedPrOf({ n }) : null,
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
  const conflict = p.state === 'open' && !p.merged_at ? conflictOf(m) : null;
  return {
    pr: p.number,
    title: p.title ?? '',
    state: p.merged_at ? 'mezclado' : p.state === 'open' ? (p.draft ? 'borrador' : 'abierto') : 'cerrado',
    branch: pr.headRefName ?? null,
    closes: [...String(p.body ?? '').matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)].map((x) => Number(x[1])),
    ficha: fichaOf(comments),
    url: pr.url,
    services: pr.headRefOid ? prServices(pr, { deep: true }) : null,
    conflict,
    closed: closedInfo(m, p),
    // «Siguiente: <qué> · le toca a <quién>» (el mismo dato que el tablero de Ghosty).
    next: boardNextOf(p, conflict),
    // Tras el merge: ¿llegó a producción? El mismo veredicto que el tablero de Ghosty (deployVerdict).
    // Repo privado: no hay runs de Actions; manda el marcador que deja `ghosty-dev deploy` en la bitácora.
    deploy: p.merged_at ? (isPrivateRepo() ? privateDeployOf(p) : p.merge_commit_sha ? deployOf(p) : null) : null,
  };
}

// ---------- «Siguiente: <qué> · le toca a <quién>», igual que el tablero de Ghosty (gs `nextStepOf`, fila 64) ----------
// Orden real: vista previa → CI → prueba en vivo/Lighthouse → revisión → flujo principal y evidencia (el agente) → merge
// (la persona). Un paso que aún no puede hacerse nunca es rojo: `failed` sólo con fallas reales.
const NEXT_NOT_CI = new Set(['Ghosty Review', 'Ghosty · Preview', 'Ghosty · Revisiones del push', ...GATE_CHECKS]);
const NEXT_BAD = /^(failure|error|cancelled|timed_out|action_required|startup_failure)$/i;
export function boardNext(checks, { conflict = false, draft = false, reviewExpected = false } = {}) {
  const latest = new Map();
  for (const c of checks) if (c.name && !latest.has(c.name)) latest.set(c.name, c);
  const at = (step, owner, failed = false, waitingOn = null) => ({ step, owner, waitingOn, failed });
  const done = (c) => !c || c.status === 'completed';
  if (conflict) return at('conflict', 'agent', true);
  if (draft) return at('draft', 'you');
  const preview = latest.get('Ghosty · Preview');
  if (preview && !done(preview)) return at('preview', 'ghosty');
  if (preview?.conclusion === 'failure') return at('preview', 'agent', true);
  const ci = [...latest.values()].filter((c) => !NEXT_NOT_CI.has(c.name) && !c.name.startsWith('ghosty-dev') && c.name !== 'Ghosty · Smoke');
  if (ci.some((c) => c.status === 'completed' && NEXT_BAD.test(c.conclusion ?? ''))) return at('ci', 'agent', true);
  if (ci.some((c) => !done(c))) return at('ci', 'ghosty');
  const smoke = latest.get('Ghosty · Smoke');
  if (smoke && !done(smoke)) return at('smoke', 'ghosty');
  if (smoke && NEXT_BAD.test(smoke.conclusion ?? '')) return at('smoke', 'agent', true);
  const review = latest.get('Ghosty Review');
  if ((!review && reviewExpected) || (review && !done(review))) return at('review', 'ghosty');
  if (review && !['success', 'skipped', 'neutral'].includes(review.conclusion)) return at('review', 'agent');
  const gate = latest.get('ghosty-dev/evidencia');
  if (gate && !done(gate)) return at('evidence', 'ghosty');
  if (gate && NEXT_BAD.test(gate.conclusion ?? '')) return at('evidence', 'agent');
  return at('merge', 'you');
}
const NEXT_STEP = { conflict: 'Resolver el conflicto con la base', draft: 'Marcar listo para revisión', preview: 'Vista previa', ci: 'CI del repo', smoke: 'Prueba en vivo · Lighthouse', review: 'Ghosty Review', evidence: 'Probar el flujo principal y publicar la evidencia', merge: 'Merge' };
const NEXT_FIX = { conflict: 'Resolver el conflicto con la base', preview: 'Arreglar la vista previa', ci: 'Arreglar el CI', smoke: 'Arreglar la prueba en vivo', review: 'Atender los hallazgos' };
const NEXT_OWNER = { ghosty: 'le toca a Ghosty', agent: 'le toca al agente', you: 'te toca a ti' };
export const nextLine = (n) => `Siguiente: ${(n.owner === 'agent' ? NEXT_FIX[n.step] : null) ?? NEXT_STEP[n.step]} · ${NEXT_OWNER[n.owner]}${n.waitingOn ? ` · espera a ${n.waitingOn}` : ''}`;
// Los checks del commit en la forma de boardNext (check runs + statuses).
function checksLite(sha) {
  const { runs, statuses } = commitChecks(sha);
  // El más nuevo primero (id mayor): boardNext se queda con el primero por nombre. Un sha puede traer el job viejo de
  // Actions «ghosty-dev/evidencia» en rojo y el check nuevo de gs en verde (Formmy #156, repo privado sin Actions).
  return [...[...runs].sort((a, b) => (b.id ?? 0) - (a.id ?? 0)).map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion })), ...statuses.map((s) => ({ name: s.context, status: s.state === 'pending' ? 'in_progress' : 'completed', conclusion: s.state === 'pending' ? null : s.state === 'success' ? 'success' : 'failure' }))];
}
function boardNextOf(p, conflict) {
  if (p.state !== 'open' || p.merged_at || !p.head?.sha) return null;
  const n = boardNext(checksLite(p.head.sha), { conflict: !!conflict, draft: !!p.draft });
  return { ...n, line: nextLine(n) };
}

// Puro: el veredicto del deploy de un merge, igual que gs (`app/lib/dev-runs/deploy.ts`). Un run caído gana; cancelado
// no es caído; sin runs, 3 min de gracia y luego «sin deploy automático»; más de 30 min corriendo = no termina.
const DEPLOY_FAILED = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);
export function deployVerdict(runs, elapsedS) {
  const failed = runs.find((r) => r.status === 'completed' && DEPLOY_FAILED.has(String(r.conclusion)));
  if (failed) return { state: 'failure', name: failed.name, url: failed.html_url };
  const live = runs.find((r) => r.status !== 'completed');
  if (live) return { state: elapsedS >= 30 * 60 ? 'timeout' : 'pending', name: live.name, url: live.html_url };
  const cancelled = runs.find((r) => r.conclusion === 'cancelled');
  if (cancelled) return { state: 'cancelled', name: cancelled.name, url: cancelled.html_url };
  if (!runs.length) return { state: elapsedS >= 180 ? 'none' : 'pending', name: null, url: null };
  const main = runs.find((r) => /deploy|release|prod/i.test(r.name)) ?? runs[0];
  return { state: 'success', name: main.name, url: main.html_url };
}
export const DEPLOY_LABEL = { pending: 'Desplegando…', success: 'En producción', failure: 'Deploy falló', cancelled: 'Deploy cancelado', timeout: 'El deploy no termina', none: 'Sin deploy automático' };

function deployOf(p) {
  const info = api('GET', REPO, undefined, { allowFail: true });
  const branch = encodeURIComponent(p.base?.ref ?? info?.default_branch ?? 'main');
  const runs = api('GET', `${REPO}/actions/runs?head_sha=${p.merge_commit_sha}&event=push&branch=${branch}&per_page=50`, undefined, { allowFail: true });
  const v = deployVerdict(Array.isArray(runs?.workflow_runs) ? runs.workflow_runs : [], Math.max(0, (Date.now() - Date.parse(p.merged_at)) / 1000));
  const site = typeof info?.homepage === 'string' && /^https?:\/\//.test(info.homepage) ? info.homepage : null;
  return { ...v, label: DEPLOY_LABEL[v.state], site };
}

// Repo privado: ¿se desplegó el merge? Lo dice el último marcador de `ghosty-dev deploy` en el PR o en sus pendientes.
export function privateDeployOf(p) {
  const refs = closingRefs(p.body ?? '').filter((n) => n !== p.number);
  const comments = [p.number, ...refs].flatMap((n) => apiAll(`${API_ISSUE(n)}/comments`, { allowFail: true }) ?? []);
  const last = deployMarkers(comments).sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? ''))).at(-1);
  const command = `ghosty-dev deploy ${p.number}`;
  if (!last) return { state: 'none', label: 'Sin deploy registrado (repo privado: el deploy sale de tu terminal)', command, private: true };
  return { state: last.ok ? 'success' : 'failure', label: last.ok ? `En producción (${last.sha.slice(0, 7)})` : `Deploy falló (${last.sha.slice(0, 7)})`, command: last.ok ? null : command, private: true };
}

// Repo privado: el último PR que entró a la base en las últimas 24 h sin marcador de deploy (null si no hay).
function undeployedMerge(base) {
  if (!isPrivateRepo()) return null;
  const since = Date.now() - 24 * 3600_000;
  const merged = (api('GET', `${REPO}/pulls?state=closed&base=${encodeURIComponent(base)}&sort=updated&direction=desc&per_page=10`, undefined, { allowFail: true }) ?? [])
    .filter((p) => p?.merged_at && Date.parse(p.merged_at) >= since)
    .sort((a, b) => String(b.merged_at).localeCompare(String(a.merged_at)));
  const last = merged[0];
  if (!last) return null;
  const d = privateDeployOf(last);
  return d.state === 'success' ? null : { pr: last.number, state: d.state, declared: Boolean(deployConfig(repoTop()).deploy) };
}

// ---------- next: el siguiente paso correcto, según el estado del repo (sobrevive a la compactación) ----------

// Lo que se pierde al resumir una sesión es el camino («empieza por claim»), no el destino («publica evidencia»)
// (Formmy, fila 32). `next` lo reconstruye desde la bitácora: rama actual, su PR, el pendiente que cierra, CI,
// revisión del commit HEAD, evidencia y pedidos. Regresa { step, command, why, … }.
// Chequeo del lock en la raíz del clon (null fuera de un repo).
export const repoTop = () => git(['rev-parse', '--show-toplevel'], { allowFail: true })?.trim() || null;
export function repoLock() {
  const top = repoTop();
  return top ? checkLock(top) : null;
}

// Revisor externo de la rama base (config.json) o el de por defecto, igual que la puerta.
function reviewConfigOnBase(base) {
  const f = api('GET', `${REPO}/contents/.github/ghosty-dev/config.json?ref=${encodeURIComponent(base)}`, undefined, { allowFail: true });
  const raw = f?.content ? Buffer.from(f.content, 'base64').toString('utf8') : '';
  return reviewCheckConfig(raw) ?? { ...DEFAULT_REVIEW_CHECK };
}

export function next() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })?.trim() || null;
  const info = api('GET', REPO);
  const def = info.default_branch || 'main';
  const prs = openPrs();
  const pr = branch && branch !== def ? prs.find((p) => p.headRefName === branch) : null;
  // Con PR: además del comando para el agente, el paso del tablero (quién tiene la pelota), igual que en Ghosty.
  const board = pr?.headRefOid ? boardNext(checksLite(pr.headRefOid), { draft: !!pr.draft }) : null;
  const out = (step, command, why, extra = {}) => ({ step, command, why, branch, ...extra, ...(board ? { board: { ...board, line: nextLine(board) } } : {}) });
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
    if (pr.draft) {
      // Un borrador sin motivo no dice nada en el tablero (Formmy, fila 45): si es porque algo no funciona, se dice.
      const said = (apiAll(`${API_ISSUE(n)}/comments`, { allowFail: true }) ?? []).some((c) => (c.body ?? '').startsWith(BLOCK_MARK));
      return said
        ? out('iterar', `gh pr ready ${pr.number}`, `el PR es borrador y #${n} está bloqueado con motivo: arréglalo y márcalo listo (o pide ayuda a la persona)`, extra)
        : out('iterar', `gh pr ready ${pr.number}`, `el PR es borrador: la puerta no exige nada hasta marcarlo listo; termina y márcalo. Si lo pasaste a borrador porque algo no funciona, di el motivo: ghosty-dev block ${n} --reason "…"`, extra);
    }
    const checks = commitChecks(pr.headRefOid);
    const ci = ciVerdict(checks);
    if (ci === 'pendiente' || ci === 'sin-checks') return out('esperar-ci', `ghosty-dev wait --pr ${pr.number} --until ci`, `el CI del commit ${pr.headRefOid.slice(0, 7)} no ha resuelto`, extra);
    if (ci === 'rojo') return out('arreglar-ci', `ghosty-dev show --pr ${pr.number}`, 'el CI salió rojo: arréglalo en la rama y vuelve a subir', extra);
    const issue = viewIssue(n, { comments: true });
    // El check del revisor externo (misma lógica que la puerta: externalReview) cuenta como revisión del commit.
    const ext = externalReview(reviewConfigOnBase(def), checks.runs, pr.headRefOid);
    if (ext?.state === 'pending') return out('esperar-ci', `ghosty-dev wait --pr ${pr.number} --until ci`, `el check «${ext.name}» del commit ${pr.headRefOid.slice(0, 7)} sigue corriendo`, extra);
    const rev = ext?.state === 'passed' ? { open: 0 } : ext?.state === 'findings' ? { open: 1 } : findRevisionFor(issue.comments, pr.headRefOid);
    if (!rev) return out('revision', `ghosty-dev review ${n} --pr ${pr.number}`, `falta la revisión del commit ${pr.headRefOid.slice(0, 7)} (otra sesión con contexto limpio: subagente ghosty-dev-revisor)`, extra);
    if (rev.open > 0) return out('hallazgos', `ghosty-dev review ${n} --pr ${pr.number}`, `la revisión tiene ${rev.open} hallazgo(s) abierto(s): arréglalos, sube y pide revisión otra vez`, extra);
    if (!findValidEvidence(issue.comments, issue.body))
      return out('evidencia', `ghosty-dev evidence ${n} --pr ${pr.number} --file evidencia.md`, 'CI verde y revisión limpia: prueba la vista previa (ghosty-dev preview --wait) y publica la evidencia', extra);
    return out('listo', `ghosty-dev merge ${pr.number}`, `#${n} tiene revisión y evidencia del commit actual: la persona lee la evidencia y decide el merge del PR #${pr.number}; si te lo pidió, hazlo con ghosty-dev merge (verifica todos los checks y espera el deploy), nunca con gh pr merge`, extra);
  }
  // La rama tuvo PR y lo cerraron sin merge (Formmy, fila 42): primero decidir si se reabre.
  if (branch && branch !== def) {
    const closed = closedPrOf({ branch });
    if (closed) return out('reabrir', `gh pr reopen ${closed.pr}`, `${closedLine(closed)}. Mientras siga cerrado, un push a ${branch} no corre CI, vista previa ni revisión`, { pr: closed.pr, closed });
  }
  const own = branch?.match(/^ghosty-dev\/(\d+)-/);
  if (own) return out('abrir-pr', `ghosty-dev pr ${own[1]}`, `la rama de #${own[1]} no tiene PR abierto (sube la rama y abre el PR con «Closes #${own[1]}»)`, { issue: Number(own[1]) });
  if (branch && branch !== def) return out('ligar', `ghosty-dev pr <n>`, `la rama ${branch} no tiene PR ni pendiente: \`ghosty-dev pr <n>\` la sube, abre el PR y la liga a #n (el trabajo tiene que vivir en la bitácora)`);
  // Repo privado: un merge sin deploy va antes de tomar trabajo nuevo (no hay Actions que lo despliegue solo).
  const undeployed = !branch || branch === def ? undeployedMerge(def) : null;
  if (undeployed)
    return out('deploy', `ghosty-dev deploy ${undeployed.pr}`, `el PR #${undeployed.pr} ya entró a ${def} y ${undeployed.state === 'failure' ? 'su deploy falló' : 'no tiene deploy registrado'} (repo privado: sin GitHub Actions, el deploy sale de tu terminal)${undeployed.declared ? '' : `; antes, ${DEPLOY_HOWTO}`}`, { pr: undeployed.pr });
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

export function close(n, { duplicateOf } = {}) {
  if (duplicateOf !== undefined) {
    // Un duplicado no lleva evidencia: se cierra como «no planeado» y dice de cuál es copia.
    if (!Number.isInteger(duplicateOf) || duplicateOf <= 0 || duplicateOf === n) throw new UserError('--duplicate-of va con el número del pendiente original (distinto de n).');
    const issue = viewIssue(n);
    if (issue.state !== 'OPEN') throw new UserError(`#${n} ya está cerrado.`);
    const original = api('GET', API_ISSUE(duplicateOf), undefined, { allowFail: true });
    if (!original) throw new UserError(`No encuentro #${duplicateOf} en este repo.`);
    api('POST', `${API_ISSUE(n)}/comments`, { body: `Duplicado de #${duplicateOf}.` });
    api('PATCH', API_ISSUE(n), { state: 'closed', state_reason: 'not_planned' });
    return { number: n, state: 'cerrado', duplicateOf };
  }
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

// Sin GitHub (init --files-only): repo y rama salen del git local; no hay etiquetas que crear.
export function initTargetLocal(dir) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, allowFail: true })?.trim() || null;
  const remote = git(['config', '--get', 'remote.origin.url'], { cwd: dir, allowFail: true })?.trim() || '';
  const repo = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/)?.[1] ?? (remote || '(sin remoto origin)');
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: dir, allowFail: true })?.trim().replace(/^origin\//, '');
  const defaultBranch = head || 'main';
  return { repo, branch, defaultBranch, labelsToCreate: [], pushWorkflows: pushWorkflows(dir, defaultBranch) };
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
# «Ghosty · Smoke»: páginas o pasos (con método y cuerpo JSON) que deben dar 2xx en la vista previa de cada PR, ya con
# sesión (identidad ghosty-smoke). Pon la FUNCIÓN PRINCIPAL, no sólo /login: un smoke de /login pasó en verde con el
# chat roto (Formmy #73). Quita los # y cámbialos:
# smoke:
#   - /ruta-de-la-funcion-principal
#   - POST /api/accion-principal {"campo":"valor"}
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

const PR_TEMPLATE_PATHS = ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md', 'docs/PULL_REQUEST_TEMPLATE.md', '.github/PULL_REQUEST_TEMPLATE'];
const MAIN_FLOW_LINE = 'Flujo principal probado con sesión:';

// Un factory.md sin `smoke:` en su frontmatter: se sugiere la ruta de la función principal (Formmy, fila 44).
function smokeHint(path) {
  try {
    const front = readFileSync(path, 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    return /^smoke:/m.test(front) ? '' : '; sin smoke: agrega a su frontmatter «smoke:» con la función principal (p. ej. «- POST /api/accion {"x":1}»), no sólo /login';
  } catch {
    return '';
  }
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

// doctor: un repo privado con los workflows de ghosty-dev. Con Actions bloqueado nunca arrancan, y la puerta
// queda «esperando» un job que no llega (Formmy, 27-nov). null si no aplica.
export function privateWorkflowsCheck(dir) {
  if (!isPrivateRepo({ cwd: dir })) return null;
  const found = ACTIONS_WORKFLOWS.filter((f) => existsSync(join(dir, f)));
  if (!found.length) return { name: 'privado-sin-actions', ok: true, detail: `${PRIVATE_WHY}`, fix: null };
  return {
    name: 'privado-sin-actions',
    ok: null,
    detail: `repo privado con ${found.join(', ')}: si GitHub Actions está bloqueado nunca arrancan; la puerta la evalúa Ghosty Studio y el deploy sale de ghosty-dev deploy`,
    fix: `bórralos: git rm ${found.join(' ')} && git commit -m "ghosty-dev: repo privado sin Actions"`,
  };
}

// `labels: false`: no crea las etiquetas en GitHub (la persona no lo confirmó); quedan en el plan como «skip».
const REVIEW_CONFIG_PATH = '.github/ghosty-dev/config.json';
const REVIEW_CHECK_DEFAULT = { name: 'Ghosty Review', app: 'ghosty-studio' };

export function init(dir, { dryRun = false, force = false, protectBranch = true, labels = true, filesOnly = false, noChecks = false } = {}) {
  // Repo privado: ningún workflow de ghosty-dev (sin GitHub Actions). Con --files-only no se pregunta a GitHub: sólo
  // cuenta GHOSTY_DEV_REPO_VISIBILITY=private (la caja de gs lo pasa).
  const priv = filesOnly ? process.env.GHOSTY_DEV_REPO_VISIBILITY === 'private' : isPrivateRepo({ cwd: dir });
  const files = [
    ['templates/pendiente.md', '.github/ISSUE_TEMPLATE/pendiente.md'],
    ...(priv ? [] : [['.github/workflows/evidence-gate.yml', '.github/workflows/evidence-gate.yml']]),
    // Revisiones de Ghosty: llama al workflow reutilizable blissito/ghosty-dev/.github/workflows/checks.yml@v1.
    ...(noChecks || priv ? [] : [['templates/ghosty-checks.yml', '.github/workflows/ghosty-checks.yml']]),
    ['src/evidence.mjs', '.github/ghosty-dev/evidence.mjs'],
    ['src/gate.mjs', '.github/ghosty-dev/gate.mjs'],
    ['skill/SKILL.md', '.claude/skills/ghosty-dev/SKILL.md'],
    ['agents/ghosty-dev-revisor.md', '.claude/agents/ghosty-dev-revisor.md'],
  ];
  const plan = [];
  // filesOnly: sólo archivos del árbol de trabajo; ni etiquetas ni protección ni una llamada a GitHub.
  if (filesOnly) protectBranch = false;
  if (priv) plan.push({ action: 'privado', private: true, name: `sin workflows de GitHub Actions (${ACTIONS_WORKFLOWS.map((f) => basename(f)).join(', ')}): ${PRIVATE_WHY}` });
  if (!filesOnly) for (const state of STATES) plan.push(labels ? { action: 'label', name: label(state) } : { action: 'skip', name: `${label(state)} (etiqueta no creada: confirma con ghosty-dev init --yes)` });
  for (const [, to] of files) {
    const exists = existsSync(join(dir, to));
    // Un workflow NUEVO no es de la puerta: CI extra que la persona debe revisar antes de commitear.
    const fresh = !exists && to === '.github/workflows/ghosty-checks.yml';
    plan.push({ action: exists && !force ? 'skip' : 'write', path: to, ...(fresh ? { name: `${to} (NUEVO workflow, no es de la puerta: revisa antes de commitear; --no-checks lo omite)`, newWorkflow: true } : {}) });
  }
  // Plantilla del PR con el renglón obligatorio «Flujo principal probado con sesión» (Formmy, fila 46). GitHub usa una
  // sola: si el repo ya tiene la suya (en cualquiera de sus rutas), no se escribe otra y se dice qué agregarle.
  const prTemplate = PR_TEMPLATE_PATHS.find((p) => existsSync(join(dir, p)));
  plan.push(
    prTemplate && !(force && prTemplate === PR_TEMPLATE_PATHS[0])
      ? { action: 'skip', path: prTemplate, name: `${prTemplate} (ya existe: agrégale el renglón «${MAIN_FLOW_LINE} <qué y cómo>»)` }
      : { action: 'write', path: PR_TEMPLATE_PATHS[0] },
  );
  // La revisión del pendiente en la nube la hace Ghosty Review (otra identidad: el check «Ghosty Review» de la app
  // ghosty-studio). Sin `reviewCheck` la puerta sólo acepta `ghosty-dev review` y NINGÚN PR de la nube pasa (Formmy, 23-nov:
  // la evidencia fallaba en todos). Si el check no existe en el repo, la puerta cae a la revisión por comentario: es inocuo.
  // Es configuración del repo: no se pisa (ni con --force); si ya existe sin `reviewCheck`, se dice qué agregarle.
  const configPath = join(dir, REVIEW_CONFIG_PATH);
  const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : null;
  plan.push(
    configText === null
      ? { action: 'write', path: REVIEW_CONFIG_PATH, name: `${REVIEW_CONFIG_PATH} (acepta el check «Ghosty Review» como revisor)` }
      : reviewCheckConfig(configText)
        ? { action: 'skip', path: REVIEW_CONFIG_PATH, name: `${REVIEW_CONFIG_PATH} (ya tiene reviewCheck)` }
        : { action: 'skip', path: REVIEW_CONFIG_PATH, name: `${REVIEW_CONFIG_PATH} (ya existe sin reviewCheck: agrégale ${JSON.stringify({ reviewCheck: REVIEW_CHECK_DEFAULT })} o los PR de la nube no pasarán la puerta)` },
  );
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
      : { action: 'skip', path: FACTORY_FILE, name: `${FACTORY_FILE} (ya existe: no se toca, ni con --force)${smokeHint(factoryPath)}` },
  );
  const hook = prePushTarget(dir);
  plan.push(hook.action === 'write' ? { action: 'write', path: hook.shown, name: `${hook.shown} (chequeo del lock antes de subir)` } : { action: 'skip', path: hook.shown, name: `${hook.shown} (${hook.why})` });
  if (protectBranch) plan.push({ action: 'gate', name: `${GATE_CHECK} obligatorio en la rama principal` });
  if (dryRun) return plan;
  if (hook.action === 'write') {
    mkdirSync(dirname(hook.path), { recursive: true });
    writeFileSync(hook.path, PRE_PUSH, { mode: 0o755 });
  }

  for (const state of labels && !filesOnly ? STATES : []) {
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
  if (plan.some((x) => x.action === 'write' && x.path === PR_TEMPLATE_PATHS[0])) {
    mkdirSync(join(dir, '.github'), { recursive: true });
    copyFileSync(join(ROOT, 'templates/pull_request_template.md'), join(dir, PR_TEMPLATE_PATHS[0]));
  }
  if (box) {
    mkdirSync(dirname(factoryPath), { recursive: true });
    writeFileSync(factoryPath, factoryManifest(box));
  }
  if (configText === null) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify({ reviewCheck: REVIEW_CHECK_DEFAULT }, null, 2)}\n`);
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
