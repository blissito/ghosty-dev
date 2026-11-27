// Repos privados sin GitHub Actions (27-nov, Formmy: GitHub dejó de arrancar jobs por facturación y se apagaron de
// golpe la puerta, la CI y el deploy). Regla: en un repo PRIVADO nada de ghosty-dev usa Actions. La puerta la evalúa
// Ghosty Studio (check-run `ghosty-dev/evidencia` de su app), la CI corre en la caja de la vista previa y el deploy
// sale de `ghosty-dev deploy`. Un repo público sigue exactamente igual que antes.
import { api } from './gh.mjs';
import { checkRepo, cleanMessage, plain, request } from './auth.mjs';

const REPO = 'repos/{owner}/{repo}';
const cache = new Map();

// 'private' | 'public' | null (no se pudo saber: se trata como público, el comportamiento de siempre).
// GHOSTY_DEV_REPO_VISIBILITY=private|public manda (una caja sin gh, `init --files-only`). Se cachea por repo.
export function repoVisibility({ cwd } = {}) {
  const forced = process.env.GHOSTY_DEV_REPO_VISIBILITY;
  if (forced === 'private' || forced === 'public') return forced;
  const key = process.env.GH_REPO || cwd || process.cwd();
  if (cache.has(key)) return cache.get(key);
  const info = api('GET', REPO, undefined, { cwd, allowFail: true });
  const v = !info ? null : info.private === true || info.visibility === 'private' || info.visibility === 'internal' ? 'private' : info.private === false || info.visibility === 'public' ? 'public' : null;
  cache.set(key, v);
  return v;
}

export const isPrivateRepo = (opts) => repoVisibility(opts) === 'private';

// La línea que explica por qué un repo privado no lleva workflows de ghosty-dev.
export const PRIVATE_WHY = 'repo privado: la puerta la evalúa Ghosty Studio, la CI corre en su caja y el deploy sale de `ghosty-dev deploy` (sin GitHub Actions)';

// Los workflows que ghosty-dev escribe en un repo público y que en uno privado sobran (no arrancan si Actions está bloqueado).
export const ACTIONS_WORKFLOWS = ['.github/workflows/evidence-gate.yml', '.github/workflows/ghosty-checks.yml'];

const CONCLUSIONS = new Set(['success', 'failure', 'neutral']);

// La puerta del PR evaluada por Ghosty Studio (POST …/prs/:pr/gate): publica el check-run `ghosty-dev/evidencia`
// y devuelve el veredicto. { conclusion, summary, details }.
export async function gateViaGs(pr, { repo } = {}) {
  const [owner, name] = checkRepo(repo);
  const r = await request('POST', `/api/v2/me/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/prs/${pr}/gate`, {}, { scope: 'dev' });
  const conclusion = CONCLUSIONS.has(r?.conclusion) ? r.conclusion : 'neutral';
  return {
    pr,
    via: 'ghosty-studio',
    conclusion,
    summary: r?.summary ? cleanMessage(r.summary) : null,
    details: Array.isArray(r?.details) ? r.details.filter((d) => typeof d === 'string').slice(0, 30).map((d) => plain(d, 500)) : [],
  };
}

export function gateText(g) {
  if (g.error) return `No pude evaluar la puerta del PR #${g.pr} en Ghosty Studio: ${g.error}`;
  const head = g.conclusion === 'success' ? 'verde' : g.conclusion === 'failure' ? 'ROJA' : 'neutral';
  return [`Puerta ghosty-dev/evidencia del PR #${g.pr} (evaluada por Ghosty Studio): ${head}${g.summary ? ` — ${g.summary}` : ''}`, ...g.details.map((d) => `  - ${d}`)].join('\n');
}
