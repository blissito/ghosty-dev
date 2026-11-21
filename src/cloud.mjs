// La nube de ghosty-dev: el mismo pendiente, pero lo construye un agente en una caja de trabajo de tu cuenta de
// Ghosty en vez de tu compu. Aquí no hay sesión ni tokens: todo pasa por el CLI `ghosty` (ghosty login), que ya
// guarda y renueva la sesión. GHOSTY_DEV_GHOSTY cambia el binario (los tests usan uno falso).
import { execFileSync } from 'node:child_process';
import { api, git } from './gh.mjs';

export class CloudError extends Error {}

function ghosty(args) {
  const bin = process.env.GHOSTY_DEV_GHOSTY || 'ghosty';
  try {
    const out = execFileSync(bin, [...args, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.trim() ? JSON.parse(out) : {};
  } catch (e) {
    if (e.code === 'ENOENT') throw new CloudError('La nube necesita el CLI de Ghosty: npm i -g @ghostystudio/cli && ghosty login');
    const detail = (e.stderr || e.message || '').toString().trim().split('\n').slice(-3).join('\n');
    throw new CloudError(`La nube no aceptó el pendiente: ${detail}`);
  }
}

const repoName = () => api('GET', 'repos/{owner}/{repo}').full_name;

const view = (r) => ({ number: r.issue, title: r.title, cloud: true, id: r.id, state: r.estado, phase: r.phase, pr: r.prUrl ?? null, url: r.issueUrl, branch: r.branch ?? null, already: !!r.yaEstaba });

// Manda el pendiente #n a una caja de trabajo. La nube trabaja sobre lo que hay en GitHub, no sobre tu carpeta.
export function start(n) {
  return view(ghosty(['dev', 'run', repoName(), '--issue', String(n)]));
}

// Los pendientes de este repo que van en la nube (vivos y cerrados recientes).
export function list() {
  const res = ghosty(['dev', 'ls', repoName()]);
  return (Array.isArray(res) ? res : res.runs || []).map(view);
}

const LIVE = new Set(['queued', 'working', 'waiting_ci', 'reviewing', 'needs_person', 'merging']);

function liveRun(n) {
  const run = list().find((r) => r.number === n && LIVE.has(r.phase));
  if (!run) throw new CloudError(`#${n} no va en la nube.`);
  return run;
}

// Detiene el pendiente #n en la nube y libera su lugar. El issue y la rama se quedan.
export function stop(n) {
  return view(ghosty(['dev', 'stop', liveRun(n).id]));
}

// Trae a tu compu lo que la nube lleva de #n: la detiene (un solo escritor) y deja su rama lista para seguir aquí.
export function teleport(n) {
  const run = liveRun(n);
  const stopped = view(ghosty(['dev', 'stop', run.id]));
  const branch = run.branch || stopped.branch;
  if (branch && git(['fetch', 'origin', `${branch}:${branch}`], { allowFail: true }) === null) git(['fetch', 'origin', branch], { allowFail: true });
  return { ...stopped, branch };
}
