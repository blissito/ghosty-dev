// El latido de quien escribe (gs: POST /api/v2/me/repos/:owner/:name/prs/:pr/writer): con él la tarjeta del PR en el
// tablero de Desarrollo vuelve a «Escribiendo · Corrigiendo: …» mientras el agente corrige (tomó un pedido o el CI
// salió rojo) y regresa a «En revisión» al empujar (`wait`). Nunca falla ni frena el comando: sin sesión, sin red o
// sin PR, no pasa nada. Sin latido en 10 min, gs lo da por terminado solo.
import { checkRepo, request } from './auth.mjs';
import { prOf, repoFullName } from './commands.mjs';

const TIMEOUT_MS = 3000;
export const STATES = ['working', 'pushed', 'idle'];

// Una línea corta y limpia de lo que se corrige (el texto lo pinta gs en el chip).
export function whatOf(text) {
  const line = String(text ?? '').replace(/<!--[\s\S]*?-->/g, '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').slice(0, 80) || null;
}

export async function beat(n, state, what = null) {
  // Pruebas con el gh falso (o apagado a mano): nada sale a la red.
  if (process.env.GHOSTY_DEV_GH || process.env.GHOSTY_DEV_NO_BEAT) return false;
  try {
    const pr = prOf(n);
    if (!pr) return false;
    const [owner, name] = checkRepo(repoFullName());
    const path = `/api/v2/me/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/prs/${pr.number}/writer`;
    const body = { state, sha: pr.headRefOid, ...(what ? { what: whatOf(what) } : {}) };
    await Promise.race([request('POST', path, body, { scope: 'dev' }), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), TIMEOUT_MS).unref?.())]);
    return true;
  } catch {
    return false;
  }
}

// El acuse de lectura (gs: POST /api/v2/me/repos/:owner/:name/prs/:pr/reader): con él, bajo cada pedido del hilo del PR
// en Ghosty Studio sale «Lo leyó tu agente · 8:22», y si nadie revisa pedidos en 10 min, gs le dice a la persona qué
// pegarle a esta terminal. `seen` = ids de los comentarios leídos (sin ids = «revisé y no había nada», señal de vida);
// `listening` = `wait --watch` escuchando en vivo `minutes` (el pedido le llega al instante). Mismas reglas que `beat`:
// nunca falla ni frena el comando.
export async function ack(n, { pr = null, seen = [], listening, minutes } = {}) {
  if (process.env.GHOSTY_DEV_GH || process.env.GHOSTY_DEV_NO_BEAT) return false;
  try {
    const number = pr ?? prOf(n)?.number;
    if (!number) return false;
    const [owner, name] = checkRepo(repoFullName());
    const path = `/api/v2/me/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/prs/${number}/reader`;
    const body = { seen: seen.filter((x) => Number.isInteger(x)), ...(typeof listening === 'boolean' ? { listening } : {}), ...(minutes ? { minutes } : {}) };
    await Promise.race([request('POST', path, body, { scope: 'dev' }), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), TIMEOUT_MS).unref?.())]);
    return true;
  } catch {
    return false;
  }
}
