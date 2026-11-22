// La nube de ghosty-dev: el mismo pendiente, pero lo construye un agente en una caja de trabajo de tu cuenta de
// Ghosty en vez de tu compu. Habla directo con la API de Ghosty Studio (/api/v2/me/dev-runs) con la sesión propia
// de ghosty-dev (src/auth.mjs, permiso `dev`): no hace falta otro CLI. Todo lo que llega del servidor se trata como
// dato: se valida antes de meterlo en una URL o en un comando de git, y se limpia antes de imprimirlo.
import { git } from './gh.mjs';
import { repoFullName } from './commands.mjs';
import { AuthError, checkRepo, plain, request } from './auth.mjs';

export class CloudError extends Error {}

const RUNS = '/api/v2/me/dev-runs';
const SCOPE = 'dev';
const LIVE = new Set(['queued', 'working', 'waiting_ci', 'reviewing', 'needs_person', 'merging']);

const call = (method, path, body) => request(method, path, body, { scope: SCOPE });

function repoName() {
  const repo = repoFullName();
  checkRepo(repo);
  return repo;
}

const runId = (id) => {
  const s = String(id ?? '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw new CloudError('Ghosty Studio regresó un pendiente con un id inválido.');
  return s;
};

// Una rama que viene del servidor nunca llega cruda a git: nada que parezca opción (--upload-pack=…), ni `..`.
export function safeBranch(b) {
  if (b == null || b === '') return null;
  const s = String(b);
  if (s.length > 200 || s.startsWith('-') || s.includes('..') || s.endsWith('.lock') || s.endsWith('/') || !/^[A-Za-z0-9._/-]+$/.test(s)) return null;
  return s;
}

const text = (v, max = 500) => (v == null ? null : plain(v, max));
const number = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

const view = (r) => ({
  number: number(r.issue),
  title: text(r.title) ?? '',
  cloud: true,
  id: runId(r.id),
  state: text(r.estado ?? r.phase, 80),
  phase: text(r.phase, 40),
  pr: text(r.prUrl),
  url: text(r.issueUrl),
  branch: safeBranch(r.branch),
  already: r.yaEstaba === true,
});

// Manda el pendiente #n a una caja de trabajo. La nube trabaja sobre lo que hay en GitHub, no sobre tu carpeta.
// Con `pr` y sin pendiente: gs adopta el PR (vista previa, revisión y checks) y responde SIN id: no crea pendiente.
export async function start(n, { pr, workspace } = {}) {
  const repo = repoName();
  const body = { repo };
  if (workspace) body.workspace = workspace;
  if (n) body.issue = n;
  if (pr) body.pr = pr;
  const r = await call('POST', RUNS, body);
  if (r && r.id == null) {
    if (r.prUrl) return { repo, cloud: true, services: true, pr: number(r.pr) ?? pr ?? null, prUrl: text(r.prUrl), note: text(r.nota) };
    throw new CloudError('Ghosty Studio no regresó el pendiente.');
  }
  return view(r);
}

// Antes de gastar (Formmy, fila 32: «miedo a los costos ocultos»): lo que pasaría al mandarlo AHORA, sin hacerlo
// (GET /api/v2/me/dev-runs/capacity?repo=…[&workspace=…]): lugares, si cabe, qué vista previa se desalojaría o si
// queda en fila, la mediana de tiempo y tokens de los últimos pendientes del repo, y dónde comprar más lugares.
// Si el repo está en varios espacios, gs responde 409 choose_workspace con las opciones: se piden con --workspace.
const slugOf = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v) ? v : null);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

export async function preflight({ n, pr, workspace } = {}) {
  const repo = repoName();
  const ws = workspace ? slugOf(workspace) : null;
  if (workspace && !ws) throw new CloudError('--workspace va con el slug o el id del espacio.');
  const q = `?repo=${encodeURIComponent(repo)}${ws ? `&workspace=${encodeURIComponent(ws)}` : ''}`;
  const board = await call('GET', `${RUNS}?repo=${encodeURIComponent(repo)}`);
  const live = (Array.isArray(board?.runs) ? board.runs : []).map(view).filter((r) => LIVE.has(r.phase));
  let capacity = null;
  try {
    const c = await call('GET', `${RUNS}/capacity${q}`);
    const est = c?.estimate && typeof c.estimate === 'object' ? c.estimate : null;
    capacity = {
      owner: c?.owner != null ? text(c.owner, 200) : null,
      slots: count(c?.slots),
      used: count(c?.used),
      fits: c?.fits === true,
      queued: c?.queued === true,
      evicts: Array.isArray(c?.evicts) ? c.evicts.map((e) => ({ repo: text(e?.repo, 200), pr: number(e?.pr) })).filter((e) => e.pr) : [],
      estimate: est ? { minutes: count(est.minutes), tokens: count(est.tokens), basedOn: count(est.basedOn) } : null,
      buyUrl: typeof c?.buyUrl === 'string' && /^https:\/\/[^\s]+$/.test(c.buyUrl) ? text(c.buyUrl, 300) : null,
    };
  } catch (e) {
    if (e?.code === 'choose_workspace') {
      const choices = (Array.isArray(e.data?.choices) ? e.data.choices : []).map((c) => ({ slug: slugOf(c?.slug) ?? slugOf(c?.id), name: text(c?.name, 100) })).filter((c) => c.slug);
      throw new CloudError(`${repo} está conectado en varios espacios: di con cuál va con --workspace <slug>${choices.length ? ` (${choices.map((c) => `${c.slug}${c.name ? ` «${c.name}»` : ''}`).join(', ')})` : ''}.`);
    }
    // Sin sesión o sin permiso es error; si gs no tiene la ruta o falla, se sigue sin esos datos (y se dice).
    if (!(e instanceof AuthError) || e.status === 401 || e.status === 403 || e.status === undefined) throw e;
  }
  return { repo, workspace: ws, issue: n ?? null, pr: pr ?? null, live: live.map((r) => ({ number: r.number, state: r.state })), capacity };
}

const fmtTokens = (t) => (t >= 1_000_000 ? `${(t / 1_000_000).toFixed(1)}M` : t >= 1000 ? `${Math.round(t / 1000)}k` : String(t));

export function preflightText(p) {
  const what = p.issue ? `mandar #${p.issue} a la nube (un agente de tu plan lo construye y gasta tokens mientras trabaja)` : `darle servicios al PR #${p.pr} (vista previa, revisión y smoke en cada push)`;
  const lines = [`Vas a ${what} en ${p.repo}.`];
  lines.push(`  en la nube ahora: ${p.live.length ? p.live.map((r) => `#${r.number} (${r.state})`).join(', ') : 'nada'}`);
  const c = p.capacity;
  if (!c) {
    lines.push('  Ghosty Studio no dijo cuántos lugares quedan: si el espacio está lleno, puede desalojar la vista previa más vieja.');
    return lines.join('\n');
  }
  const parts = [`Ocupa 1 de ${c.slots ?? '?'} lugares${c.used != null ? ` (${c.used} en uso${c.owner ? ` en ${c.owner}` : ''})` : ''}`];
  if (c.evicts.length) parts.push(`desaloja la preview del ${c.evicts.map((e) => `${e.repo && e.repo !== p.repo ? e.repo : ''}#${e.pr}`).join(', ')}`);
  else if (c.queued) parts.push('queda en fila hasta que se libere un lugar');
  else if (c.fits) parts.push('cabe sin desalojar nada');
  if (c.estimate?.minutes != null) parts.push(`suele tardar ~${c.estimate.minutes} min${c.estimate.tokens ? ` y ~${fmtTokens(c.estimate.tokens)} tokens` : ''}${c.estimate.basedOn ? ` (mediana de ${c.estimate.basedOn})` : ''}`);
  lines.push(`  ${parts.join(' · ')}`);
  if (!c.fits && c.buyUrl) lines.push(`  Comprar más lugares: ${c.buyUrl}`);
  return lines.join('\n');
}

// Los pendientes de este repo que van en la nube (vivos y cerrados recientes).
export async function list() {
  const res = await call('GET', `${RUNS}?repo=${encodeURIComponent(repoName())}`);
  return (Array.isArray(res?.runs) ? res.runs : []).map(view);
}

async function liveRun(n) {
  const run = (await list()).find((r) => r.number === n && LIVE.has(r.phase));
  if (!run) throw new CloudError(`#${n} no va en la nube.`);
  return run;
}

const stopRun = async (id) => view(await call('POST', `${RUNS}/${encodeURIComponent(runId(id))}`, { op: 'stop' }));

// Detiene el pendiente #n en la nube y libera su lugar. El issue y la rama se quedan.
export async function stop(n) {
  return stopRun((await liveRun(n)).id);
}

// Trae a tu compu lo que la nube lleva de #n: la detiene (un solo escritor) y deja su rama lista para seguir aquí.
export async function teleport(n) {
  const run = await liveRun(n);
  const stopped = await stopRun(run.id);
  const branch = run.branch || stopped.branch;
  if (branch && git(['fetch', 'origin', '--', `${branch}:${branch}`], { allowFail: true }) === null) git(['fetch', 'origin', '--', branch], { allowFail: true });
  return { ...stopped, branch };
}

export { AuthError };
