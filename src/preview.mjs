// La vista previa de un PR (SPEC §5c): es del PR, no de un pendiente ni de un run de la nube. Ghosty Studio la arma
// sola en cada push de un PR no borrador; aquí sólo se pregunta por ella con la sesión de ghosty-dev
// (GET /api/v2/me/repos/:owner/:name/prs/:pr/preview).
//
// La liga (`url`) va FIRMADA y lleva la llave de la vista previa: es el resultado del comando y sólo sale por stdout
// cuando la piden. Nunca entra en un mensaje de error, en stderr ni en lo que imprime `show`. SECURITY.md.
import { api, git } from './gh.mjs';
import { AuthError, checkRepo, cleanMessage, plain, request } from './auth.mjs';
import { UserError, openPrs, repoFullName } from './commands.mjs';

export const PREVIEW_PENDING_EXIT = 75; // EX_TEMPFAIL: todavía se está armando, vuelve a preguntar
const FINAL = new Set(['ready', 'failed']);
const PHASES = new Set(['none', 'queued', 'building', 'ready', 'failed']);

const previewPath = (repo, pr) => {
  const [owner, name] = checkRepo(repo);
  return `/api/v2/me/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/prs/${pr}/preview`;
};

const sha = (v) => (typeof v === 'string' && /^[0-9a-f]{7,64}$/i.test(v) ? v.toLowerCase() : null);

// Sólo una liga https bien formada; cualquier otra cosa se descarta (no se imprime ni se abre).
function signedUrl(v) {
  if (typeof v !== 'string' || v.length > 2000 || /[\s\u0000-\u001f\u007f]/.test(v)) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

// Lo que se puede enseñar en cualquier lado (show, avisos): fase y commit, nunca la liga.
export const publicPreview = (p) => (p ? { phase: p.phase, sha: p.sha } : null);

// Una lectura de la vista previa del PR. La liga sólo viene con `ready`.
export async function fetchPreview(pr, { repo = repoFullName() } = {}) {
  const r = await request('GET', previewPath(repo, pr), undefined, { scope: 'dev' });
  const phase = PHASES.has(r?.phase) ? r.phase : plain(r?.phase ?? 'none', 40);
  const url = phase === 'ready' ? signedUrl(r?.url) : null;
  const error = r?.error ? cleanMessage(r.error, url ? [url, new URL(url).search] : []) : null;
  return {
    repo: r?.repo != null ? plain(r.repo, 200) : repo,
    pr,
    phase,
    sha: sha(r?.sha),
    url,
    page: signedUrl(r?.page) && !new URL(r.page).search ? r.page : null,
    error,
    message: r?.message ? cleanMessage(r.message) : null,
    // OAuth que vio la caja (proveedores, si ya se registró, llaves faltantes): sin secretos; lo valida doctor.
    oauth: r?.oauth && typeof r.oauth === 'object' ? r.oauth : null,
  };
}

// El PR abierto de la rama actual. Por REST (como todo el CLI, SPEC: nada de GraphQL), comparando la rama de cada PR.
export function currentPr() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })?.trim();
  if (!branch || branch === 'HEAD') throw new UserError('No estás en una rama: di el número del PR (ghosty-dev preview <pr>).');
  const pr = openPrs().find((p) => p.headRefName === branch);
  if (!pr) throw new UserError(`La rama ${plain(branch, 200)} no tiene un PR abierto. Ábrelo y haz push, o di el número: ghosty-dev preview <pr>.`);
  return pr.number;
}

// El commit HEAD del PR según GitHub (lo empujado) y el HEAD local, para avisar si la vista previa es de otro commit.
// El HEAD local sólo cuenta si estás en la rama del PR (desde main u otra rama no hay nada que empujar).
function heads(pr) {
  const p = api('GET', `repos/{owner}/{repo}/pulls/${pr}`, undefined, { allowFail: true });
  const remote = sha(p?.head?.sha);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })?.trim();
  const local = p?.head?.ref && branch === p.head.ref ? sha(git(['rev-parse', 'HEAD'], { allowFail: true })?.trim()) : null;
  return { remote, local };
}

// Avisos (para stderr): nunca llevan la liga.
export function staleNotes(p, { remote, local }) {
  const notes = [];
  const short = (s) => s.slice(0, 7);
  if (local && remote && local !== remote) notes.push(`Tu HEAD local (${short(local)}) no es el del PR en GitHub (${short(remote)}): ¿falta git push?`);
  const target = remote ?? local;
  if (p.sha && target && p.sha !== target && !target.startsWith(p.sha))
    notes.push(`La vista previa es del commit ${short(p.sha)}, no de ${short(target)}${FINAL.has(p.phase) ? ': la del último push todavía no empieza.' : '.'}`);
  return notes;
}

// Con `wait`: sondea con backoff (3 s, 5 s, 8 s… tope 30 s) hasta `ready` o `failed` del commit empujado, o ~10 min.
// GHOSTY_DEV_PREVIEW_POLL_MS cambia la unidad (los tests la bajan) y GHOSTY_DEV_PREVIEW_MAX_MS el tope.
export async function preview(prArg, { wait = false, onNote = () => {} } = {}) {
  const pr = prArg ?? currentPr();
  const repo = repoFullName();
  checkRepo(repo);
  const unit = Number(process.env.GHOSTY_DEV_PREVIEW_POLL_MS ?? 1000);
  const until = Date.now() + Number(process.env.GHOSTY_DEV_PREVIEW_MAX_MS ?? 10 * 60_000);
  let h = heads(pr);
  let p = await fetchPreview(pr, { repo });
  // Mientras se espera, una vista previa terminada de un commit viejo no cuenta: el push nuevo la vuelve a armar.
  const current = (x) => !h.remote || !x.sha || h.remote.startsWith(x.sha) || x.sha.startsWith(h.remote);
  const steps = [3, 5, 8, 13, 21, 30];
  for (let i = 0; wait && !(FINAL.has(p.phase) && current(p)); i++) {
    const delay = steps[Math.min(i, steps.length - 1)] * unit;
    if (Date.now() + delay > until) break;
    await new Promise((r) => setTimeout(r, delay));
    p = await fetchPreview(pr, { repo });
    if (!FINAL.has(p.phase) && i % 4 === 3) h = heads(pr); // un push nuevo mientras se espera
  }
  const notes = staleNotes(p, h);
  for (const n of notes) onNote(n);
  return { ...p, head: h.local, prHead: h.remote, stale: notes.length > 0 };
}

export const exitCodeOf = (p) => (p.phase === 'ready' ? 0 : p.phase === 'failed' ? 1 : PREVIEW_PENDING_EXIT);

export { AuthError };
