// La fábrica del repo (gs, 22-nov: «Pausar la fábrica»). La persona la pausa, la reanuda o le pone horario desde
// /c/dev o con `ghosty-dev factory`; `next`, `claim` y `asks` la consultan ANTES de tomar trabajo y, en pausa, se
// detienen con `FACTORY_PAUSED_EXIT` y la línea de gs («Fábrica en pausa hasta las 8:00»). Sin sesión de Ghosty
// Studio o sin red no se sabe: se sigue como siempre (la fábrica sólo existe para quien la usa).
import { existingSession, request } from './auth.mjs';
import { UserError, repoFullName } from './commands.mjs';

/** Código de salida de «la fábrica está en pausa»: distinto de 1 (error) y de 75 (sigue pendiente). */
export const FACTORY_PAUSED_EXIT = 6;
export const PRESETS = ['day', 'night', 'weekdays'];

const pathOf = (repo, all) => {
  const [o, n] = String(repo).split('/');
  return `/api/v2/me/repos/${encodeURIComponent(o)}/${encodeURIComponent(n)}/factory${all ? '?all=1' : ''}`;
};

export class FactoryPaused extends UserError {
  constructor(state) {
    super(`${state.line}. No tomes trabajo nuevo; termina lo que traes y detente.\n  La persona la reanuda en /c/dev o con: ghosty-dev factory resume`);
    this.state = state;
    this.exitCode = FACTORY_PAUSED_EXIT;
  }
}

export async function status({ all = false, repo } = {}) {
  return request('GET', pathOf(repo ?? repoFullName(), all), undefined, { scope: 'dev' });
}

/** `pause [--until ISO] [--reason "…"]`, `resume`, `schedule <day|night|weekdays|"cron">`. */
export async function set(action, { until, reason, schedule, timezone, all = false, repo } = {}) {
  const body = { action, ...(all ? { all: true } : {}) };
  if (action === 'pause') {
    if (until) {
      const at = new Date(until);
      if (Number.isNaN(+at)) throw new UserError(`--until no es una fecha: ${until} (ISO, p. ej. 2026-11-23T08:00:00-06:00)`);
      body.until = at.toISOString();
    }
    if (reason) body.reason = reason;
  } else if (action === 'schedule') {
    if (!schedule) throw new UserError(`Uso: ghosty-dev factory schedule <${PRESETS.join('|')}|"cron de 5 campos con las horas en que SÍ trabaja">`);
    if (PRESETS.includes(schedule)) body.preset = schedule;
    else body.schedule = schedule;
    if (timezone) body.timezone = timezone;
  } else if (action !== 'resume') {
    throw new UserError('Uso: ghosty-dev factory status | pause [--until ISO] [--reason "…"] | resume | schedule <day|night|weekdays|"cron"> [--all]');
  }
  return request('POST', pathOf(repo ?? repoFullName(), all), body, { scope: 'dev' });
}

/**
 * Antes de tomar trabajo: en pausa lanza `FactoryPaused`. Sin sesión, sin red o con GHOSTY_DEV_NO_NET no estorba
 * (devuelve null). `GHOSTY_DEV_IGNORE_FACTORY=1` la salta (la persona lo pidió explícito).
 */
export async function guard() {
  if (process.env.GHOSTY_DEV_NO_NET || process.env.GHOSTY_DEV_IGNORE_FACTORY === '1') return null;
  if (!process.env.GHOSTY_DEV_TOKEN && !(await existingSession().catch(() => null))) return null;
  let s;
  try {
    s = await status();
  } catch {
    return null;
  }
  if (s && s.active === false) throw new FactoryPaused(s);
  return s;
}

export function statusText(x) {
  const lines = [`${x.repo === '*' ? 'Todos tus repos' : x.repo}: ${x.line}`];
  if (x.mode === 'scheduled' && x.schedule) lines.push(`  horario: ${x.schedule} (${x.timezone})`);
  if (x.queued) lines.push(`  en fila: ${x.queued}`);
  if (x.active === false) lines.push('  Reanudar: ghosty-dev factory resume');
  return lines.join('\n');
}
