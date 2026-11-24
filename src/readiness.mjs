// ¿Está el repo preparado para trabajar con ghosty-dev? Puro: recibe lo YA leído de la rama base y dice qué falta.
// Una sola fuente: ghosty-dev (`doctor`, `claim`) la usa directo y Ghosty Studio la lleva copiada
// (scripts/sync-ghosty-dev-evidence.sh), igual que evidence.mjs. Formmy, 23-nov: sin `reviewCheck` la evidencia
// fallaba en TODOS los PR de la nube y nada lo avisó.

// Lectura de `reviewCheck` del config (misma regla que `reviewCheckConfig` de gate.mjs; se repite para que este archivo
// sea autocontenido y gs lo lleve copiado tal cual). Una prueba vigila que no se desfasen.
function reviewCheckConfig(raw) {
  try {
    const rc = JSON.parse(raw || '{}').reviewCheck;
    const name = typeof rc?.name === 'string' ? rc.name.trim() : '';
    const app = typeof rc?.app === 'string' ? rc.app.trim() : '';
    return name && app ? { name, app } : null;
  } catch {
    return null;
  }
}

// Versión mínima COMPATIBLE de la puerta instalada (hoy 0.9.38: la puerta propia no cuenta como CI). Una sola constante.
// Una copia distinta pero >= mínima funciona: sólo avisa (`gate-version`). Anterior a la mínima, ausente o rota: bloquea.
export const MIN_GATE_VERSION = '0.9.38';
const cmpVer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
/** Versión de la puerta que declara su evidence.mjs (`GATE_VERSION`); sin marcador, 0.9.38 si ya exporta GATE_CHECKS, si no 0.0.0. */
export function installedGateVersion(evidenceText = '') {
  const m = /GATE_VERSION\s*=\s*'(\d+\.\d+\.\d+)'/.exec(evidenceText);
  if (m) return m[1];
  return /export const GATE_CHECKS\b/.test(evidenceText) ? '0.9.38' : '0.0.0';
}

export const GATE_CHECK_NAME = 'ghosty-dev/evidencia';
export const PREPARE_TITLE = 'Preparar el repo para ghosty-dev';
export const READINESS_PATHS = {
  gate: '.github/ghosty-dev/gate.mjs',
  evidence: '.github/ghosty-dev/evidence.mjs',
  workflow: '.github/workflows/evidence-gate.yml',
  config: '.github/ghosty-dev/config.json',
  factory: '.ghosty/factory.md',
};
const PR_TEMPLATES = ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'pull_request_template.md', 'docs/pull_request_template.md'];
/**
 * ¿Este pendiente YA es el trabajo de preparar el repo? Por título («Preparar el repo para ghosty-dev») o porque su
 * objetivo/criterios son los chequeos de readiness (puerta, gate.mjs, evidence.mjs, workflow, `ghosty-dev init`).
 * Reclamarlo no debe abrir otro pendiente de preparación ni bloquearse por él. Puro.
 */
export function isPreparationIssue(issue = {}) {
  if (String(issue.title ?? '').trim().toLowerCase() === PREPARE_TITLE.toLowerCase()) return true;
  const text = `${issue.title ?? ''}\n${issue.body ?? ''}`;
  return /gate\.mjs|evidence\.mjs|evidence-gate\.yml|ghosty-dev init|puerta de (ghosty-dev|evidencia)|puerta.{0,40}al d[ií]a/i.test(text) && /puerta|gate\.mjs|evidence\.mjs/i.test(text);
}

export const READINESS_READS = [...Object.values(READINESS_PATHS), ...PR_TEMPLATES];

const MAIN_FLOW = 'Flujo principal probado con sesión';

/**
 * @param {{ files: Record<string, string|null>, requiredChecks: string[]|null, branch?: string, expected?: { gate?: string, evidence?: string } }} i
 *   `files`: texto de cada ruta en la rama base (null = no existe). `requiredChecks`: contextos obligatorios de la rama
 *   (null = no se pudieron leer). `expected`: el texto vigente de gate.mjs / evidence.mjs para saber si están al día.
 * @returns {{ ready: boolean, checks: { id: string, ok: boolean, severity: 'block'|'warn', why: string, fix: string }[], blocking: object[] }}
 */
export function readinessOf({ files = {}, requiredChecks = null, branch = 'la rama principal', expected = {} } = {}) {
  const has = (p) => typeof files[p] === 'string';
  const checks = [];
  const add = (id, ok, severity, why, fix) => checks.push({ id, ok, severity, why, fix });

  const missingGate = [READINESS_PATHS.gate, READINESS_PATHS.evidence].filter((p) => !has(p));
  const stale = [['gate', READINESS_PATHS.gate], ['evidence', READINESS_PATHS.evidence]].filter(([k, p]) => has(p) && typeof expected[k] === 'string' && files[p] !== expected[k]).map(([, p]) => p);
  // Sólo bloquea si falta o es anterior a la mínima; una diferencia de versión por encima de ella es un aviso.
  const installed = has(READINESS_PATHS.evidence) ? installedGateVersion(files[READINESS_PATHS.evidence]) : null;
  const tooOld = installed !== null && cmpVer(installed, MIN_GATE_VERSION) < 0;
  add('gate', !missingGate.length && !tooOld, 'block',
    missingGate.length ? `faltan ${missingGate.join(' y ')} en ${branch} (se compara contra la rama base: se corrige al mezclar el PR de preparación)` : tooOld ? `la puerta instalada (${installed}) es anterior a la mínima compatible (${MIN_GATE_VERSION}) en ${branch}` : 'la puerta está instalada y es compatible',
    'ghosty-dev init --force --no-checks --files-only');
  if (!missingGate.length && !tooOld) {
    add('gate-version', !stale.length, 'warn',
      stale.length ? `${stale.join(' y ')} difiere de ghosty-dev (instalada ${installed}, mínima ${MIN_GATE_VERSION}); funciona, conviene actualizarla` : 'la puerta está al día con ghosty-dev',
      'ghosty-dev init --force --no-checks --files-only (PR de la persona)');
  }
  add('workflow', has(READINESS_PATHS.workflow), 'block', has(READINESS_PATHS.workflow) ? 'el workflow de la puerta existe' : `falta ${READINESS_PATHS.workflow}`, 'ghosty-dev init');
  const rc = has(READINESS_PATHS.config) ? reviewCheckConfig(files[READINESS_PATHS.config]) : null;
  // Sin config la puerta usa el revisor por defecto «Ghosty Review» (gate.mjs): ya no bloquea, sólo se recomienda fijarlo.
  add('review-check', Boolean(rc), 'warn',
    rc ? `acepta el check «${rc.name}» como revisor` : 'sin config.json: la puerta usa el revisor por defecto «Ghosty Review» (conviene fijarlo)',
    'ghosty-dev init (escribe .github/ghosty-dev/config.json con reviewCheck «Ghosty Review»)');
  if (requiredChecks !== null) {
    const ok = requiredChecks.includes(GATE_CHECK_NAME);
    // Aviso, no bloqueo: activar la protección sólo puede la persona dueña (admin) con su token; ningún escritor la cumple
    // (Formmy #118). Misma regla para ghosty-dev y Ghosty Studio.
    add('protection', ok, 'warn', ok ? `${branch} exige ${GATE_CHECK_NAME}` : `${branch} no exige ${GATE_CHECK_NAME}: el merge no espera la evidencia`, 'ghosty-dev protect (lo corre la persona dueña del repo, con su token)');
  }
  const tpl = PR_TEMPLATES.find(has);
  add('pr-template', Boolean(tpl && files[tpl].includes(MAIN_FLOW)), 'warn',
    tpl ? (files[tpl].includes(MAIN_FLOW) ? 'la plantilla del PR pide el flujo principal' : `${tpl} no trae el renglón «${MAIN_FLOW}»`) : 'sin plantilla de PR',
    `agrega «${MAIN_FLOW} <qué y cómo>» a la plantilla del PR`);
  add('factory-md', has(READINESS_PATHS.factory), 'warn', has(READINESS_PATHS.factory) ? 'hay .ghosty/factory.md' : 'falta .ghosty/factory.md (memoria y setup de la caja)', 'ghosty-dev init');

  const blocking = checks.filter((c) => !c.ok && c.severity === 'block');
  return { ready: blocking.length === 0, checks, blocking };
}

/** El pendiente «Preparar el repo»: objetivo y criterios a partir de lo que falta. Puro. */
export function prepareBrief(blocking = []) {
  const files = blocking.filter((c) => c.id !== 'protection');
  return {
    title: PREPARE_TITLE,
    goal: 'Dejar el repo listo para que el trabajo (de la terminal y de la nube) pase la puerta de evidencia y la revisión de Ghosty. Corre `ghosty-dev init --force --files-only --no-checks` en una rama (sólo escribe los archivos de la puerta: no usa `gh`, etiquetas, protección ni el workflow extra ghosty-checks.yml), haz commit y sube el PR con tus herramientas de siempre; mezclarlo es de la persona (la puerta se lee de la rama base). Después la persona corre `ghosty-dev init` (etiquetas) y `ghosty-dev protect` en su terminal: no es parte de este pendiente.',
    // Sólo lo que cabe en un PR: la protección de la rama es de la persona (admin en GitHub), no un criterio del escritor.
    criteria: files.length ? files.map((c) => `${c.why} → ${c.fix.replace(/^ghosty-dev init( --force)?( --no-checks)?/, 'ghosty-dev init --force --files-only --no-checks')} (mezclarlo es de la persona)`) : ['La puerta de ghosty-dev está instalada y al día en la rama del PR.'],
  };
}
