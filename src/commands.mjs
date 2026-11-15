// Comandos de la bitácora. Cada uno se traza a una ley o a una fuente (ver SPEC.md, «Qué copiamos y de quién»).
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, appendFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gh, ghJson, git } from './gh.mjs';
import { validateEvidence, formatEvidence, findValidEvidence } from './evidence.mjs';

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

const ISSUE_FIELDS = 'number,title,state,labels,assignees,body,url';
const API_ISSUE = (n) => `repos/{owner}/{repo}/issues/${n}`;

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

function viewIssue(n, extra = '') {
  return ghJson(['issue', 'view', String(n), '--json', ISSUE_FIELDS + extra]);
}

// Bloqueos abiertos de un pendiente: dependencias nativas de GitHub + la lista del cuerpo.
function openBlockers(issue, openNumbers) {
  const native = ghJson(['api', `${API_ISSUE(issue.number)}/dependencies/blocked_by`], { allowFail: true }) ?? [];
  const all = new Set([...native.map((i) => i.number), ...parseBlockedBy(issue.body)]);
  return [...all].filter((n) => openNumbers.has(n));
}

// CI del PR del pendiente (rama ghosty-dev/<n>-…), sin contar la propia puerta de evidencia.
function ciOf(n) {
  const prs = ghJson(['pr', 'list', '--state', 'open', '--json', 'number,url,headRefName,statusCheckRollup']) ?? [];
  const pr = prs.find((p) => p.headRefName.startsWith(`ghosty-dev/${n}-`));
  if (!pr) return { status: 'sin-pr' };
  const checks = (pr.statusCheckRollup || []).filter((c) => !(c.name || c.context || '').startsWith('ghosty-dev'));
  const pending = checks.some((c) => (c.status ? c.status !== 'COMPLETED' : ['PENDING', 'EXPECTED'].includes(c.state)));
  if (pending) return { status: 'pendiente', pr };
  const red = checks.some((c) =>
    ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'].includes(c.conclusion || c.state),
  );
  return { status: red ? 'rojo' : 'verde', pr };
}

const me = () => ghJson(['api', 'user']).login;

// ---------- ready (Beads: bd ready) ----------

export function ready() {
  const open = ghJson(['issue', 'list', '--state', 'open', '--limit', '500', '--json', ISSUE_FIELDS]);
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
      if (mine && ci.status !== 'pendiente') out.push({ ...base, reason: `ci-${ci.status}`, pr: ci.pr?.url ?? null });
    }
  }
  return out;
}

// ---------- claim (Beads: bd update --claim; un solo escritor, Cognition) ----------

const slug = (title) =>
  title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

function setState(issue, state, extraArgs = []) {
  const remove = (issue.labels || []).map((l) => l.name).filter((name) => name.startsWith('ghosty-dev:') && name !== label(state));
  const args = ['issue', 'edit', String(issue.number), '--add-label', label(state), ...extraArgs];
  if (remove.length) args.push('--remove-label', remove.join(','));
  gh(args);
}

export function claim(n, { worktree = true } = {}) {
  const issue = viewIssue(n);
  if (issue.state !== 'OPEN') throw new UserError(`#${n} está cerrado.`);
  const login = me();
  const other = issue.assignees.find((a) => a.login !== login);
  if (other) throw new UserError(`Un solo escritor por pendiente: #${n} ya lo tiene @${other.login}.`);
  const open = ghJson(['issue', 'list', '--state', 'open', '--limit', '500', '--json', 'number']);
  const blockers = openBlockers(issue, new Set(open.map((i) => i.number)));
  if (blockers.length) throw new UserError(`#${n} está bloqueado por ${blockers.map((b) => '#' + b).join(', ')}.`);

  setState(issue, 'tomado', ['--add-assignee', '@me']);
  // El primero gana: si otro se asignó al mismo tiempo, me retiro.
  const after = viewIssue(n);
  if (after.assignees.some((a) => a.login !== login)) {
    gh(['issue', 'edit', String(n), '--remove-assignee', '@me']);
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

// Ley 3: esperar no es sondear. Con --watch, una sola llamada bloqueante (gh pr checks --watch) espera al CI
// sin gastar tokens; si tarda más que el tope, el pendiente queda en esperando-ci y el agente sigue con otro.
export function wait(n, { watch = false, minutes = 5 } = {}) {
  const issue = viewIssue(n);
  const state = stateOf(issue);
  if (state !== 'tomado' && state !== 'esperando') throw new UserError(`#${n} no está tomado; primero ghosty-dev claim ${n}.`);
  if (state === 'tomado') setState(issue, 'esperando');
  if (!watch) return { number: n, state: 'esperando' };
  const before = ciOf(n);
  if (!before.pr) return { number: n, state: 'esperando', ci: 'sin-pr' };
  if (before.status === 'pendiente') {
    gh(['pr', 'checks', String(before.pr.number), '--watch', '--interval', '10'], { allowFail: true, timeout: minutes * 60_000 });
  }
  const ci = ciOf(n);
  return { number: n, state: 'esperando', ci: ci.status, pr: ci.pr?.url ?? null, timedOut: ci.status === 'pendiente' };
}

// ---------- evidence (Ley 2; «proof of work», Symphony) ----------

export function evidence(n, file) {
  if (!file || !existsSync(file)) throw new UserError('Falta --file <evidencia.md>.');
  const md = readFileSync(file, 'utf8');
  const issue = viewIssue(n);
  const { ok, errors } = validateEvidence(md, issue.body);
  if (!ok) throw new UserError(`Evidencia inválida para #${n}:\n- ${errors.join('\n- ')}`);
  gh(['issue', 'comment', String(n), '--body-file', '-'], { input: formatEvidence(n, md) });
  // Ley 3: publicar la evidencia es el evento que vuelve a correr la puerta del PR.
  const prs = ghJson(['pr', 'list', '--state', 'open', '--json', 'number,headRefName']) ?? [];
  const pr = prs.find((p) => p.headRefName.startsWith(`ghosty-dev/${n}-`));
  let rerun = null;
  if (pr) {
    const runs = ghJson(
      ['run', 'list', '--workflow', 'evidence-gate.yml', '--branch', pr.headRefName, '--limit', '1', '--json', 'databaseId'],
      { allowFail: true },
    );
    if (runs?.[0] && gh(['run', 'rerun', String(runs[0].databaseId)], { allowFail: true }) !== null) rerun = runs[0].databaseId;
  }
  return { number: n, posted: true, rerun };
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
  const url = gh(['issue', 'create', '--title', title.trim(), '--label', label('listo'), '--body-file', '-'], { input: body }).trim();
  const number = Number(url.match(/(\d+)\s*$/)?.[1]);
  if (!number) throw new Error(`No se pudo leer el número del pendiente: ${url}`);
  const blocked = blockedBy ? block(number, blockedBy) : null;
  return { number, title: title.trim(), url, blockedBy: blocked?.blockedBy ?? null };
}

// ---------- board: la persona ve los pendientes en GitHub, no en la terminal ----------

export function board() {
  const repo = ghJson(['repo', 'view', '--json', 'url']);
  const url = `${repo.url}/issues?q=${encodeURIComponent('is:issue is:open label:ghosty-dev:listo,ghosty-dev:tomado,ghosty-dev:esperando,ghosty-dev:bloqueado')}`;
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
  const blocker = ghJson(['api', API_ISSUE(by)]);
  const native = gh(['api', '-X', 'POST', `${API_ISSUE(n)}/dependencies/blocked_by`, '-F', `issue_id=${blocker.id}`], {
    allowFail: true,
  });
  if (native === null) {
    gh(['issue', 'edit', String(n), '--body-file', '-'], { input: addBlockedBy(issue.body, by) });
    setState(issue, 'bloqueado');
  } else if (stateOf(issue) !== 'listo') {
    setState(issue, 'listo'); // GitHub ya lo marca «Blocked»: la etiqueta sigue en «por hacer»
  }
  return { number: n, blockedBy: by, via: native === null ? 'cuerpo' : 'github' };
}

// ---------- show (Beads: bd show) ----------

export function show(n) {
  const issue = viewIssue(n, ',comments');
  const open = ghJson(['issue', 'list', '--state', 'open', '--limit', '500', '--json', 'number']);
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
  const issue = viewIssue(n, ',comments');
  if (!findValidEvidence(issue.comments, issue.body)) {
    throw new UserError(`#${n} no tiene comentario de evidencia válido: no se cierra. Usa ghosty-dev evidence ${n} --file evidencia.md.`);
  }
  gh(['issue', 'close', String(n), '--reason', 'completed']);
  return { number: n, state: 'cerrado' };
}

// ---------- init (Beads: bd init escribe AGENTS.md e instala la skill) ----------

const AGENTS_MARK = '<!-- ghosty-dev:agents -->';

// ---------- puerta obligatoria (Ley 2): el check ghosty-dev/evidencia se exige en la rama principal ----------

export const GATE_CHECK = 'ghosty-dev/evidencia';

// Agrega el check a la protección de la rama sin pisar la que ya exista. Usa el gh de la persona: hace falta ser
// admin del repo (en privados, además, un plan de pago de GitHub). Si no se puede, devuelve el motivo.
export function protect(dir) {
  const repo = ghJson(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'], { cwd: dir, allowFail: true });
  if (!repo) return { ok: false, reason: 'no se pudo leer el repo con gh' };
  const branch = repo.defaultBranchRef?.name || 'main';
  // La Action corre la puerta desde la rama base: si todavía no está ahí, exigir el check bloquearía TODOS los PR.
  const onBase = gh(['api', `repos/${repo.nameWithOwner}/contents/.github/ghosty-dev/gate.mjs?ref=${branch}`], { cwd: dir, allowFail: true });
  if (onBase == null) return { ok: false, later: true, branch, reason: `la puerta todavía no está en ${branch}` };
  const base = `repos/${repo.nameWithOwner}/branches/${branch}/protection`;
  const has = gh(['api', base], { cwd: dir, allowFail: true });
  let done;
  if (has == null) {
    const body = { required_status_checks: { strict: false, contexts: [GATE_CHECK] }, enforce_admins: false, required_pull_request_reviews: null, restrictions: null };
    done = gh(['api', '-X', 'PUT', base, '--input', '-'], { cwd: dir, input: JSON.stringify(body), allowFail: true });
  } else {
    const current = JSON.parse(has).required_status_checks;
    if (current?.contexts?.includes(GATE_CHECK)) return { ok: true, repo: repo.nameWithOwner, branch, already: true };
    done = current
      ? gh(['api', '-X', 'POST', `${base}/required_status_checks/contexts`, '--input', '-'], { cwd: dir, input: JSON.stringify({ contexts: [GATE_CHECK] }), allowFail: true })
      : gh(['api', '-X', 'PATCH', `${base}/required_status_checks`, '--input', '-'], { cwd: dir, input: JSON.stringify({ strict: false, contexts: [GATE_CHECK] }), allowFail: true });
  }
  if (done == null) return { ok: false, branch, reason: 'GitHub no dejó proteger la rama (¿eres admin? en repos privados pide plan de pago)' };
  return { ok: true, repo: repo.nameWithOwner, branch };
}

export function init(dir, { dryRun = false, force = false, protectBranch = true } = {}) {
  const files = [
    ['templates/pendiente.md', '.github/ISSUE_TEMPLATE/pendiente.md'],
    ['.github/workflows/evidence-gate.yml', '.github/workflows/evidence-gate.yml'],
    ['src/evidence.mjs', '.github/ghosty-dev/evidence.mjs'],
    ['src/gate.mjs', '.github/ghosty-dev/gate.mjs'],
    ['skill/SKILL.md', '.claude/skills/ghosty-dev/SKILL.md'],
  ];
  const plan = [];
  for (const state of STATES) plan.push({ action: 'label', name: label(state) });
  for (const [, to] of files) {
    const exists = existsSync(join(dir, to));
    plan.push({ action: exists && !force ? 'skip' : 'write', path: to });
  }
  const agentsPath = join(dir, 'AGENTS.md');
  const agentsText = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : null;
  const agentsAction = agentsText === null ? 'write' : agentsText.includes(AGENTS_MARK) ? 'skip' : 'append';
  plan.push({ action: agentsAction, path: 'AGENTS.md' });
  if (protectBranch) plan.push({ action: 'gate', name: `${GATE_CHECK} obligatorio en la rama principal` });
  if (dryRun) return plan;

  for (const state of STATES) {
    const [color, description] = LABEL_STYLE[state];
    if (LEGACY[state]) gh(['label', 'edit', LEGACY[state], '--name', label(state)], { cwd: dir, allowFail: true });
    gh(['label', 'create', label(state), '--color', color, '--description', description, '--force'], { cwd: dir });
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
  if (protectBranch) {
    const r = protect(dir);
    const step = plan[plan.length - 1];
    if (r.ok) step.name = `${GATE_CHECK} obligatorio en ${r.branch}${r.already ? ' (ya estaba)' : ''}`;
    else if (r.later) Object.assign(step, { action: 'later', name: `${GATE_CHECK}: sube estos archivos directo a ${r.branch} y luego corre ghosty-dev protect` });
    else Object.assign(step, { action: 'skip', name: `${GATE_CHECK}: ${r.reason}. Márcalo en Settings → Branches.` });
  }
  return plan;
}
