// `ghosty-dev merge <pr>` (Formmy, fila 41): el #81 entró con `gh pr merge` mientras «Ghosty · Smoke» seguía en
// curso. Aquí el merge sólo va si TODOS los checks del commit de cabeza resolvieron en verde (o neutral/saltado), la
// puerta de evidencia pasó (si el repo la tiene), el PR no es borrador y no choca con su base. Después espera el
// deploy de producción (workflow que corre con push a la rama base) y dice cómo salió. La misma regla que el botón
// Merge y el automerge de Ghosty Studio.
import { api, apiAll } from './gh.mjs';
import { UserError, GATE_CHECK, closedInfo, closedLine, closingIssueLabels, mergeState, repoTop } from './commands.mjs';
import { closingRefs } from './gate.mjs';
import { pushWorkflows } from './workflows.mjs';

const REPO = 'repos/{owner}/{repo}';
export const OK_CONCLUSIONS = ['success', 'neutral', 'skipped'];
const DEPLOY = /deploy|release|publish|prod|ship|fly|vercel|render|railway|cd\b/i;

// Puro. `runs` = check-runs del commit (todas las pasadas), `statuses` = statuses clásicos. Por nombre manda la
// pasada más reciente. { ready, pending: [nombres], failing: [{ name, conclusion }], blockers: [frases] }.
export function mergeReadiness({ pr, runs = [], statuses = [], gateExpected = false, conflict = false }) {
  const blockers = [];
  if (pr.draft) blockers.push(`es borrador: márcalo listo (gh pr ready ${pr.number}) cuando la función principal funcione con sesión; si está bloqueado, dilo con ghosty-dev block <n> --reason "…"`);
  if (conflict) blockers.push(`está en conflicto con ${pr.base?.ref ?? 'main'}: resuélvelo y vuelve a subir`);
  const latest = new Map();
  for (const r of [...runs].sort((a, b) => (b.id ?? 0) - (a.id ?? 0))) if (r?.name && !latest.has(r.name)) latest.set(r.name, { name: r.name, done: r.status === 'completed', conclusion: r.conclusion ?? null });
  for (const s of statuses) if (s?.context && !latest.has(s.context)) latest.set(s.context, { name: s.context, done: s.state !== 'pending', conclusion: s.state === 'success' ? 'success' : s.state });
  const checks = [...latest.values()];
  const pending = checks.filter((c) => !c.done).map((c) => c.name);
  const failing = checks.filter((c) => c.done && !OK_CONCLUSIONS.includes(c.conclusion)).map((c) => ({ name: c.name, conclusion: c.conclusion }));
  if (!checks.length) pending.push('(GitHub todavía no registra checks en este commit)');
  else if (gateExpected && !latest.has(GATE_CHECK)) pending.push(`${GATE_CHECK} (no ha corrido en este commit)`);
  return { ready: !blockers.length && !pending.length && !failing.length, pending, failing, blockers };
}

export const readinessText = (pr, r) =>
  [
    ...r.blockers.map((b) => `  - ${b}`),
    ...r.failing.map((f) => `  - ${f.name}: ${f.conclusion ?? 'falló'}${f.name === GATE_CHECK ? ` (ghosty-dev show --pr ${pr})` : ''}`),
    ...(r.pending.length ? [`  - en curso: ${r.pending.join(', ')}`] : []),
  ].join('\n');

function snapshot(m) {
  const p = api('GET', `${REPO}/pulls/${m}`, undefined, { allowFail: true });
  if (!p?.number) throw new UserError(`No encontré el PR #${m} en este repo.`);
  const sha = p.head?.sha;
  const runs = apiAll(`${REPO}/commits/${sha}/check-runs`, { pick: (r) => r.check_runs, allowFail: true }) ?? [];
  const statuses = api('GET', `${REPO}/commits/${sha}/status`, undefined, { allowFail: true })?.statuses ?? [];
  return { p, sha, runs, statuses };
}

const gateOnBase = (base) => api('GET', `${REPO}/contents/.github/ghosty-dev/gate.mjs?ref=${encodeURIComponent(base)}`, undefined, { allowFail: true }) != null;

function readiness(m, gateExpected) {
  const { p, sha, runs, statuses } = snapshot(m);
  if (p.merged_at) return { p, sha, merged: true };
  if (p.state !== 'open') return { p, sha, closed: closedInfo(m, p) ?? { pr: m } };
  const st = mergeState(m, { tries: 2 });
  const conflict = Boolean(st && (st.state === 'dirty' || st.mergeable === false));
  return { p, sha, r: mergeReadiness({ pr: p, runs, statuses, gateExpected, conflict }) };
}

// Squash, merge o rebase: el primero que el repo permite (pedir uno deshabilitado da 405 sin decir cuál sí).
function methodFor(asked) {
  if (asked && !['squash', 'merge', 'rebase'].includes(asked)) throw new UserError('--method va con squash|merge|rebase.');
  if (asked) return asked;
  const info = api('GET', REPO, undefined, { allowFail: true }) ?? {};
  return info.allow_squash_merge ? 'squash' : info.allow_merge_commit === false && info.allow_rebase_merge ? 'rebase' : 'merge';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Los workflows de deploy: corren con push a la rama base y su archivo o nombre dice deploy/release/prod…
export function deployWorkflows(dir, base) {
  return dir ? pushWorkflows(dir, base).filter((w) => DEPLOY.test(w.file) || DEPLOY.test(w.name ?? '')) : [];
}

// Espera los runs de esos workflows sobre el commit del merge. { runs: [{ file, status, conclusion, url, id }], timedOut }.
async function waitDeploy(mergeSha, workflows, { minutes, unit, onNote }) {
  const deadline = Date.now() + minutes * 60_000;
  const files = new Set(workflows.map((w) => w.file));
  let seen = [];
  for (let i = 0; ; i++) {
    const runs = api('GET', `${REPO}/actions/runs?head_sha=${mergeSha}&event=push&per_page=50`, undefined, { allowFail: true })?.workflow_runs ?? [];
    seen = runs.filter((r) => files.has(r.path)).map((r) => ({ file: r.path, name: r.name ?? null, status: r.status, conclusion: r.conclusion ?? null, url: r.html_url ?? null, id: r.id }));
    // Cada workflow de deploy con su run terminado (los que no aparecen en ~2 min no corrieron: filtro de paths).
    const waiting = seen.filter((r) => r.status !== 'completed');
    const missing = workflows.filter((w) => !seen.some((r) => r.file === w.file));
    if (!waiting.length && (!missing.length || i >= 8)) return { runs: seen, missing: missing.map((w) => w.file), timedOut: false };
    if (Date.now() > deadline) return { runs: seen, missing: missing.map((w) => w.file), timedOut: true };
    if (i === 0) onNote(`Esperando el deploy: ${workflows.map((w) => w.name ?? w.file).join(', ')}…`);
    await sleep(Math.min(15, 3 + i * 3) * unit);
  }
}

export async function merge(m, { wait = false, minutes = 10, deployMinutes = 20, method, deploy = true, onNote = () => {} } = {}) {
  const unit = Number(process.env.GHOSTY_DEV_WATCH_MS ?? 1000);
  const base0 = api('GET', `${REPO}/pulls/${m}`, undefined, { allowFail: true })?.base?.ref ?? 'main';
  const gateExpected = gateOnBase(base0);
  const deadline = Date.now() + minutes * 60_000;
  let s = readiness(m, gateExpected);
  for (let i = 0; wait && s.r && !s.r.ready && !s.r.failing.length && !s.r.blockers.length && Date.now() < deadline; i++) {
    if (i === 0) onNote(`PR #${m}: esperando ${s.r.pending.join(', ')}…`);
    await sleep(Math.min(30, 3 + i * 3) * unit);
    s = readiness(m, gateExpected);
  }
  if (s.merged) return { pr: m, merged: true, already: true, sha: s.p.merge_commit_sha ?? null, exitCode: 0 };
  if (s.closed) throw new UserError(s.closed.by !== undefined ? closedLine(s.closed) : `El PR #${m} está cerrado sin merge: ¿reabrir? gh pr reopen ${m}`);
  if (!s.r.ready) {
    const onlyPending = !s.r.failing.length && !s.r.blockers.length;
    return { pr: m, merged: false, sha: s.sha, ...s.r, exitCode: onlyPending ? 75 : 1, next: onlyPending ? `ghosty-dev merge ${m} --wait` : null };
  }
  const how = methodFor(method);
  const res = api('PUT', `${REPO}/pulls/${m}/merge`, { sha: s.sha, merge_method: how }, { allowFail: true });
  if (!res?.merged) {
    // Otro commit llegó entre la lectura y el merge, o GitHub exige algo más (aprobación, check requerido).
    const again = readiness(m, gateExpected);
    if (again.sha && again.sha !== s.sha) return { pr: m, merged: false, sha: again.sha, ...again.r, exitCode: 1, note: `llegó el commit ${again.sha.slice(0, 7)} al PR: se revisa otra vez antes del merge` };
    throw new UserError(`GitHub no dejó hacer el merge del PR #${m} (${how}): ¿pide una aprobación o un check requerido? Mira gh pr view ${m}.`);
  }
  // GitHub cierra los issues de «Closes #n», pero las etiquetas de la bitácora se quedaban (#78 de Formmy).
  closingIssueLabels(closingRefs(s.p.body ?? ''));
  const out = { pr: m, merged: true, method: how, sha: res.sha ?? null, base: s.p.base?.ref ?? base0, exitCode: 0 };
  const workflows = deploy ? deployWorkflows(repoTop(), out.base) : [];
  out.deployWorkflows = workflows.map((w) => w.file);
  if (!workflows.length || !out.sha) return out;
  const d = await waitDeploy(out.sha, workflows, { minutes: deployMinutes, unit, onNote });
  out.deploy = d;
  if (d.runs.some((r) => r.status === 'completed' && !OK_CONCLUSIONS.includes(r.conclusion))) out.exitCode = 1;
  else if (d.timedOut) out.exitCode = 75;
  return out;
}

export function mergeText(x) {
  if (x.already) return `El PR #${x.pr} ya tenía merge.`;
  if (!x.merged)
    return [`No hago el merge del PR #${x.pr}${x.sha ? ` (commit ${x.sha.slice(0, 7)})` : ''}${x.note ? `: ${x.note}` : ''}. Falta:`, readinessText(x.pr, x), ...(x.next ? [`Espera y mezcla solo cuando todo resuelva: ${x.next}`] : [])].join('\n');
  const lines = [`Merge del PR #${x.pr} hecho (${x.method}${x.sha ? `, ${x.sha.slice(0, 7)}` : ''}) en ${x.base}.`];
  if (!x.deployWorkflows?.length) lines.push(`  ${x.base} no tiene workflow de deploy en push: no hay deploy que esperar.`);
  else if (x.deploy) {
    for (const r of x.deploy.runs) lines.push(`  deploy ${r.name ?? r.file}: ${r.status !== 'completed' ? 'sigue corriendo' : OK_CONCLUSIONS.includes(r.conclusion) ? 'verde' : `ROJO (${r.conclusion})`}${r.url ? ` · ${r.url}` : ''}`);
    for (const f of x.deploy.missing) lines.push(`  ${f}: no corrió con este commit (¿filtro de paths?)`);
    if (x.exitCode === 1) lines.push(`  El merge entró pero el deploy falló: gh run view ${x.deploy.runs.find((r) => r.status === 'completed' && !OK_CONCLUSIONS.includes(r.conclusion))?.id} --log-failed`);
    if (x.deploy.timedOut) lines.push(`  El deploy sigue corriendo: gh run watch ${x.deploy.runs.find((r) => r.status !== 'completed')?.id ?? ''}`.trimEnd());
  }
  return lines.join('\n');
}
