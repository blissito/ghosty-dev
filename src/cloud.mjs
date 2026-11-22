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
export async function start(n, { pr } = {}) {
  const repo = repoName();
  const body = { repo };
  if (n) body.issue = n;
  if (pr) body.pr = pr;
  const r = await call('POST', RUNS, body);
  if (r && r.id == null) {
    if (r.prUrl) return { repo, cloud: true, services: true, pr: number(r.pr) ?? pr ?? null, prUrl: text(r.prUrl), note: text(r.nota) };
    throw new CloudError('Ghosty Studio no regresó el pendiente.');
  }
  return view(r);
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
