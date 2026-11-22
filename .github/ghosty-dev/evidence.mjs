// Formato y validación del comentario de evidencia (Ley 2: se revisa la evidencia, no el código).
// Archivo autocontenido: `ghosty-dev init` lo copia a .github/ghosty-dev/ para que lo use la Action.

export const EVIDENCE_MARKER = '<!-- ghosty-dev:evidencia v0.1 -->';

// Normaliza un encabezado: minúsculas, sin acentos ni signos.
const norm = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();

// Parte un markdown en secciones por encabezados ## o ###.
export function parseSections(md) {
  const sections = {};
  let current = null;
  for (const line of md.split('\n')) {
    const m = line.match(/^#{2,3}\s+(.+?)\s*$/);
    if (m) {
      current = norm(m[1]);
      sections[current] = '';
    } else if (current) {
      sections[current] += line + '\n';
    }
  }
  for (const k of Object.keys(sections)) sections[k] = sections[k].trim();
  return sections;
}

// Busca una sección cuyo nombre empiece con alguna de las claves.
function section(sections, ...keys) {
  const name = Object.keys(sections).find((s) => keys.some((k) => s.startsWith(k)));
  return name === undefined ? null : sections[name];
}

// Criterios de aceptación de un pendiente: renglones «- [ ] …» o «- [x] …».
export function parseChecklist(text) {
  if (!text) return [];
  return [...text.matchAll(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/gm)].map((m) => ({
    done: m[1] !== ' ',
    text: m[2],
  }));
}

export function acceptanceCriteria(issueBody = '') {
  return parseChecklist(section(parseSections(issueBody), 'criterios'));
}

const CI_GREEN = /✅|\bverde\b|\bpass(ed|ing)?\b|\bsuccess\b/i;
const CI_RED = /❌|\brojo\b|\bfail(ed|ing|ure)?\b/i;

// Valida el cuerpo de una evidencia contra el pendiente. Regresa { ok, errors }.
export function validateEvidence(md, issueBody = '') {
  const errors = [];
  const s = parseSections(md);

  const done = section(s, 'que se hizo');
  if (!done) errors.push('Falta «Qué se hizo» (o está vacío).');

  // Oráculo: al menos un comando ($ …) con su salida, dentro de un bloque de código.
  const verification = section(s, 'verificacion');
  if (!verification) {
    errors.push('Falta «Verificación».');
  } else {
    const blocks = [...verification.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
    const lines = blocks.join('\n').split('\n').filter((l) => l.trim());
    const commands = lines.filter((l) => l.trimStart().startsWith('$ '));
    if (commands.length === 0) errors.push('«Verificación» necesita un bloque de código con comandos que empiecen con «$ ».');
    else if (lines.length === commands.length) errors.push('«Verificación» trae comandos pero no su salida.');
  }

  const ci = section(s, 'ci');
  if (!ci) errors.push('Falta «CI» (resultado y liga del run).');
  else if (CI_RED.test(ci)) errors.push('El CI está en rojo: no se cierra un pendiente con CI rojo.');
  else if (!CI_GREEN.test(ci)) errors.push('«CI» debe decir el resultado (✅ / verde / passed).');

  // El flujo principal ejercido con sesión (Formmy, filas 44 y 46): smoke, revisión y evidencia pasaron con el chat
  // roto porque nadie lo usó. Se exige el renglón con su prueba (captura o salida), o «no aplica» con el motivo.
  const flow = mainFlowProblem(mainFlowOf(md));
  if (flow) errors.push(flow);

  // Cada criterio de aceptación del pendiente debe venir marcado en la evidencia.
  const wanted = acceptanceCriteria(issueBody);
  if (wanted.length) {
    const given = parseChecklist(section(s, 'criterios'));
    for (const c of wanted) {
      const hit = given.find((g) => norm(g.text) === norm(c.text));
      if (!hit || !hit.done) errors.push(`Criterio sin cumplir en la evidencia: «${c.text}».`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------- «Flujo principal probado con sesión» (Formmy, filas 44 y 46) ----------

export const MAIN_FLOW_LABEL = 'Flujo principal probado con sesión';
const MAIN_FLOW_KEY = 'flujo principal';

// El texto del renglón: la sección «## Flujo principal probado con sesión» o el renglón «Flujo principal probado con
// sesión: …» con lo que lo sigue hasta el siguiente encabezado. null si no está.
export function mainFlowOf(md = '') {
  const sec = section(parseSections(md), MAIN_FLOW_KEY);
  if (sec !== null) return sec;
  const lines = String(md).split('\n');
  const i = lines.findIndex((l) => norm(l.replace(/[*_`>-]/g, ' ')).startsWith('flujo principal probado con sesion') && l.includes(':'));
  if (i === -1) return null;
  const rest = [lines[i].slice(lines[i].indexOf(':') + 1)];
  for (let j = i + 1; j < lines.length && !/^#{1,6}\s/.test(lines[j]); j++) rest.push(lines[j]);
  return rest.join('\n').trim();
}

const IMAGE = /!\[[^\]]*\]\(\s*\S+?\s*\)|<img\s[^>]*src=|https:\/\/\S+\.(?:png|jpe?g|gif|webp|mp4|webm|mov)\b|https:\/\/github\.com\/user-attachments\/\S+/i;

// Puro: null si el renglón vale; si no, el error. Vale con una captura (imagen o video) o con un bloque de código con
// un comando «$ …» y su salida; «no aplica: <motivo>» sólo con motivo (una biblioteca sin interfaz, por ejemplo).
export function mainFlowProblem(text) {
  const how = `«${MAIN_FLOW_LABEL}: <qué hiciste y cómo>» con una captura o un bloque «$ …» con su salida`;
  if (text == null || !text.replace(/<!--[\s\S]*?-->/g, '').trim()) return `Falta ${how} (entra con sesión a la vista previa y usa la función principal, no sólo abras la página).`;
  const clean = text.replace(/<!--[\s\S]*?-->/g, '').trim();
  const na = clean.match(/^no aplica\b[\s:—-]*(.*)$/is);
  if (na) return na[1].trim().length >= 15 ? null : `«${MAIN_FLOW_LABEL}: no aplica» necesita el motivo (p. ej. «no aplica: es una biblioteca sin interfaz ni login»).`;
  if (IMAGE.test(clean)) return null;
  const blocks = [...clean.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1].split('\n').filter((l) => l.trim()));
  if (blocks.some((b) => b.some((l) => l.trimStart().startsWith('$ ')) && b.some((l) => !l.trimStart().startsWith('$ ')))) return null;
  return `«${MAIN_FLOW_LABEL}» necesita la prueba: una captura (imagen) o un bloque con el comando «$ …» y su salida.`;
}

// ---------- «probado en la preview del PR #N» (Formmy, fila 40) ----------
// Un PR basado en main a veces no puede probar logueado en su propia preview y la prueba se hace en la de otro PR.
// Esa referencia vale SÓLO si el otro PR contiene el mismo commit que se va a mergear: si no, lo probado es otro código.

const PREVIEW_REF = /(?:preview|vista previa)\s+(?:del?\s+)?(?:PR\s*)?#(\d+)/gi;

// Los números de PR que la evidencia cita como «preview del PR #N». Puro.
export function previewPrRefs(md = '') {
  return [...new Set([...String(md).matchAll(PREVIEW_REF)].map((m) => Number(m[1])))];
}

// Puro: los problemas de esas referencias. `commitsOf(n)` = shas del PR n (null = no se pudo leer).
export function crossPreviewProblems(md, { pr, sha }, commitsOf) {
  const problems = [];
  if (!sha) return problems;
  for (const n of previewPrRefs(md)) {
    if (pr && n === pr) continue;
    const shas = commitsOf(n);
    if (shas == null) problems.push(`La evidencia cita la preview del PR #${n}, pero no pude leer sus commits.`);
    else if (!shas.some((s) => s === sha || s.startsWith(sha) || sha.startsWith(s)))
      problems.push(`La evidencia cita la preview del PR #${n}, pero #${n} no contiene el commit ${sha.slice(0, 7)}: lo probado ahí es otro código. Prueba en la preview de este PR (login: identidad de Ghosty en previews u OAuth de previews, ver ghosty-dev doctor) o quita esa referencia.`);
  }
  return problems;
}

// Arma el comentario que se publica en el issue.
// El PR va enlazado arriba para que la persona llegue al merge desde el issue.
export function formatEvidence(number, md, pr = null) {
  const prLine = pr?.url ? `PR: ${pr.url}\n\n` : '';
  return `${EVIDENCE_MARKER}\n## Evidencia del pendiente #${number}\n\n${prLine}${md.trim()}\n`;
}

// De los comentarios de un issue, el último que sea evidencia válida (o null).
export function findValidEvidence(comments = [], issueBody = '') {
  for (const c of [...comments].reverse()) {
    const body = c.body || '';
    if (!body.includes(EVIDENCE_MARKER)) continue;
    if (validateEvidence(body, issueBody).ok) return c;
  }
  return null;
}

// ---------- revisión (Cognition: el revisor no comparte contexto; Anthropic: quien escribe se califica de más) ----------

export const REVISION_MARKER = '<!-- ghosty-dev:revision v0.1';
const OPEN_FINDINGS = /hallazgos abiertos:\s*(\d+)/i;

// Valida el cuerpo que publica el revisor. Regresa { ok, errors, open }.
export function validateRevision(md) {
  const errors = [];
  const s = parseSections(md);
  const body = section(s, 'revision');
  if (body === null) return { ok: false, errors: ['Falta la sección «Revisión».'], open: null };
  const blocks = [...body.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const lines = blocks.join('\n').split('\n').filter((l) => l.trim());
  const commands = lines.filter((l) => l.trimStart().startsWith('$ '));
  if (commands.length === 0) errors.push('«Revisión» necesita un bloque con las pruebas que corriste («$ …») y su salida.');
  else if (lines.length === commands.length) errors.push('«Revisión» trae comandos pero no su salida.');
  const attacks = parseChecklist(body);
  if (attacks.length === 0) errors.push('«Revisión» necesita la lista de ataques: «- [x] aguantó …» o «- [ ] lo rompió …».');
  const m = body.match(OPEN_FINDINGS);
  if (!m) errors.push('Falta el renglón «Hallazgos abiertos: N».');
  const open = m ? Number(m[1]) : null;
  const failed = attacks.filter((a) => !a.done).length;
  if (m && open !== failed) errors.push(`«Hallazgos abiertos: ${open}» no cuadra con ${failed} ataque(s) sin palomear.`);
  return { ok: errors.length === 0, errors, open };
}

export function formatRevision(number, sha, md, pr = null) {
  const prPart = pr?.url ? ` · PR: ${pr.url}` : '';
  return `${REVISION_MARKER} sha=${sha} -->\n**Revisión del pendiente #${number}, commit ${sha.slice(0, 7)}**${prPart}\n\n${md.trim()}\n`;
}

// La última revisión válida del commit exacto (o null). Un push nuevo invalida las anteriores.
export function findRevisionFor(comments = [], sha) {
  for (const c of [...comments].reverse()) {
    const body = c.body || '';
    const m = body.match(/<!-- ghosty-dev:revision v0\.1 sha=([0-9a-f]{7,40}) -->/);
    if (!m || !sha || !(sha.startsWith(m[1]) || m[1].startsWith(sha))) continue;
    const r = validateRevision(body);
    if (r.ok) return { comment: c, open: r.open };
  }
  return null;
}
