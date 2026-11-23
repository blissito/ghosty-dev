// Puerta de evidencia del PR (Ley 2 + «proof of work» antes del merge, OpenAI Symphony).
// La corre la Action `ghosty-dev/evidencia`: falla si algún pendiente que el PR cierra no tiene
// un comentario de evidencia válido. Autocontenido: `ghosty-dev init` lo copia a .github/ghosty-dev/.
import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { findValidEvidence, findRevisionFor, crossPreviewProblems } from './evidence.mjs';

const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;

export function closingRefs(body = '') {
  return [...new Set([...body.matchAll(CLOSING)].map((m) => Number(m[1])))];
}

// Revisión por check externo (opcional): un revisor con OTRA identidad publica un check sobre el commit del PR.
// Se configura en `.github/ghosty-dev/config.json` de la rama base: { "reviewCheck": { "name": "…", "app": "…" } }.
// Cierra lo que la puerta no puede probar con comentarios: que quien revisó no es quien escribió (SPEC §4b).
export function reviewCheckConfig(raw) {
  try {
    const rc = JSON.parse(raw || '{}').reviewCheck;
    const name = typeof rc?.name === 'string' ? rc.name.trim() : '';
    const app = typeof rc?.app === 'string' ? rc.app.trim() : '';
    // Sin `app` cualquiera con permiso de checks podría publicar uno con ese nombre: se exigen los dos.
    return name && app ? { name, app } : null;
  } catch {
    return null;
  }
}

// Puro: el check del revisor externo sobre el commit exacto. { state: 'passed' | 'findings' | 'pending' | 'missing' }.
export function externalReview(config, checkRuns = [], sha = '') {
  if (!config) return null;
  const runs = checkRuns.filter((r) => r?.name === config.name && r?.app?.slug === config.app && r?.head_sha === sha);
  if (runs.length === 0) return { state: 'missing', ...config };
  // El más reciente manda: un re-run sustituye al anterior.
  const last = runs.sort((a, b) => String(b.completed_at || b.started_at || '').localeCompare(String(a.completed_at || a.started_at || '')))[0];
  if (last.status !== 'completed') return { state: 'pending', ...config };
  return { state: last.conclusion === 'success' ? 'passed' : 'findings', ...config };
}

// Puro: la vista previa del commit (check «Ghosty · Preview» de Ghosty Studio). Un build o arranque roto es ROJO
// (Formmy, fila 52: el #100 rompió el build de Vite y pasó pruebas, tsc y dos revisiones; sólo la preview lo vio).
// Neutral (variables faltantes, falla de infraestructura) no bloquea. { state: 'failed' | 'ok' | 'pending' | 'missing', title }.
export const PREVIEW_CHECK = 'Ghosty · Preview';
export function previewBuild(checkRuns = [], sha = '') {
  const runs = checkRuns.filter((r) => r?.name === PREVIEW_CHECK && (!r.head_sha || r.head_sha === sha));
  if (!runs.length) return { state: 'missing', title: null };
  const last = runs.sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0];
  const title = last.output?.title ?? null;
  if (last.status !== 'completed') return { state: 'pending', title };
  return { state: ['failure', 'timed_out', 'cancelled', 'action_required'].includes(last.conclusion) ? 'failed' : 'ok', title };
}

// Un PR fuera de la bitácora (no cierra ningún pendiente) BLOQUEA por defecto (falla cerrada), con el comando exacto
// que lo liga. Sólo con `"unlinked": "warn"` en .github/ghosty-dev/config.json de la base pasa con aviso.
export function unlinkedPolicy(raw) {
  try {
    return JSON.parse(raw || '{}').unlinked === 'warn' ? 'inform' : 'block';
  } catch {
    return 'block';
  }
}

// Puro: recibe el PR y una función que trae cada issue ({ body, comments }). `external` = externalReview(…) o null.
// `prCommits(n)` = shas del PR n (null = no se pudo): valida «probado en la preview del PR #N» (Formmy, fila 40).
export function evaluatePullRequest(pr, fetchIssue, external = null, { unlinked = 'block', prCommits = null, preview = null } = {}) {
  const refs = closingRefs(pr.body || '');
  if (refs.length === 0) {
    const fix = `ghosty-dev claim --pr ${pr.number ?? '<m>'} --issue <n> (o agrega «Closes #n» a la descripción)`;
    if (unlinked === 'block') {
      const line = `El PR no cierra ningún pendiente: ${fix}.`;
      return { ok: false, lines: [line], failures: [line] };
    }
    // Sólo con "unlinked": "warn".
    return { ok: true, informative: true, failures: [], lines: [`El PR no está ligado a un pendiente: la puerta no tiene qué juzgar (informativo). Regularízalo: ${fix}.`] };
  }
  const sha = pr.head?.sha || '';
  const short = sha.slice(0, 7);
  const lines = [];
  // Cada causa que falla va también a `failures`: main() la imprime como anotación ::error (gs la lee por
  // /check-runs/{id}/annotations; la primera es la causa principal).
  const failures = [];
  const fail = (line) => {
    lines.push(line);
    failures.push(line);
  };
  // Rama fuera del patrón ghosty-dev/<n>-…: informativo, no cambia el veredicto (lo que juzga es el pendiente).
  const ref = pr.head?.ref;
  if (preview?.state === 'failed') fail(`La vista previa del commit ${short} no compila o no arranca${preview.title ? ` (${preview.title})` : ''}: corre el build del repo (npm run build), arréglalo y sube. Ni pruebas ni revisión sustituyen al build.`);
  if (ref && !/^ghosty-dev\/\d+-/.test(ref)) lines.push(`Informativo: la rama ${ref} no sigue el patrón ghosty-dev/<n>-…; la puerta juzga ${refs.map((r) => '#' + r).join(', ')} igual.`);
  for (const n of refs) {
    const issue = fetchIssue(n);
    // Revisión: otro agente con contexto limpio, del commit exacto que se va a mergear.
    const rev = findRevisionFor(issue.comments, sha);
    if (external?.state === 'passed') {
      lines.push(`#${n}: revisión del commit ${short} por el check «${external.name}» (${external.app}), sin hallazgos.`);
    } else if (external && external.state !== 'missing') {
      fail(
        external.state === 'pending'
          ? `#${n}: el check «${external.name}» del commit ${short} sigue corriendo.`
          : `#${n}: el check «${external.name}» del commit ${short} dejó hallazgos abiertos.`,
      );
    } else if (!rev) {
      fail(`#${n}: falta la revisión del commit ${short} (ghosty-dev review ${n}).`);
    } else if (rev.open > 0) {
      fail(`#${n}: la revisión del commit ${short} tiene ${rev.open} hallazgo(s) abierto(s).`);
    } else {
      lines.push(`#${n}: revisión del commit ${short} sin hallazgos abiertos.`);
    }
    const ev = findValidEvidence(issue.comments, issue.body);
    const cross = ev && prCommits ? crossPreviewProblems(ev.body || '', { pr: pr.number, sha }, prCommits) : [];
    if (ev && cross.length) {
      for (const c of cross) fail(`#${n}: ${c}`);
    } else if (ev) {
      lines.push(`#${n}: evidencia válida.`);
    } else {
      fail(`#${n}: sin comentario de evidencia válido (ghosty-dev evidence ${n} --file evidencia.md).`);
    }
  }
  return { ok: failures.length === 0, lines, failures };
}

// Una anotación de GitHub (::error) en una sola línea: %, \r y \n escapados como pide su formato.
export const annotation = (line, level = 'error') => `::${level} title=evidencia::${String(line).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`;

// Un borrador todavía se está iterando: se valida al cerrar, no mientras tanto. La puerta sale en verde con la
// explicación, y el workflow vuelve a correr con `ready_for_review` (al marcarlo listo), donde ya se exige todo.
export const DRAFT_NOTE = 'Borrador: la evidencia se exige al marcarlo listo.';

function report(lines) {
  const text = lines.map((l) => `- ${l}`).join('\n');
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ghosty-dev/evidencia\n${text}\n`);
}

export function main() {
  const gh = process.env.GHOSTY_DEV_GH || 'gh';
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const pr = event.pull_request;
  if (pr?.draft) {
    report([DRAFT_NOTE]);
    process.exit(0);
  }
  // REST, igual que el CLI (nada de `gh issue view`, que usa GraphQL).
  const get = (path) => JSON.parse(execFileSync(gh, ['api', '-X', 'GET', path], { encoding: 'utf8' }));
  const fetchIssue = (n) => ({
    body: get(`repos/{owner}/{repo}/issues/${n}`).body || '',
    comments: get(`repos/{owner}/{repo}/issues/${n}/comments?per_page=100`),
  });
  // La configuración sale de la rama base (el checkout de la Action), igual que este script.
  let config = null;
  let unlinked = 'block';
  try {
    const raw = readFileSync(new URL('./config.json', import.meta.url), 'utf8');
    config = reviewCheckConfig(raw);
    unlinked = unlinkedPolicy(raw);
  } catch {}
  let external = null;
  let preview = null;
  if (pr.head?.sha) {
    let runs = [];
    try {
      const out = execFileSync(gh, ['api', '-X', 'GET', `repos/{owner}/{repo}/commits/${pr.head.sha}/check-runs?per_page=100`], { encoding: 'utf8' });
      runs = JSON.parse(out).check_runs || [];
    } catch {}
    if (config) external = externalReview(config, runs, pr.head.sha);
    preview = previewBuild(runs, pr.head.sha);
  }
  const prCommits = (n) => {
    try {
      return get(`repos/{owner}/{repo}/pulls/${n}/commits?per_page=100`).map((c) => c.sha);
    } catch {
      return null;
    }
  };
  const { ok, lines, informative, failures } = evaluatePullRequest(pr, fetchIssue, external, { unlinked, prCommits, preview });
  if (informative) console.log(annotation(lines[0], 'warning'));
  for (const f of failures) console.log(annotation(f));
  report(lines);
  process.exit(ok ? 0 : 1);
}

// Corre sólo como script (no al importarlo en los tests); realpath por los symlinks de /tmp en macOS.
const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (import.meta.url === pathToFileURL(invokedPath).href) main();
