// `wait --pr <n> --until preview|ci|review|any`: espera por PR, sin pendiente ni run (SPEC §5c). Una sola llamada
// bloqueante del CLI que sondea con backoff (el agente no gasta tokens) y avisa en cuanto algo cambia.
// - preview: la vista previa del commit HEAD del PR queda lista o falla (de Ghosty Studio si hay sesión; si no, del
//   check «Ghosty · Preview» de GitHub);
// - ci: el CI del commit HEAD resuelve verde o rojo (sin los checks de la plataforma, §5c);
// - review: Ghosty Review termina sobre el commit HEAD;
// - any: el primer cambio de cualquiera de los tres (o de inmediato, si los tres ya terminaron).
// Nunca lleva la liga de la vista previa: sólo fase y commit.
import { existingSession, plain } from './auth.mjs';
import { api } from './gh.mjs';
import { UserError, prServices } from './commands.mjs';
import { fetchPreview } from './preview.mjs';

export const UNTIL = ['preview', 'ci', 'review', 'any'];
export const WAIT_PENDING_EXIT = 75;
const FROM_CHECK = { listo: 'ready', fallo: 'failed', neutral: 'failed', pendiente: 'building', 'sin-check': 'none' };

async function readState(pr, useGs) {
  const p = api('GET', `repos/{owner}/{repo}/pulls/${pr}`, undefined, { allowFail: true });
  if (!p?.number) throw new UserError(`No encontré el PR #${pr} en este repo.`);
  const head = p.head?.sha;
  const sv = prServices({ number: p.number, headRefOid: head });
  let preview = { phase: FROM_CHECK[sv.preview.status] ?? 'none', sha: head, source: 'github' };
  if (useGs) {
    try {
      const g = await fetchPreview(pr);
      // Una vista previa de un commit viejo todavía no es la de este push.
      const current = !g.sha || head?.startsWith(g.sha) || g.sha.startsWith(head ?? '');
      preview = { phase: current ? g.phase : 'building', sha: g.sha, source: 'ghosty' };
    } catch {}
  }
  return {
    pr: p.number,
    state: p.merged_at ? 'mezclado' : p.state === 'open' ? 'abierto' : 'cerrado',
    sha: head,
    preview,
    ci: sv.ci,
    review: { status: sv.review.status, title: sv.review.title == null ? null : plain(sv.review.title, 200) },
    smoke: { status: sv.smoke.status, title: sv.smoke.title == null ? null : plain(sv.smoke.title, 200) },
    previewCheck: sv.preview.status,
  };
}

// Checks de la plataforma que se quedaron «en curso» con la vista previa ya lista (Formmy #81, fricción 19): el CI no
// resuelve por ellos y `wait --until ci` se acababa el tiempo sin decir por qué. Ghosty Studio los cierra o los corre
// solo (reconciliador de huérfanos, ≤ ~15 min); para no esperar, se rearma la caja.
export function stuckChecks(s) {
  if (s.preview.phase !== 'ready') return null;
  const names = [];
  if (s.previewCheck === 'pendiente') names.push('Ghosty · Preview');
  if (s.smoke.status === 'pendiente') names.push('Ghosty · Smoke');
  if (!names.length) return null;
  return {
    checks: names,
    hint: `${names.map((n) => `«${n}»`).join(' y ')} sigue${names.length > 1 ? 'n' : ''} en curso con la vista previa lista: Ghosty Studio lo${names.length > 1 ? 's' : ''} termina solo en unos minutos; para no esperar, pulsa «Reintentar» en el check o corre ghosty-dev box rebuild ${s.pr}.`,
  };
}

const done = {
  preview: (s) => s.preview.phase === 'ready' || s.preview.phase === 'failed',
  ci: (s) => s.ci === 'verde' || s.ci === 'rojo',
  review: (s) => s.review.status !== 'pendiente' && s.review.status !== 'sin-check',
};
const failed = { preview: (s) => s.preview.phase === 'failed', ci: (s) => s.ci === 'rojo', review: () => false };
const sig = (s) => JSON.stringify([s.sha, s.state, s.preview.phase, s.ci, s.review.status, s.smoke.status]);

// `onChange(state)` recibe el estado inicial y cada cambio. Regresa el estado final con `met`, `timedOut` y `exitCode`
// (0 cumplido, 1 la vista previa falló o el CI salió rojo, 75 se acabó el tiempo).
// GHOSTY_DEV_WATCH_MS cambia la unidad del backoff (los tests la bajan a 0).
export async function waitPr(pr, { until = 'any', minutes = 10, onChange = () => {} } = {}) {
  if (!UNTIL.includes(until)) throw new UserError(`--until va con ${UNTIL.join('|')}.`);
  const useGs = Boolean(await existingSession().catch(() => null));
  const unit = Number(process.env.GHOSTY_DEV_WATCH_MS ?? 1000);
  const deadline = Date.now() + minutes * 60_000;
  let s = await readState(pr, useGs);
  onChange(s);
  const first = sig(s);
  const allDone = (x) => done.preview(x) && done.ci(x) && done.review(x);
  const met = (x) => (until === 'any' ? sig(x) !== first || allDone(x) : done[until](x)) || x.state !== 'abierto';
  const steps = [3, 5, 8, 13, 21, 30];
  let last = first;
  for (let i = 0; !met(s); i++) {
    const delay = steps[Math.min(i, steps.length - 1)] * unit;
    if (Date.now() + delay > deadline) return { ...s, until, met: false, timedOut: true, exitCode: WAIT_PENDING_EXIT, stuck: stuckChecks(s) };
    await new Promise((r) => setTimeout(r, delay));
    s = await readState(pr, useGs);
    if (sig(s) !== last) {
      last = sig(s);
      onChange(s);
    }
  }
  const bad = until === 'any' ? failed.preview(s) || failed.ci(s) : failed[until](s);
  return { ...s, until, met: true, timedOut: false, exitCode: bad ? 1 : 0 };
}
