// Compartir la vista previa de un PR con alguien sin cuenta (SPEC §5d): una liga pública revocable
// (`https://www.ghosty.studio/pv/<token>`) y las solicitudes de acceso de quien la abrió después de revocarla.
// API: /api/v2/me/repos/:owner/:name/prs/:pr/share (GET/POST/DELETE) y …/access-requests (GET/POST), con la sesión de
// ghosty-dev (permiso `dev`; nunca el `gat_` de un agente).
// La liga es una llave: sólo la imprime `preview share` (stdout). `unshare`, `requests` y los errores nunca la llevan.
import { checkRepo, plain, request } from './auth.mjs';
import { UserError, repoFullName } from './commands.mjs';
import { cleanOutput } from './box.mjs';

// Texto ajeno de una línea (nombre o correo que escribió quien pidió acceso): sin secuencias ANSI ni controles.
const line = (v, max) => plain(cleanOutput(v, max), max);

export const SHARE_OPS = ['share', 'unshare', 'requests', 'accept', 'reject'];
const STATUSES = ['pending', 'accepted', 'rejected', 'all'];

const base = (repo, pr) => {
  const [owner, name] = checkRepo(repo);
  return `/api/v2/me/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/prs/${pr}`;
};

// Sólo una liga https sin credenciales ni espacios; cualquier otra cosa no se imprime.
function shareUrl(v) {
  if (typeof v !== 'string' || v.length > 2000 || /[\s\u0000-\u001f\u007f]/.test(v)) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}
const when = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const idOf = (v) => (typeof v === 'string' && /^[\w-]{1,100}$/.test(v) ? v : null);

const shareView = (repo, pr, r, { withUrl }) => ({
  repo,
  pr,
  shared: r?.shared === true,
  ...(withUrl ? { url: r?.shared === true ? shareUrl(r?.url) : null } : {}),
  createdAt: when(r?.createdAt),
  lastUsedAt: when(r?.lastUsedAt),
});

const requestView = (q) => ({
  id: idOf(q?.id),
  email: q?.email != null ? line(q.email, 200) : null,
  name: q?.name != null ? line(q.name, 100) : null,
  status: STATUSES.includes(q?.status) ? q.status : plain(q?.status ?? '', 20),
  createdAt: when(q?.createdAt),
  resolvedAt: when(q?.resolvedAt),
});

// share: crea (o devuelve la misma, es idempotente) la liga pública. unshare: la revoca (la vieja da 410).
export async function share(op, pr, { repo = repoFullName() } = {}) {
  const path = `${base(repo, pr)}/share`;
  if (op === 'share') return { op, ...shareView(repo, pr, await request('POST', path, {}, { scope: 'dev' }), { withUrl: true }) };
  const r = await request('DELETE', path, undefined, { scope: 'dev' });
  return { op, ...shareView(repo, pr, { ...r, shared: false }, { withUrl: false }) };
}

export async function requests(pr, { status = 'pending', repo = repoFullName() } = {}) {
  if (!STATUSES.includes(status)) throw new UserError(`--status va con ${STATUSES.join('|')}.`);
  const r = await request('GET', `${base(repo, pr)}/access-requests?status=${status}`, undefined, { scope: 'dev' });
  return { repo, pr, status, requests: (Array.isArray(r?.requests) ? r.requests : []).map(requestView).filter((q) => q.id) };
}

export async function decide(decision, pr, id, { repo = repoFullName() } = {}) {
  if (!idOf(id)) throw new UserError(`Uso: ghosty-dev preview ${decision === 'accept' ? 'accept' : 'reject'} <id> [--pr <m>] (el id sale de preview requests).`);
  const r = await request('POST', `${base(repo, pr)}/access-requests`, { id, decision }, { scope: 'dev' });
  return { repo, pr, decision, request: requestView(r?.request) };
}

export function shareText(x) {
  if (x.op === 'unshare') return `Liga pública del PR #${x.pr} revocada: quien la abra verá que ya no sirve y podrá pedir acceso (ghosty-dev preview requests ${x.pr}).`;
  if (!x.url) return `Ghosty Studio no devolvió una liga válida para el PR #${x.pr}.`;
  return `${x.url}\n  Cualquiera con esta liga ve la vista previa del PR #${x.pr} sin cuenta. Revócala: ghosty-dev preview unshare ${x.pr}`;
}

export function requestsText(x) {
  if (!x.requests.length) return `PR #${x.pr}: sin solicitudes de acceso${x.status === 'all' ? '' : ` (${x.status})`}.`;
  return [`PR #${x.pr}, solicitudes de acceso (${x.status}):`, ...x.requests.map((q) => `  ${q.id}  ${q.name ? `${q.name} ` : ''}<${q.email ?? '?'}>  ${q.status}${q.createdAt ? ` · ${q.createdAt.slice(0, 16).replace('T', ' ')}` : ''}`)]
    .concat(x.requests.some((q) => q.status === 'pending') ? [`Decide: ghosty-dev preview accept <id> --pr ${x.pr} · ghosty-dev preview reject <id> --pr ${x.pr}`] : [])
    .join('\n');
}

export const decideText = (x) => `${x.decision === 'accept' ? 'Aceptada' : 'Rechazada'} la solicitud ${x.request.id ?? ''} de ${x.request.email ?? '?'} (PR #${x.pr}).`;

