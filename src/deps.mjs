// «Depende de #N» en la descripción del PR (PRs apilados, como Graphite o ghstack): ghosty-dev la escribe sola cuando
// la base del PR es la rama de otro PR abierto, o cuando el PR trae encima el commit de otro PR abierto (se armó sobre
// él sin mezclar). Ghosty Studio la lee (`prDependsOn`) para ordenar el tablero. Las líneas que escribe ghosty-dev
// llevan la marca DEPS_MARK; sólo ésas se quitan, cuando el PR del que dependía ya entró (o dejó de ser su base).
// Lo que escribió una persona no se toca ni se duplica.
import { api, apiAll } from './gh.mjs';

const REPO = 'repos/{owner}/{repo}';
export const DEPS_MARK = '<!-- ghosty-dev:depende -->';
// Las mismas formas que reconoce Ghosty Studio (app/lib/pr-services/board.ts, prDependsOn).
const DEPENDS = /\b(?:depende(?:\s+de)?|despu[eé]s\s+de|espera(?:\s+a)?|bloqueado\s+por|depends\s+on|after|blocked\s+by|stacked\s+on)\s*:?\s*#(\d+)/gi;

export function dependsOn(body = '', self) {
  const out = new Set();
  for (const m of String(body ?? '').matchAll(DEPENDS)) if (Number(m[1]) !== self) out.add(Number(m[1]));
  return [...out];
}

// Puro: quita las líneas marcadas cuyo #N ya no aplica y agrega las que faltan (sin duplicar lo que ya dice el cuerpo).
export function syncDepsLines(body, wanted) {
  const removed = [];
  let kept = String(body ?? '')
    .split('\n')
    .filter((line) => {
      if (!line.includes(DEPS_MARK)) return true;
      const n = dependsOn(line)[0];
      if (n !== undefined && wanted.includes(n)) return true;
      if (n !== undefined) removed.push(n);
      return false;
    })
    .join('\n');
  if (removed.length) kept = kept.replace(/\n{2,}$/, '\n'); // sin renglones vacíos donde estaba la línea
  const have = dependsOn(kept);
  const added = wanted.filter((n) => !have.includes(n));
  const next = added.length ? `${kept.replace(/\s+$/, '')}${kept.trim() ? '\n\n' : ''}${added.map((n) => `Depende de #${n} ${DEPS_MARK}`).join('\n')}\n` : kept;
  return { body: next, added, removed, changed: added.length > 0 || removed.length > 0 };
}

// Los PR abiertos de los que depende `pr` (objeto REST de pulls/N): apilado sobre su rama, o con su commit adentro.
export function computeDeps(pr, open = apiAll(`${REPO}/pulls?state=open`, { allowFail: true }) ?? []) {
  const deps = new Set();
  const others = open.filter((o) => o.number !== pr.number);
  for (const o of others) if (o.head?.ref && o.head.ref === pr.base?.ref && (!o.head.repo || !pr.base.repo || o.head.repo.full_name === pr.base.repo.full_name)) deps.add(o.number);
  // ¿El commit de otro PR abierto está debajo del de éste? (se armó sobre él). Tope de 20 comparaciones.
  for (const o of others.slice(0, 20)) {
    if (deps.has(o.number) || !o.head?.sha || !pr.head?.sha || o.head.sha === pr.head.sha) continue;
    const c = api('GET', `${REPO}/compare/${o.head.sha}...${pr.head.sha}`, undefined, { allowFail: true });
    if (c?.status === 'ahead') deps.add(o.number);
  }
  return [...deps].sort((a, b) => a - b);
}

// Lee el PR, calcula de qué depende y deja la descripción al día (sólo escribe si algo cambió).
export function syncDeps(n) {
  const pr = api('GET', `${REPO}/pulls/${n}`, undefined, { allowFail: true });
  if (!pr?.number || pr.state !== 'open') return { pr: n, dependsOn: [], added: [], removed: [], changed: false };
  const wanted = computeDeps(pr);
  const r = syncDepsLines(pr.body ?? '', wanted);
  if (r.changed) api('PATCH', `${REPO}/pulls/${n}`, { body: r.body });
  return { pr: n, dependsOn: wanted, added: r.added, removed: r.removed, changed: r.changed };
}
