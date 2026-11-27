// La nube de ghosty-dev: el mismo pendiente, pero lo construye un agente en una caja de trabajo de tu cuenta de
// Ghosty en vez de tu compu. Habla directo con la API de Ghosty Studio (/api/v2/me/dev-runs) con la sesión propia
// de ghosty-dev (src/auth.mjs, permiso `dev`): no hace falta otro CLI. Todo lo que llega del servidor se trata como
// dato: se valida antes de meterlo en una URL o en un comando de git, y se limpia antes de imprimirlo.
import { git } from './gh.mjs';
import { repoFullName, UserError } from './commands.mjs';
import { AuthError, checkRepo, plain, request } from './auth.mjs';

export class CloudError extends Error {}

const RUNS = '/api/v2/me/dev-runs';
const SCOPE = 'dev';
export const LIVE = new Set(['queued', 'working', 'waiting_ci', 'reviewing', 'needs_person', 'blocked', 'merging']);

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

// Las acciones que manda gs ({id, label, kind, op?, href?, confirm?, destructive?, primary?, disabled?}) son datos:
// se limpian y se descartan las malformadas. null = el servidor no manda `actions` (gs viejo).
export function cleanActions(raw) {
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((a) => a && typeof a === 'object' && /^[a-z_]{1,30}$/.test(String(a.id ?? '')))
    .map((a) => ({
      id: a.id,
      label: text(a.label, 80) ?? a.id,
      kind: ['op', 'link', 'start'].includes(a.kind) ? a.kind : 'op',
      href: typeof a.href === 'string' && /^https:\/\/[^\s]{1,500}$/.test(a.href) ? a.href : null,
      primary: a.primary === true,
      destructive: a.destructive === true,
      disabled: a.disabled && typeof a.disabled === 'object' ? { why: text(a.disabled.why, 200) ?? '' } : null,
    }));
}

/** El comando exacto del CLI equivalente a una acción de gs en #n (PR m si se conoce). null = sin equivalente. Puro. */
export function actionCommand(a, { n, pr = null } = {}) {
  switch (a.id) {
    case 'merge': return pr ? `ghosty-dev merge ${pr}` : 'ghosty-dev merge';
    case 'stop': return `ghosty-dev stop ${n}`;
    case 'resume': return `ghosty-dev tell ${n} --again`;
    case 'decide': return `ghosty-dev tell ${n} "<tu respuesta>"`;
    case 'reopen': return `ghosty-dev reopen ${n}`;
    case 'confirm': return `ghosty-dev confirm ${n} --criterion <i>`;
    case 'start': return `ghosty-dev claim ${n} --cloud`;
    case 'release_claim': return `ghosty-dev unclaim ${n}`;
    case 'unblock': return `ghosty-dev unblock ${n}`;
    case 'edit_criterion': return `ghosty-dev criteria ${n} --set <i> "texto nuevo" --reason "por qué"`;
    case 'handoff_to_terminal': return `ghosty-dev teleport ${n}`;
    case 'box_logs': return pr ? `ghosty-dev box logs ${pr}` : 'ghosty-dev box logs';
    default: return a.href ?? null;
  }
}

/**
 * Un pendiente bloqueado no se manda a la nube: se quita «Mandar a la nube» (start) y, si no está ya, se ofrece
 * «Desbloquear» primero. Puro.
 */
export function actionsWhenBlocked(actions) {
  if (!Array.isArray(actions)) return actions;
  const kept = actions.filter((a) => a.id !== 'start');
  return kept.some((a) => a.id === 'unblock') ? kept : [{ id: 'unblock', label: 'Desbloquear', kind: 'op', href: null, primary: true, destructive: false, disabled: null }, ...kept.map((a) => ({ ...a, primary: false }))];
}

/** Renglones «→ etiqueta: comando» de las acciones de gs (deshabilitadas con su porqué). Puro. */
export function actionLines(actions, ctx, indent = '  ') {
  return (actions ?? []).map((a) => {
    const c = actionCommand(a, ctx);
    const tail = a.disabled ? `no disponible${a.disabled.why ? `: ${a.disabled.why}` : ''}` : c ?? '(sólo en Ghosty Studio)';
    return `${indent}→ ${a.label}${a.primary ? ' *' : ''}: ${tail}`;
  });
}

// Las acciones de la fila de #n en el tablero de gs: la del run vivo (o el más reciente); sin run, la fila `local` o la
// del PR que lo cierra. null si gs no las manda (servidor viejo) o no responde: el CLI usa entonces su respaldo.
export async function actionsFor(n) {
  try {
    const res = await call('GET', `${RUNS}?repo=${encodeURIComponent(repoName())}`);
    const mine = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => r && (Number(r.issue) === n || Number(r.number) === n));
    const runs = mine(res?.runs).sort((a, b) => Number(LIVE.has(b.phase)) - Number(LIVE.has(a.phase)));
    const row = runs.find((r) => Array.isArray(r.actions)) ?? [...mine(res?.local), ...mine(res?.prs)].find((r) => Array.isArray(r.actions));
    return row ? cleanActions(row.actions) : null;
  } catch {
    return null;
  }
}

const view = (r) => ({
  number: number(r.issue),
  title: text(r.title) ?? '',
  cloud: true,
  id: runId(r.id),
  state: text(r.estado ?? r.phase, 80),
  phase: text(r.phase, 40),
  // Por qué se detuvo (factory_paused, person, guard_loop, writer_idle, box_expired, pr_closed, failed:…); null si no.
  stopReason: text(r.stopReason, 120),
  pr: text(r.prUrl),
  url: text(r.issueUrl),
  branch: safeBranch(r.branch),
  already: r.yaEstaba === true,
  // Fábrica en pausa: gs lo deja en fila (202) y arranca solo al reanudar.
  queued: r.enFila === true,
  note: r.error === 'factory_paused' ? text(r.message) : null,
  // Lo que gs dice que se puede hacer con esta fila (servidor viejo: sin `actions`, null).
  actions: cleanActions(r.actions),
  // «Qué sigue y a quién le toca» (`nextStepOf` de gs, la misma línea que la tarjeta web). null en servidores viejos.
  next: nextOf(r.next),
  column: text(r.column, 40),
  // Dormida: la caja está suspendida y nada avanza hasta despertarla (`ghosty-dev wake <n>`).
  sleeping: typeof r.sleepingAt === 'string' && r.sleepingAt.length > 0,
});

// La línea `next` de gs, saneada: sólo texto corto, nada que se ejecute.
function nextOf(n) {
  if (!n || typeof n !== 'object') return null;
  const line = text(n.line, 300);
  const label = text(n.label, 200);
  if (!line && !label) return null;
  return { line: line ?? label, label, owner: text(n.owner, 40), why: text(n.why, 300), failed: n.failed === true };
}

// Manda el pendiente #n a una caja de trabajo. La nube trabaja sobre lo que hay en GitHub, no sobre tu carpeta.
// Con `pr` y sin pendiente: gs adopta el PR (vista previa, revisión y checks) y responde SIN id: no crea pendiente.
export async function start(n, { pr, workspace, reopen, fromBranch } = {}) {
  const repo = repoName();
  const body = { repo };
  if (workspace) body.workspace = workspace;
  if (n) body.issue = n;
  if (pr) body.pr = pr;
  // Un issue cerrado cuyo trabajo nunca entró a main: gs lo reabre y lo retoma (sólo si se pide).
  if (reopen) body.reopen = true;
  // Rama de traspaso: lo que llevabas en tu compu; la caja parte de ahí (gs: `fromBranch`).
  if (fromBranch) body.fromBranch = fromBranch;
  const r = await call('POST', RUNS, body);
  if (r && r.id == null) {
    if (r.prUrl) return { repo, cloud: true, services: true, pr: number(r.pr) ?? pr ?? null, prUrl: text(r.prUrl), note: text(r.nota) };
    throw new CloudError('Ghosty Studio no regresó el pendiente.');
  }
  return view(r);
}

// Antes de gastar (Formmy, fila 32: «miedo a los costos ocultos»): lo que pasaría al mandarlo AHORA, sin hacerlo
// (GET /api/v2/me/dev-runs/capacity?repo=…[&workspace=…]): cajas, si cabe, qué vista previa se desalojaría o si
// queda en fila, la mediana de tiempo y tokens de los últimos pendientes del repo, y dónde comprar más cajas.
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
    lines.push('  Ghosty Studio no dijo cuántas cajas quedan: si el espacio está lleno, puede desalojar la vista previa más vieja.');
    return lines.join('\n');
  }
  const parts = [`Ocupa 1 de ${c.slots ?? '?'} cajas${c.used != null ? ` (${c.used} en uso${c.owner ? ` en ${c.owner}` : ''})` : ''}`];
  if (c.evicts.length) parts.push(`desaloja la preview del ${c.evicts.map((e) => `${e.repo && e.repo !== p.repo ? e.repo : ''}#${e.pr}`).join(', ')}`);
  else if (c.queued) parts.push('queda en fila hasta que se libere una caja');
  else if (c.fits) parts.push('cabe sin desalojar nada');
  if (c.estimate?.minutes != null) parts.push(`suele tardar ~${c.estimate.minutes} min${c.estimate.tokens ? ` y ~${fmtTokens(c.estimate.tokens)} tokens` : ''}${c.estimate.basedOn ? ` (mediana de ${c.estimate.basedOn})` : ''}`);
  lines.push(`  ${parts.join(' · ')}`);
  if (!c.fits && c.buyUrl) lines.push(`  Comprar más cajas: ${c.buyUrl}`);
  return lines.join('\n');
}

// Los pendientes de este repo que van en la nube (vivos y cerrados recientes).
/** Un renglón por pendiente: el que sigue vivo (o, si no hay, el más reciente) y cuántos intentos más tuvo. Puro. */
export function groupByIssue(rows) {
  const by = new Map();
  for (const r of rows) {
    const g = by.get(r.number);
    if (!g) by.set(r.number, { ...r, attempts: 0 });
    else {
      g.attempts += 1;
      if (!LIVE.has(g.phase) && LIVE.has(r.phase)) by.set(r.number, { ...r, attempts: g.attempts });
    }
  }
  return [...by.values()];
}

export async function list() {
  const res = await call('GET', `${RUNS}?repo=${encodeURIComponent(repoName())}`);
  return (Array.isArray(res?.runs) ? res.runs : []).map(view);
}

// Todo el tablero del repo (runs en la nube, pendientes de terminal y PRs) con su «qué sigue»: la vista de `cloud`
// y de la fila. `factory` = la fábrica del repo (encendida, en pausa, horario).
export async function board() {
  const res = await call('GET', `${RUNS}?repo=${encodeURIComponent(repoName())}`);
  const rows = (Array.isArray(res?.runs) ? res.runs : []).map(view);
  const other = (r, kind) => ({
    number: number(r.issue ?? r.number), title: text(r.title) ?? '', kind,
    pr: text(r.prUrl ?? (r.pr && typeof r.pr === 'object' ? r.pr.url : r.url)), next: nextOf(r.next), column: text(r.column, 40),
    notStarted: r.notStarted === true, blocked: r.blocked && typeof r.blocked === 'object' ? { by: number(r.blocked.by) } : null,
    actions: cleanActions(r.actions),
  });
  const local = (Array.isArray(res?.local) ? res.local : []).map((r) => other(r, 'local')).filter((r) => r.number);
  const prs = (Array.isArray(res?.prs) ? res.prs : []).map((r) => ({ ...other(r, 'pr'), prNumber: number(r.pr) }));
  const f = res?.factory && typeof res.factory === 'object' ? { on: res.factory.on !== false, pausedUntil: text(res.factory.pausedUntil, 40), schedule: text(res.factory.schedule, 80) } : null;
  return { runs: rows, local, prs, factory: f };
}

// ¿Por qué no avanza la fila? Qué puede tomar la fábrica ahora y, si nada, la razón y el comando que lo destraba.
// Pura (sin red) para poder probarla.
export function queueOf(b) {
  const live = b.runs.filter((r) => LIVE.has(r.phase));
  const asleep = live.filter((r) => r.sleeping);
  const needYou = [...live, ...b.local, ...b.prs].filter((r) => r.next?.owner === 'person' || r.phase === 'needs_person');
  const ready = b.local.filter((r) => r.notStarted && !r.blocked);
  const waiting = b.local.filter((r) => r.blocked);
  const fixes = [];
  if (b.factory && !b.factory.on) fixes.push({ why: `la fábrica está en pausa${b.factory.pausedUntil ? ` hasta ${b.factory.pausedUntil}` : ''}`, cmd: 'ghosty-dev factory resume' });
  for (const r of asleep) fixes.push({ why: `#${r.number} está dormido`, cmd: `ghosty-dev wake ${r.number}` });
  for (const r of ready) fixes.push({ why: `#${r.number} nadie lo ha empezado`, cmd: `ghosty-dev claim ${r.number} --cloud` });
  for (const r of waiting) {
    const by = r.blocked.by;
    const blocker = by ? [...b.local, ...b.runs].find((x) => x.number === by) : null;
    fixes.push({ why: `#${r.number} espera a #${by ?? '?'}${blocker?.notStarted ? ', que nadie ha empezado' : ''}`, cmd: by && blocker?.notStarted ? `ghosty-dev claim ${by} --cloud` : `ghosty-dev unblock ${r.number}` });
  }
  return { working: live.filter((r) => !r.sleeping && r.phase !== 'needs_person').length, needYou: needYou.map((r) => r.number), fixes };
}

async function liveRun(n) {
  const run = (await list()).find((r) => r.number === n && LIVE.has(r.phase));
  if (!run) throw new CloudError(`#${n} no va en la nube.`);
  return run;
}

const stopRun = async (id) => view(await call('POST', `${RUNS}/${encodeURIComponent(runId(id))}`, { op: 'stop' }));

// Detiene el pendiente #n en la nube y libera su caja. El issue y la rama se quedan.
export async function stop(n) {
  return stopRun((await liveRun(n)).id);
}

// Detiene #n sólo si va en la nube; null si no iba o no hay sesión/red con Ghosty Studio (no estorba).
export async function stopIfLive(n) {
  let live;
  try {
    live = (await list()).find((r) => r.number === n && LIVE.has(r.phase));
  } catch {
    return null;
  }
  return live ? stopRun(live.id) : null;
}

// Trae a tu compu lo que la nube lleva de #n: la detiene (un solo escritor) y deja su rama lista para seguir aquí.
export async function teleport(n) {
  const run = await liveRun(n);
  const stopped = await stopRun(run.id);
  const branch = run.branch || stopped.branch;
  if (branch && git(['fetch', 'origin', '--', `${branch}:${branch}`], { allowFail: true }) === null) git(['fetch', 'origin', '--', branch], { allowFail: true });
  return { ...stopped, branch };
}

// Tomar #n aquí cuando la nube lo lleva: un solo escritor, así que se detiene y se trae su rama (como `teleport`).
// null = no iba en la nube, o no hay sesión/red con Ghosty Studio (entonces no estorba: se toma normal).
export async function takeBack(n) {
  let live;
  try {
    live = (await list()).find((r) => r.number === n && LIVE.has(r.phase));
  } catch {
    return null;
  }
  return live ? teleport(n) : null;
}

// El pendiente #n más reciente en la nube, esté vivo o detenido (el último que se mandó).
async function lastRun(n) {
  const run = (await list()).find((r) => r.number === n);
  if (!run) throw new CloudError(`#${n} no ha ido a la nube.`);
  return run;
}

// Retoma #n si lo detuvieron (o se cerró su PR) y su PR sigue abierto en GitHub: misma rama e issue, caja nueva.
export async function reopen(n) {
  const run = await lastRun(n);
  if (run.phase !== 'stopped') throw new CloudError(`#${n} no está detenido (estado: ${run.state}).`);
  return view(await call('POST', `${RUNS}/${encodeURIComponent(runId(run.id))}`, { op: 'reopen' }));
}

// Suelta «Esperando #N»: #n sigue sin esperar ese PR. No cierra nada.
export async function release(n) {
  const run = await liveRun(n);
  if (run.phase !== 'blocked') throw new CloudError(`#${n} no está esperando otro PR (estado: ${run.state}).`);
  return view(await call('POST', `${RUNS}/${encodeURIComponent(runId(run.id))}`, { op: 'resume' }));
}

// «Recupera lo que se cerró»: los PRs de este repo cerrados sin merge cuya rama sigue viva. Sin `start` sólo los
// lista; con él gs los retoma sobre su misma rama con un PR NUEVO (y reabre su issue).
export async function recover({ start = false, prs } = {}) {
  const body = { repo: repoName(), start };
  if (prs?.length) body.prs = prs;
  const r = await call('POST', `${RUNS}/recover`, body);
  const cands = (Array.isArray(r?.candidatos) ? r.candidatos : []).map((c) => ({ pr: number(c.pr), title: text(c.title) ?? '', branch: safeBranch(c.branch), issue: number(c.issue), url: text(c.url) })).filter((c) => c.pr);
  const done = Array.isArray(r?.retomados) ? r.retomados.map((x) => ({ pr: number(x.pr), ok: x.ok === true, error: text(x.error) })).filter((x) => x.pr) : null;
  return { candidates: cands, started: done };
}

// Despierta la caja de #n (op `wake` de gs, la de «Retomar» en la tarjeta): sale de la suspensión y el escritor sigue.
export async function wake(n) {
  const run = await liveRun(n);
  return { ...view(await call('POST', `${RUNS}/${encodeURIComponent(runId(run.id))}`, { op: 'wake' })), wasSleeping: run.sleeping };
}

// Duerme la caja de #n (op `sleep`): libera RAM sin perder nada; gs no la duerme con un turno vivo.
export async function sleep(n) {
  const run = await liveRun(n);
  return view(await call('POST', `${RUNS}/${encodeURIComponent(runId(run.id))}`, { op: 'sleep' }));
}

// La pregunta pendiente del escritor (campo `asked` del detalle GET /dev-runs/<id>), saneada. Acepta texto suelto o
// {question|text, options[]}; sin pregunta, null. No se inventa nada: lo que gs no mande no se imprime.
export function askedOf(d) {
  const a = d?.asked;
  if (a == null || a === false) return null;
  const q = typeof a === 'string' ? text(a, 2000) : text(a.question ?? a.text ?? a.prompt, 2000);
  if (!q) return null;
  const raw = Array.isArray(a.options) ? a.options : [];
  const options = raw.map((o) => text(typeof o === 'string' ? o : (o?.label ?? o?.text ?? o?.value), 200)).filter(Boolean).slice(0, 12);
  return { question: q, options };
}

// Detalle del pendiente #n si va en la nube (para mostrar lo que pregunta el escritor). Sin red o sin sesión: null.
export async function asked(n) {
  try {
    const run = (await list()).find((r) => r.number === n && LIVE.has(r.phase));
    if (!run) return null;
    return askedOf(await call('GET', `${RUNS}/${encodeURIComponent(runId(run.id))}`));
  } catch {
    return null;
  }
}

// Le habla al escritor de #n en la nube (POST /dev-runs/<id> {op:'tell', note}); `again` = «otra vuelta» ({op:'resume'},
// con la nota si la hay: gs la pasa al escritor igual que en tell). El servidor decide por fase: si preguntó, es la respuesta; si trabaja, un aviso; si está detenido, lo reanuda.
export async function tell(n, { note, again = false } = {}) {
  if (!again && !String(note ?? '').trim()) throw new CloudError('Falta el mensaje: ghosty-dev tell <n> "mensaje" (o --file m.md, o - para leer de stdin).');
  const rows = (await list()).filter((r) => r.number === n);
  const run = rows.find((r) => LIVE.has(r.phase)) ?? rows[0];
  if (!run) throw new CloudError(`#${n} no va en la nube. Mándalo primero: ghosty-dev claim ${n} --cloud`);
  const before = run.phase;
  // Dormida, una nota o «otra vuelta» se quedaba en fila sin avanzar (#77, 26-nov): primero se despierta.
  let woke = false;
  if (run.sleeping && LIVE.has(run.phase)) {
    await call('POST', `${RUNS}/${encodeURIComponent(runId(run.id))}`, { op: 'wake' });
    woke = true;
  }
  const r = view(await call('POST', `${RUNS}/${encodeURIComponent(runId(run.id))}`, again ? { op: 'resume', ...(String(note ?? '').trim() ? { note: String(note) } : {}) } : { op: 'tell', note: String(note) }));
  return { ...r, op: again ? 'resume' : 'tell', before, woke, answered: !again && before === 'needs_person' };
}

export { AuthError };

// «Ya lo verifiqué» con pruebas: sube las capturas y confirma el criterio por la op `confirm` del run de #n (la misma
// que el botón de la tarjeta: comentario en GitHub con las imágenes y puerta otra vez). null = #n no tiene run en gs.
export async function confirmWithImages(n, { criterion, note, images = [] }) {
  const { readFileSync } = await import('node:fs');
  const { basename, extname } = await import('node:path');
  const { uploadFile } = await import('./auth.mjs');
  const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
  const runs = (await list()).filter((r) => r.number === n);
  const run = runs.find((r) => LIVE.has(r.phase)) ?? runs[0] ?? null;
  const attachments = [];
  for (const f of images) {
    const mime = MIME[extname(f).toLowerCase()];
    if (!mime) throw new UserError(`${f}: sólo imágenes (png, jpg, gif, webp).`);
    const up = await uploadFile(basename(f), readFileSync(f), mime);
    attachments.push({ url: up.url, name: up.name ?? basename(f), mime, size: up.size ?? null });
  }
  if (!run) return { run: null, attachments };
  const r = await call('POST', `${RUNS}/${encodeURIComponent(runId(run.id))}`, { op: 'confirm', criterion: Number(criterion), note: note ?? null, attachments });
  return { run: view(r), attachments };
}
