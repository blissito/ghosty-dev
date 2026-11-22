// Comandos de la bitácora. Cada uno se traza a una ley o a una fuente (ver SPEC.md, «Qué copiamos y de quién»).
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { api, apiAll, git } from './gh.mjs';
import { validateEvidence, formatEvidence, findValidEvidence, validateRevision, formatRevision } from './evidence.mjs';

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
const openPrs = () =>
  apiAll(`${REPO}/pulls?state=open`).map((p) => ({ number: p.number, url: p.html_url, headRefName: p.head.ref, headRefOid: p.head.sha }));

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

// CI del PR del pendiente (rama ghosty-dev/<n>-…), sin contar la propia puerta de evidencia.
function ciOf(n) {
  const pr = openPrs().find((p) => p.headRefName.startsWith(`ghosty-dev/${n}-`));
  if (!pr) return { status: 'sin-pr' };
  // Check-runs (Actions y apps) + statuses clásicos del commit del PR.
  const runs = apiAll(`${REPO}/commits/${pr.headRefOid}/check-runs`, { pick: (r) => r.check_runs, allowFail: true }) ?? [];
  const statuses = api('GET', `${REPO}/commits/${pr.headRefOid}/status`, undefined, { allowFail: true })?.statuses ?? [];
  const checks = [
    ...runs.map((c) => ({ name: c.name, done: c.status === 'completed', result: c.conclusion })),
    ...statuses.map((c) => ({ name: c.context, done: c.state !== 'pending', result: c.state })),
  ].filter((c) => !(c.name || '').startsWith('ghosty-dev'));
  // Justo después de un push GitHub aún no registra los checks del commit nuevo: cero checks NO es verde.
  if (checks.length === 0) return { status: 'sin-checks', pr };
  if (checks.some((c) => !c.done)) return { status: 'pendiente', pr };
  const red = checks.some((c) => ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'error'].includes(c.result));
  return { status: red ? 'rojo' : 'verde', pr };
}

const me = () => api('GET', 'user').login;

// ---------- ready (Beads: bd ready) ----------

export function ready() {
  const open = openIssues();
  const openNumbers = new Set(open.map((i) => i.number));
  let login = null;
  const out = [];
  for (const issue of open.sort((a, b) => a.number - b.number)) {
    const state = stateOf(issue);
    const base = { number: issue.number, title: issue.title, url: issue.url, state };
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

export function claim(n, { worktree = true } = {}) {
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
      git(exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path], { cwd: top });
    }
  }
  return { number: n, title: issue.title, branch, worktree: path };
}

// ---------- wait (Ley 3; Beads gates «so agents never need to poll») ----------

// Ley 3: esperar no es sondear. Con --watch, una sola llamada bloqueante del CLI espera al CI (el CLI mira cada
// 10 s; el agente no gasta tokens); si tarda más que el tope, el pendiente queda en esperando-ci y el agente sigue con otro.
export function wait(n, { watch = false, minutes = 5 } = {}) {
  const issue = viewIssue(n);
  const state = stateOf(issue);
  if (state !== 'tomado' && state !== 'esperando') throw new UserError(`#${n} no está tomado; primero ghosty-dev claim ${n}.`);
  if (state === 'tomado') setState(issue, 'esperando');
  if (!watch) return { number: n, state: 'esperando' };
  let before = ciOf(n);
  if (!before.pr) return { number: n, state: 'esperando', ci: 'sin-pr' };
  // Tras un push, los checks tardan unos segundos en aparecer: se espera a que existan (tope ~90 s).
  const step = Number(process.env.GHOSTY_DEV_REGISTER_WAIT_MS ?? 10_000);
  for (let i = 0; before.status === 'sin-checks' && i < 9; i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, step);
    before = ciOf(n);
  }
  let ci = before;
  const every = Number(process.env.GHOSTY_DEV_WATCH_MS ?? 10_000);
  for (const until = Date.now() + minutes * 60_000; ci.status === 'pendiente' && Date.now() < until; ) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, every);
    ci = ciOf(n);
  }
  return { number: n, state: 'esperando', ci: ci.status, pr: ci.pr?.url ?? null, timedOut: ci.status === 'pendiente' };
}

// PR abierto del pendiente (rama ghosty-dev/<n>-…).
function prOf(n) {
  return openPrs().find((p) => p.headRefName.startsWith(`ghosty-dev/${n}-`)) ?? null;
}

// Vuelve a correr la puerta del PR del pendiente: publicar evidencia o revisión es el evento que la despierta.
function rerunGate(n) {
  const pr = prOf(n);
  let rerun = null;
  if (pr) {
    const runs = api(
      'GET',
      `${REPO}/actions/workflows/evidence-gate.yml/runs?branch=${encodeURIComponent(pr.headRefName)}&per_page=1`,
      undefined,
      { allowFail: true },
    )?.workflow_runs;
    if (runs?.[0] && api('POST', `${REPO}/actions/runs/${runs[0].id}/rerun`, undefined, { allowFail: true }) !== null) rerun = runs[0].id;
  }
  return rerun;
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

export function evidence(n, file) {
  if (!file || !existsSync(file)) throw new UserError('Falta --file <evidencia.md>.');
  const md = readFileSync(file, 'utf8');
  const issue = viewIssue(n);
  const { ok, errors } = validateEvidence(md, issue.body);
  if (!ok) throw new UserError(`Evidencia inválida para #${n}:\n- ${errors.join('\n- ')}`);
  const url = api('POST', `${API_ISSUE(n)}/comments`, { body: formatEvidence(n, md, prOf(n)) }).html_url;
  // Ley 3: publicar la evidencia es el evento que vuelve a correr la puerta del PR.
  const rerun = rerunGate(n);
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

export function review(n, { file } = {}) {
  if (!file) return { number: n, brief: reviewBrief(n) };
  if (!existsSync(file)) throw new UserError(`No existe ${file}.`);
  const md = readFileSync(file, 'utf8');
  const { ok, errors, open } = validateRevision(md);
  if (!ok) throw new UserError(`Revisión inválida para #${n}:\n- ${errors.join('\n- ')}`);
  const pr = prOf(n);
  if (!pr?.headRefOid) throw new UserError(`#${n} no tiene PR abierto: la revisión va sobre el commit del PR.`);
  const url = api('POST', `${API_ISSUE(n)}/comments`, { body: formatRevision(n, pr.headRefOid, md, pr) }).html_url;
  return { number: n, sha: pr.headRefOid, open, url: url || null, rerun: rerunGate(n) };
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

export function show(n) {
  const issue = viewIssue(n, { comments: true });
  const open = openIssues();
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state === 'OPEN' ? stateOf(issue) : 'cerrado',
    assignees: issue.assignees.map((a) => a.login),
    blockedBy: openBlockers(issue, new Set(open.map((i) => i.number))),
    evidence: Boolean(findValidEvidence(issue.comments, issue.body)),
    url: issue.url,
  };
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

export function init(dir, { dryRun = false, force = false, protectBranch = true } = {}) {
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
  for (const state of STATES) plan.push({ action: 'label', name: label(state) });
  for (const [, to] of files) {
    const exists = existsSync(join(dir, to));
    plan.push({ action: exists && !force ? 'skip' : 'write', path: to });
  }
  const agentsPath = join(dir, 'AGENTS.md');
  const agentsText = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : null;
  const agentsAction =
    agentsText === null ? 'write' : !agentsText.includes(AGENTS_MARK) ? 'append' : force ? 'update' : 'skip';
  plan.push({ action: agentsAction, path: 'AGENTS.md' });
  if (protectBranch) plan.push({ action: 'gate', name: `${GATE_CHECK} obligatorio en la rama principal` });
  if (dryRun) return plan;

  for (const state of STATES) {
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
