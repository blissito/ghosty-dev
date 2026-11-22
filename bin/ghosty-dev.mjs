#!/usr/bin/env node
// CLI de ghosty-dev: el trabajo vive en GitHub Issues, no en la sesión del agente.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import * as cmd from '../src/commands.mjs';
import * as cloud from '../src/cloud.mjs';
import * as auth from '../src/auth.mjs';
import * as envVars from '../src/env.mjs';
import * as previews from '../src/preview.mjs';
import * as shares from '../src/share.mjs';
import * as boxes from '../src/box.mjs';
import * as writer from '../src/writer.mjs';
import { waitPr } from '../src/watch.mjs';
import { syncDeps } from '../src/deps.mjs';
import { createInterface } from 'node:readline/promises';

const HELP = `ghosty-dev — el trabajo vive en la bitácora, no en la sesión

Uso: ghosty-dev <comando> [opciones]

  init [--dir D] [--dry-run] [--force] [--no-protect] [--yes]
                                         etiquetas, plantilla, Action de evidencia, skill, AGENTS.md
                                         (protege la rama sólo si la puerta ya está en ella). Dice repo y rama antes
                                         de escribir (fuera de la rama principal pide --yes), confirma las etiquetas
                                         (sin terminal, sólo con --yes) y lista los workflows que dispara el push
  protect [--dry-run]                    vuelve obligatorio ghosty-dev/evidencia en la rama principal; --dry-run
                                         lista los PR abiertos que quedarían bloqueados y por qué
  add "título" --goal G --criteria C…    abre un pendiente (--criteria se repite; --by <m> si lo bloquea #m;
                                         --context, --from <n> si lo descubriste trabajando #n)
  review <n> [--pr <m>] [--file r.md]    sin --file: el encargo para el revisor (otra sesión, contexto limpio);
                                         con --file: el revisor publica su revisión atada al commit del PR
  board                                  abre en el navegador los pendientes abiertos del repo
  next (o status) [--json]               el siguiente paso correcto según el estado del repo, con el comando exacto
                                         (empieza por aquí tras compactar o retomar una sesión)
  ready [--json] [--claim] [--cloud]     pendientes que se pueden tomar ahora (sin bloqueo, o CI ya resuelto);
                                         avisa los PR abiertos que no están ligados a un pendiente
  claim <n> [--no-worktree] [--base B]   te asigna el pendiente y crea su rama y worktree desde origin/main (o B)
  claim --pr <m> --issue <n>             adopta un PR que ya existe como el trabajo de #n (sin rama ni worktree
                                         nuevos; agrega «Closes #n» si falta)
  claim <n> --cloud [--yes] [--workspace S]
                                         lo manda a una caja de trabajo de tu cuenta de Ghosty: un agente lo
                                         construye ahí, abre el PR, espera el CI y la revisión, y te avisa
                                         (sin --yes dice antes qué ocupa la nube, qué desalojaría y el costo si
                                         Ghosty lo sabe; sin terminal sale 75 con el comando para repetir)
  claim --cloud --pr <m> [--yes]         sin pendiente: Ghosty le pone vista previa, revisión y checks al PR #m
                                         y tu terminal lo sigue escribiendo
  cloud                                  los pendientes de este repo que van en la nube
  stop <n>                               detiene #n en la nube y libera su caja
  teleport <n>                           detiene #n en la nube y trae su rama para seguir en tu compu
  wait <n> [--watch] [--minutes M]       lo deja en esperando-ci; con --watch espera al CI o a un pedido de la persona
                                         (tope 5 min), dice si quedó verde o rojo y avisa cuando la vista previa y la
                                         revisión de Ghosty terminan (no las espera: el CI manda)
  asks <n> [--peek]                      los pedidos nuevos de la persona (@ghosty o desde Ghosty); los marca leídos
  evidence <n> [--pr <m>] --file e.md    valida y publica la evidencia y vuelve a correr la puerta del PR que
                                         cierra #n (también la re-dispara el workflow con issue_comment)
  evidence --check --file e.md [--issue-file pendiente.md]
  review --check --file revision.md      sólo validan el formato, sin gh ni red (no publican nada)
  block <n> --by <m>                     #n queda bloqueado por #m
  show <n> [--json]                      estado, bloqueos, evidencia, la ficha y los servicios del PR
                                         (vista previa, revisión, smoke y CI del commit actual)
  show --pr <m> [--json]                 lo mismo para un PR sin pendiente (p. ej. escrito desde la terminal)
  preview [<pr>] [--wait] [--open]       la vista previa del PR (sin número: el de tu rama). Lista: imprime la
                                         liga firmada (o la abre con --open); --wait espera hasta ~10 min a que
                                         la del último push quede lista o falle. Sale 0 lista, 75 armándose, 1 falló
  box logs [<pr>] [--lines N]            la caja de la vista previa del PR (sin número: el de tu rama): cola del log
                                         del build y del servidor (200 renglones por defecto)
  box exec [<pr>] -- <comando…>          corre el comando en el checkout de la caja (/app/src, 60 s); sale con su código
  box restart [<pr>]                     reinicia la app de la caja sin rearmar
  preview share [<pr>]                   liga pública para alguien sin cuenta (la única vez que se imprime)
  preview unshare [<pr>]                 la revoca; quien la abra puede pedir acceso
  preview requests [<pr>] [--status pending|accepted|rejected|all]
  preview accept|reject <id> [--pr <m>]  decide una solicitud de acceso
  doctor                                 lo que va a fallar en la vista previa: lock, llaves y callback de OAuth
  check-lock                             ¿el lock (npm/pnpm/yarn) coincide con package.json en HEAD? Lo corre el pre-push
  box rebuild [<pr>]                     rearma la vista previa del último commit (síguela con preview --wait)
  deps [<pr>]                            escribe «Depende de #N» en la descripción si el PR va apilado sobre otro PR
                                         abierto (o trae su commit) y la quita cuando ése entra; preview y wait lo
                                         hacen solos
  wait --pr <m> [--until preview|ci|review|any] [--minutes 10]
                                         espera por PR, sin pendiente: hasta que la vista previa, el CI o la revisión
                                         del último commit terminen (any: el primer cambio). Un renglón (JSON con
                                         --json) por cambio; sale 0 cumplido, 1 falló/rojo, 75 se acabó el tiempo
  close <n>                              cierra el pendiente, sólo si tiene evidencia válida

Flujo del agente de terminal: git push → ghosty-dev preview --wait --json → prueba la app en la liga → evidencia.
Si la vista previa falla: ghosty-dev box logs → ghosty-dev box exec -- <comando> → arregla → git push.
La liga de preview lleva la llave de la vista previa: no la pegues en issues, PRs ni logs.

Sesión propia en Ghosty Studio (nube, vista previa y variables; GitHub sigue siendo gh):
  login [--device] [--force]             entra a Ghosty Studio (navegador; --device, sin terminal o con --json:
                                         liga + código y espera); --force pide sesión nueva aunque ya haya una
                                         (permisos: profile repo:env dev)
  login --no-wait                        para agentes, paso 1: imprime liga + código y sale de inmediato
  login --wait [--timeout 90]            paso 2: espera la aprobación hasta --timeout s; si sigue pendiente sale con 75
  whoami                                 con qué cuenta de Ghosty Studio estás y cuándo vence la sesión
  logout                                 revoca la sesión y borra ~/.config/ghosty-dev/auth.json
  env ls                                 nombres de las variables del repo: guardadas, faltantes, riesgos
  env push <archivo> [--replace] [--yes] guarda las variables del archivo (nunca imprime valores); por defecto
                                         fusiona con las guardadas, --replace reemplaza todas

Opciones globales: --json (salida en JSON), -h/--help
Requiere gh autenticado (GHOSTY_DEV_GH cambia el binario). La nube y las variables usan la sesión de ghosty-dev login.
Variables: GHOSTY_DEV_TOKEN (CI) manda sobre la sesión guardada; GHOSTY_DEV_BASE_URL cambia el servidor (sólo https).`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
    json: { type: 'boolean' },
    claim: { type: 'boolean' },
    cloud: { type: 'boolean' },
    'no-worktree': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    force: { type: 'boolean' },
    'no-protect': { type: 'boolean' },
    dir: { type: 'string' },
    file: { type: 'string' },
    check: { type: 'boolean' },
    'issue-file': { type: 'string' },
    by: { type: 'string' },
    watch: { type: 'boolean' },
    peek: { type: 'boolean' },
    minutes: { type: 'string' },
    goal: { type: 'string' },
    criteria: { type: 'string', multiple: true },
    context: { type: 'string' },
    from: { type: 'string' },
    device: { type: 'boolean' },
    'no-wait': { type: 'boolean' },
    pr: { type: 'string' },
    wait: { type: 'boolean' },
    open: { type: 'boolean' },
    lines: { type: 'string' },
    issue: { type: 'string' },
    workspace: { type: 'string' },
    status: { type: 'string' },
    base: { type: 'string' },
    until: { type: 'string' },
    timeout: { type: 'string' },
    replace: { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
  },
});
if (values.version) {
  const { readFileSync } = await import('node:fs');
  console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  process.exit(0);
}


const [command, arg, arg2] = positionals;
let existing = null; // sesión que ya había al pedir login
const num = (v, what = '<n>') => {
  const n = Number(String(v ?? '').replace(/^#/, ''));
  if (!Number.isInteger(n) || n <= 0) throw new cmd.UserError(`Falta el número del pendiente ${what}.`);
  return n;
};

// Se imprime al terminar la instalación; el agente lo copia tal cual en su último mensaje.
// La mascota es la de GhostyCode (crates/tui/src/tui/underwater.rs): halo, cabeza, ojos y cola en bloques.
const GHOST_EYES = ['◐', '─', '◐', '◑', '●', '◕', '◠', '✧', '◕']; // un recorrido corto de su línea de tiempo
const ghostRows = (eye) => ['   ˚    ', ' ▄████▄ ', `▐ ${eye}  ${eye} ▌`, '▐█▀██▀█▌'];

function readyBanner({ repo, branch }, eye = '◕') {
  const text = [
    `ghosty-dev está listo${repo ? ` en ${repo}` : ''}`,
    '',
    '✓ etiquetas y plantilla de pendiente',
    `✓ la puerta ghosty-dev/evidencia es obligatoria en ${branch}`,
    '✓ revisor con contexto limpio (.claude/agents/ghosty-dev-revisor.md)',
    'Dile a tu agente qué hay que hacer: él abre los pendientes.',
  ];
  const ghost = ghostRows(eye);
  return text.map((t, i) => `${ghost[i] ?? '        '}    ${t}`.trimEnd()).join('\n');
}

// En una terminal de verdad (una persona, no un agente) los ojos se mueven un par de segundos y terminan contentos.
async function showBanner(data) {
  if (!process.stdout.isTTY || values.json || process.env.NO_COLOR || process.env.CI) {
    console.log(readyBanner(data));
    return;
  }
  const lines = readyBanner(data).split('\n').length;
  for (let i = 0; i < GHOST_EYES.length; i++) {
    if (i) process.stdout.write(`\x1b[${lines}A`);
    process.stdout.write(readyBanner(data, GHOST_EYES[i]) + '\n');
    await new Promise((r) => setTimeout(r, 260));
  }
}

// Antes de gastar en la nube: qué ocupa ya, qué desalojaría y el costo si gs lo sabe. Sin --yes: con terminal pregunta;
// sin terminal imprime el resumen y sale con 75 y el comando exacto para repetir con --yes.
async function confirmCloud({ n, pr }, retry) {
  if (values.yes) return true;
  const p = await cloud.preflight({ n, pr, workspace: values.workspace });
  if (process.stdin.isTTY && !values.json) {
    console.error(cloud.preflightText(p));
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const ok = /^(s|si|sí|y|yes)$/i.test((await rl.question('¿Sigo? [s/N] ')).trim());
    rl.close();
    if (!ok) throw new cmd.UserError('No se mandó nada a la nube.');
    return true;
  }
  print({ status: 'confirm', ...p, next: retry }, () => `${cloud.preflightText(p)}\nSi la persona está de acuerdo: ${retry}`);
  process.exitCode = 75;
  return false;
}

const printCloud = (r) =>
  print(r, (x) =>
    x.services
      ? `PR #${x.pr ?? '?'}: vista previa, revisión y checks en cada push; tu terminal lo sigue escribiendo.${x.prUrl ? `\n  ${x.prUrl}` : ''}${x.note ? `\n  ${x.note}` : ''}\n  Síguelo: ghosty-dev wait <n> --watch · ghosty-dev show <n>`
      : `${x.already ? 'Ya iba en la nube' : 'Mandado a la nube'}: #${x.number} ${x.title}\n  estado: ${x.state}\n  ${x.pr ?? x.url}\n  Síguelo: ghosty-dev cloud   ·   Detenlo: ghosty-dev stop ${x.number}`,
  );

// Una línea por servicio de la plataforma (vista previa, revisión, smoke) y el CI del commit del PR.
const SERVICE_WORD = { pendiente: 'en curso', listo: 'lista', fallo: 'falló', neutral: 'neutral', 'sin-check': '—' };
function serviceLine(key, s) {
  const label = { preview: 'Vista previa', review: 'Revisión', smoke: 'Smoke', gate: 'Evidencia (ghosty-dev/evidencia)' }[key];
  const word = key === 'review' && s.status === 'listo' ? 'terminada' : SERVICE_WORD[s.status];
  const extra = [s.title, key === 'review' && s.comments ? `${s.comments} comentario(s) de hallazgos` : null].filter(Boolean).join(' · ');
  const url = key === 'preview' ? s.deployment ?? s.url : s.url;
  return `  ${label}: ${word}${extra ? ` (${extra})` : ''}${url ? `\n    ${url}` : ''}`;
}
const servicesBlock = (sv) =>
  sv ? ['', `Servicios del PR (commit ${sv.sha.slice(0, 7)}):`, ...['preview', 'review', 'smoke', 'gate'].filter((k) => sv[k] && (k !== 'gate' || sv[k].status !== 'sin-check')).map((k) => serviceLine(k, sv[k])), `  CI: ${sv.ci}`] : [];

// Vista previa según Ghosty Studio, para `show`: fase y commit, NUNCA la liga (ésa sólo la da `preview`). Si no hay
// sesión de ghosty-dev o gs no contesta, `show` sigue con lo de GitHub.
const PHASE_WORD = { none: 'sin vista previa', queued: 'en fila', building: 'armándose', ready: 'lista', failed: 'falló' };
async function previewSummary(pr) {
  if (!Number.isInteger(pr) || pr <= 0) return null;
  try {
    if (!(await auth.existingSession())) return null;
    return previews.publicPreview(await previews.fetchPreview(pr));
  } catch {
    return null;
  }
}
const previewLine = (p) => (p ? [`  vista previa (Ghosty Studio): ${PHASE_WORD[p.phase] ?? p.phase}${p.sha ? ` · commit ${p.sha.slice(0, 7)}` : ''} — la liga: ghosty-dev preview`] : []);

const CI_WORD = { verde: 'verde', rojo: 'rojo', pendiente: 'en curso', 'sin-checks': 'sin checks' };
// Lo que todavía no está, en una frase: así el agente no repite «me bloquea la preview» con la preview ya lista
// (Formmy, 22-nov). La evidencia sólo cuenta si la puerta existe en el commit.
const missingOf = (s) => {
  const sha = (s.sha ?? '').slice(0, 7);
  const out = [];
  if (s.preview.phase !== 'ready' && s.preview.phase !== 'none') out.push(`vista previa (${PHASE_WORD[s.preview.phase] ?? s.preview.phase})`);
  // El smoke cuenta como CI (SPEC §5c): se nombra dentro del CI, no dos veces.
  const smokeOpen = s.smoke.status === 'pendiente' || s.smoke.status === 'fallo';
  if (s.ci !== 'verde') out.push(`CI (${CI_WORD[s.ci] ?? s.ci}${smokeOpen ? `; smoke ${SERVICE_WORD[s.smoke.status]}` : ''})`);
  else if (smokeOpen) out.push(`smoke (${SERVICE_WORD[s.smoke.status]})`);
  if (s.review.status === 'pendiente') out.push('revisión');
  if (s.gate && s.gate.status !== 'listo' && s.gate.status !== 'sin-check') out.push(`evidencia en ${sha}${s.gate.title ? ` (${s.gate.title})` : ''}`);
  return out;
};
const prStateLine = (s) => {
  const head = `PR #${s.pr} (${(s.sha ?? '').slice(0, 7)}${s.state !== 'abierto' ? `, ${s.state}` : ''}): vista previa ${PHASE_WORD[s.preview.phase] ?? s.preview.phase} · CI ${CI_WORD[s.ci] ?? s.ci} · revisión ${SERVICE_WORD[s.review.status]}${s.review.title ? ` (${s.review.title})` : ''} · smoke ${SERVICE_WORD[s.smoke.status]}${s.gate && s.gate.status !== 'sin-check' ? ` · evidencia ${SERVICE_WORD[s.gate.status]}` : ''}`;
  if (s.state !== 'abierto') return head;
  const miss = missingOf(s);
  return `${head}\n  ${miss.length ? `falta: ${miss.join(', ')}` : 'no falta nada: listo para merge'}`;
};

function previewText(x, { opened } = {}) {
  const head = `Vista previa del PR #${x.pr}${x.sha ? ` (commit ${x.sha.slice(0, 7)})` : ''}: ${PHASE_WORD[x.phase] ?? x.phase}`;
  const env = x.missingEnv?.length ? `\n  Faltan variables: ${x.missingEnv.slice(0, 8).join(', ')}${x.missingEnv.length > 8 ? ` y ${x.missingEnv.length - 8} más` : ''}. Súbelas con ghosty-dev env push (entran en el siguiente armado).` : '';
  if (x.phase === 'ready')
    return (x.url ? `${head}\n${opened ? '  Abierta en tu navegador.' : `  ${x.url}`}` : `${head}, pero Ghosty Studio no mandó una liga válida.${x.page ? ` Ábrela en ${x.page}` : ''}`) + env;
  if (x.phase === 'failed') return `${head}${x.error ? `\n  ${x.error}` : ''}${x.page ? `\n  Detalle: ${x.page}` : ''}`;
  if (x.phase === 'none') return `${head}. ${x.message ?? 'Se arma sola con el siguiente push (PR no borrador).'}`;
  return `${head}. Espérala: ghosty-dev preview ${x.pr} --wait`;
}

// «Depende de #N» al día en la descripción del PR (src/deps.mjs). Lo hacen solos preview y wait: nunca detiene el
// comando, y sólo avisa por stderr cuando cambió algo.
function autoDeps(pr) {
  try {
    const r = syncDeps(pr);
    if (r.added.length) console.error(`Agregué a la descripción del PR #${pr}: ${r.added.map((n) => `Depende de #${n}`).join(', ')}.`);
    if (r.removed.length) console.error(`Quité de la descripción del PR #${pr}: ${r.removed.map((n) => `Depende de #${n}`).join(', ')} (ya entró).`);
  } catch {}
}

// Un PR en `show --pr <m>` o en `show <m>` cuando <m> es PR (`note` arriba: no es un pendiente).
async function printPr(r, note) {
    r.preview = await previewSummary(r.pr);
    print(r, (x) =>
      [
        ...(note ? [note] : []),
        `PR #${x.pr} ${x.title}`,
        ...(x.conflict ? [`  CONFLICTO, primero esto: ${cmd.conflictLine(x.pr, x.conflict)}`] : []),
        `  estado: ${x.state}`,
        `  rama: ${x.branch ?? '—'}`,
        `  cierra: ${x.closes.map((c) => '#' + c).join(', ') || `— (no está ligado a un pendiente: ${cmd.linkHint(x.pr)})`}`,
        `  ${x.url}`,
        ...previewLine(x.preview),
        ...servicesBlock(x.services),
        ...(x.ficha ? ['', x.ficha] : []),
      ].join('\n'),
    );
}

function print(data, human) {
  if (values.json) console.log(JSON.stringify(data, null, 2));
  else console.log(human(data));
}

try {
  if (values.help || !command || command === 'help') {
    console.log(HELP);
  } else if (command === 'init') {
    const dir = resolve(values.dir ?? process.cwd());
    // Antes de escribir nada: a qué repo y rama va (con --json, a stderr para no ensuciar la salida).
    const t = cmd.initTarget(dir);
    const say = values.json ? console.error : console.log;
    say(`Repo: ${t.repo} · rama actual: ${t.branch ?? '?'} (principal: ${t.defaultBranch})`);
    if (!values['dry-run'] && t.branch !== t.defaultBranch && !values.yes)
      throw new cmd.UserError(`Estás en la rama ${t.branch ?? '(sin rama)'}, no en ${t.defaultBranch}: la instalación va directo a la rama principal. Cámbiate (git switch ${t.defaultBranch}) o, si es a propósito, ghosty-dev init --yes.`);
    // Las etiquetas se crean en GitHub en el acto: se confirman (o --yes). Sin terminal y sin --yes, no se crean.
    let labels = true;
    if (t.labelsToCreate.length && !values['dry-run'] && !values.yes) {
      const what = `${t.labelsToCreate.length} etiqueta(s) en ${t.repo} (${t.labelsToCreate.join(', ')})`;
      if (process.stdin.isTTY && !values.json) {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        labels = /^(s|si|sí|y|yes)$/i.test((await rl.question(`Voy a crear ${what}. ¿Sigo? [s/N] `)).trim());
        rl.close();
      } else labels = false;
      if (!labels) console.error(`No creé ${what}: confírmalo con ghosty-dev init --yes.`);
    } else if (t.labelsToCreate.length) say(`${values['dry-run'] ? 'Crearía' : 'Creo'} ${t.labelsToCreate.length} etiqueta(s) en ${t.repo}.`);
    const plan = cmd.init(dir, { dryRun: values['dry-run'], force: values.force, protectBranch: !values['no-protect'], labels });
    // El push de la instalación va a la rama principal: qué workflows dispara (en un repo de producción, el deploy).
    plan.push({
      action: 'push',
      name: t.pushWorkflows.length
        ? `un push a ${t.defaultBranch} dispara: ${t.pushWorkflows.map((w) => `${w.file}${w.name ? ` («${w.name}»)` : ''}${w.paths ? ' si cambian sus paths' : ''}`).join(', ')}`
        : `un push a ${t.defaultBranch} no dispara ningún workflow de .github/workflows`,
      workflows: t.pushWorkflows,
    });
    print(plan, (p) =>
      [values['dry-run'] ? `Ensayo en seco en ${dir} (no se escribe nada):` : `Bitácora instalada en ${dir}:`]
        .concat(p.map((x) => `  ${x.action.padEnd(6)} ${x.name ?? x.path}`))
        .join('\n'),
    );
  } else if (command === 'protect' && values['dry-run']) {
    const r = cmd.protectPreview(process.cwd());
    print(r, (x) =>
      [
        `${x.repo}: ghosty-dev/evidencia ${x.already ? 'ya es obligatorio' : 'se volvería obligatorio'} en ${x.branch}.${x.gateOnBase ? '' : ` Todavía no se puede: la puerta no está en ${x.branch}.`}`,
        x.blocked.length ? `Quedarían bloqueados ${x.blocked.length} PR abierto(s):` : 'Ningún PR abierto quedaría bloqueado.',
        ...x.blocked.map((b) => `  #${b.pr} ${b.title}\n${b.reasons.map((l) => `    - ${l}`).join('\n')}`),
        ...(x.drafts.length ? ['Borradores (no se bloquean hasta marcarlos listos):', ...x.drafts.map((d) => `  #${d.pr} ${d.title}`)] : []),
        ...(x.informative.length ? ['Fuera de la bitácora (pasan con aviso por "unlinked": "warn"; ligarlos: ghosty-dev claim --pr <m> --issue <n>):', ...x.informative.map((d) => `  #${d.pr} ${d.title}`)] : []),
        ...(x.passing.length ? [`Pasan ya: ${x.passing.map((p) => '#' + p.pr).join(', ')}`] : []),
        'No se cambió nada.',
      ].join('\n'),
    );
  } else if (command === 'protect') {
    const r = cmd.protect(process.cwd());
    if (!r.ok) throw new cmd.UserError(r.later ? `La puerta todavía no está en ${r.branch}: sube los archivos de init directo a ${r.branch} y vuelve a correr ghosty-dev protect.` : `${r.reason}. Márcalo en Settings → Branches.`);
    if (values.json) print(r, () => '');
    else await showBanner(r);
  } else if (command === 'review' && values.check) {
    print(cmd.checkReview(values.file), (x) => `Revisión válida: ${x.open} hallazgo(s) abierto(s). No se publicó nada.`);
  } else if (command === 'evidence' && values.check) {
    print(cmd.checkEvidence(values.file, values['issue-file']), (x) =>
      `Evidencia válida${x.criteriaChecked ? '' : ' (sin comparar criterios: falta --issue-file)'}. No se publicó nada.`,
    );
  } else if (command === 'review') {
    const r = cmd.review(num(arg), { file: values.file, pr: values.pr === undefined ? undefined : num(values.pr, '--pr <m>') });
    if (r.brief) print(r, (x) => x.brief);
    else print(r, (x) => `Revisión publicada en #${x.number} (commit ${x.sha.slice(0, 7)}): ${x.open} hallazgo(s) abierto(s).${x.url ? `\n  ${x.url}` : ''}`);
  } else if (command === 'board') {
    const r = cmd.board();
    print(r, (x) => `Pendientes abiertos en el navegador: ${x.url}`);
  } else if (command === 'add') {
    const r = cmd.add(arg, {
      goal: values.goal,
      criteria: values.criteria ?? [],
      context: values.context,
      blockedBy: values.by ? num(values.by, '--by <m>') : undefined,
      discoveredIn: values.from ? num(values.from, '--from <n>') : undefined,
    });
    print(r, (x) => `Pendiente #${x.number} abierto: ${x.title}${x.blockedBy ? ` (bloqueado por #${x.blockedBy})` : ''}\n  ${x.url}${x.board ? `\n  Tablero abierto en el navegador: ${x.board}` : ''}`);
  } else if (command === 'ready') {
    const list = cmd.ready();
    if (values.claim) {
      if (!list.length) throw new cmd.UserError('No hay pendientes listos.');
      const first = list[0];
      // Los que esperaban CI ya son tuyos: sólo se retoman, no se vuelven a reclamar.
      if (values.cloud) {
        const next = list.find((i) => i.state !== 'esperando');
        if (!next) throw new cmd.UserError('No hay pendientes listos para mandar a la nube.');
        if (await confirmCloud({ n: next.number }, `ghosty-dev claim ${next.number} --cloud${values.workspace ? ` --workspace ${values.workspace}` : ''} --yes`)) printCloud(await cloud.start(next.number, { workspace: values.workspace }));
        process.exit(process.exitCode ?? 0);
      }
      const result = first.state === 'esperando' ? { ...first, resumed: true } : cmd.claim(first.number, { worktree: !values['no-worktree'], base: values.base, onWarning: (w) => console.error(`Aviso: ${w}`) });
      print(result, (r) => `Tomado #${r.number} ${r.title}${r.worktree ? `\n  worktree: ${r.worktree}\n  rama: ${r.branch}` : ''}${r.resumed ? `\n  retoma: ${r.reason}` : ''}`);
    } else {
      print(list, (l) => (l.length ? l.map((i) => `#${i.number}\t${i.reason}\t${i.title}`).join('\n') : 'No hay pendientes listos.'));
      // Lo que vive fuera de la bitácora se avisa (stderr: no ensucia el --json), con el comando que lo liga.
      const lock = cmd.repoLock();
      if (lock && !lock.ok) console.error(`Aviso: ${lock.message}`);
      for (const p of cmd.unlinkedPrs()) console.error(`Aviso: el PR #${p.number} no está ligado a un pendiente: ${cmd.linkHint(p.number)}`);
      for (const p of cmd.openPrs().filter((x) => !x.draft).slice(0, 20)) {
        const c = cmd.conflictOf(p.number, { tries: 1 });
        if (c) console.error(`Aviso: ${cmd.conflictLine(p.number, c)}`);
      }
    }
  } else if (command === 'claim' && values.cloud) {
    const pr = values.pr === undefined ? undefined : num(values.pr, '--pr <m>');
    const n = arg === undefined && pr ? undefined : num(arg);
    const retry = `ghosty-dev claim${n ? ` ${n}` : ''} --cloud${pr ? ` --pr ${pr}` : ''}${values.workspace ? ` --workspace ${values.workspace}` : ''} --yes`;
    if (await confirmCloud({ n, pr }, retry)) printCloud(await cloud.start(n, { pr, workspace: values.workspace }));
  } else if (command === 'claim' && values.pr !== undefined) {
    // Adoptar lo que ya existe: un PR abierto queda como el trabajo del pendiente, sin rama ni worktree nuevos.
    const n = num(values.issue ?? arg, '--issue <n>');
    const r = cmd.adopt(n, num(values.pr, '--pr <m>'));
    print(r, (x) => `Tomado #${x.number} ${x.title} con el PR #${x.pr} (rama ${x.branch}).${x.linked ? `\n  Agregué «Closes #${x.number}» a la descripción del PR.` : ''}${x.alsoCloses.length ? `\n  Ese PR también cierra ${x.alsoCloses.map((c) => '#' + c).join(', ')}.` : ''}\n  Sigue: ghosty-dev next`);
  } else if (command === 'cloud') {
    print(await cloud.list(), (l) => (l.length ? l.map((r) => `#${r.number}\t${r.state}\t${r.title}${r.pr ? `\t${r.pr}` : ''}`).join('\n') : 'No hay pendientes de este repo en la nube.'));
  } else if (command === 'stop') {
    print(await cloud.stop(num(arg)), (r) => `#${r.number} detenido en la nube. El issue y la rama se quedan.`);
  } else if (command === 'teleport') {
    print(await cloud.teleport(num(arg)), (r) => `#${r.number} ya no va en la nube.${r.branch ? `\n  rama: ${r.branch}\n  Sigue aquí: ghosty-dev claim ${r.number}` : ''}`);
  } else if (command === 'claim') {
    const r = cmd.claim(num(arg), { worktree: !values['no-worktree'], base: values.base, onWarning: (w) => console.error(`Aviso: ${w}`) });
    print(r, (x) => `Tomado #${x.number} ${x.title}\n  rama: ${x.branch}${x.base ? ` (parte de ${x.base})` : ''}${x.worktree ? `\n  worktree: ${x.worktree}` : ''}`);
  } else if (command === 'wait' && values.pr === undefined) {
    // Aviso en vivo (stderr, para no ensuciar el --json) cuando la vista previa o la revisión terminan.
    const onService = (key, s) => console.error(serviceLine(key, s).trim());
    // Esperar = ya empujó: la tarjeta regresa a «En revisión».
    await writer.beat(num(arg), 'pushed');
    const r = await cmd.wait(num(arg), { watch: values.watch, minutes: values.minutes ? Number(values.minutes) : undefined, onService });
    if (r.pr) autoDeps(Number(String(r.pr).split('/').pop()));
    // Lo despertó un pedido o el CI salió rojo: le toca corregir (la tarjeta vuelve a «Escribiendo»).
    if (r.asks?.length) await writer.beat(num(arg), 'working', `pedido: ${r.asks[0].text}`);
    else if (values.watch && !r.timedOut && r.ci && !['verde', 'sin-pr', 'sin-checks'].includes(r.ci)) await writer.beat(num(arg), 'working', `CI ${r.ci}`);
    print(r, (x) =>
      x.asks?.length
        ? `#${x.number}: la persona pidió:\n${x.asks.map((a) => `  - ${a.text}${a.by ? ` (@${a.by})` : ''}`).join('\n')}\nHazlo en la misma rama y vuelve a subir.`
        : !values.watch || x.timedOut
        ? `#${x.number} esperando el CI. Toma otro pendiente o termina: ghosty-dev ready te lo ofrece cuando resuelva.`
        : x.ci === 'sin-pr'
          ? `#${x.number} no tiene PR abierto todavía.`
          : x.ci === 'sin-checks'
            ? `#${x.number}: el commit actual del PR no tiene checks (¿el repo tiene CI en pull_request?). No es verde.`
            : [`#${x.number}: CI ${x.ci}.${x.ci === 'verde' ? ' Pide la revisión (subagente ghosty-dev-revisor).' : ' Arréglalo y vuelve a subir.'}`, ...servicesBlock(x.services)].join('\n'),
    );
  } else if (command === 'asks') {
    const r = cmd.asks(num(arg), { peek: values.peek });
    // Tomó el pedido: está corrigiendo.
    if (!values.peek && r.asks.length) await writer.beat(num(arg), 'working', `pedido: ${r.asks[0].text}`);
    print(r, (x) =>
      [x.asks.length ? x.asks.map((a) => `- ${a.text}${a.by ? ` (@${a.by})` : ''}`).join('\n') : `#${x.number}: sin pedidos nuevos.`]
        .concat(x.stale.length ? [`Obsoletos (avisos del bot que ya no aplican a la cabeza del PR; no hay que hacerlos):`, ...x.stale.map((a) => `  - ${a.reason}: ${a.text.split('\n')[0].slice(0, 120)}`)] : [])
        .join('\n'),
    );
  } else if (command === 'evidence') {
    const r = cmd.evidence(num(arg), values.file, { pr: values.pr === undefined ? undefined : num(values.pr, '--pr <m>') });
    print(r, (x) => `Evidencia publicada en #${x.number}${x.url ? `: ${x.url}` : ''}.${x.rerun ? ` Puerta del PR re-ejecutada (run ${x.rerun}).` : ''}`);
  } else if (command === 'block') {
    const r = cmd.block(num(arg), num(values.by, '--by <m>'));
    print(r, (x) => `#${x.number} bloqueado por #${x.blockedBy} (${x.via === 'github' ? 'dependencia nativa de GitHub' : 'lista en el cuerpo'}).`);
  } else if (command === 'show' && values.pr !== undefined) {
    await printPr(cmd.showPr(num(values.pr, '--pr <m>')));
  } else if (command === 'preview' && shares.SHARE_OPS.includes(arg)) {
    // share|unshare|requests [<pr>] · accept|reject <id> [--pr <m>]. Sin PR: el de tu rama.
    const decision = arg === 'accept' || arg === 'reject';
    const prRaw = decision ? values.pr : arg2 ?? values.pr;
    const pr = prRaw === undefined ? previews.currentPr() : num(prRaw, '<pr>');
    if (arg === 'share' || arg === 'unshare') print(await shares.share(arg, pr), shares.shareText);
    else if (arg === 'requests') print(await shares.requests(pr, { status: values.status ?? 'pending' }), shares.requestsText);
    else print(await shares.decide(arg, pr, arg2), shares.decideText);
  } else if (command === 'preview') {
    const pr = arg === undefined ? undefined : num(arg, '<pr>');
    // Los avisos (commit viejo, falta push) van a stderr y nunca llevan la liga.
    autoDeps(pr ?? previews.currentPr());
    const r = await previews.preview(pr, { wait: values.wait, onNote: (n) => console.error(n) });
    if (r.url && values.open) auth.openBrowser(r.url);
    print(r, (x) => previewText(x, { opened: values.open }));
    process.exitCode = previews.exitCodeOf(r);
  } else if (command === 'doctor') {
    const doctor = await import('../src/doctor.mjs');
    const top = cmd.repoTop();
    if (!top) throw new cmd.UserError('doctor se corre dentro de un clon de git.');
    // Sólo nombres de gs; sin sesión o sin el repo conectado se sigue sin ellos (y se dice).
    let saved = null;
    try {
      saved = (await envVars.ls()).saved;
    } catch {}
    // Lo que vio la caja de la preview del PR de esta rama (con `registered`), si hay.
    let previewOAuth = null;
    let previewMissingEnv = null;
    let previewMissingEnvTouched = [];
    try {
      const pr = values.pr !== undefined ? num(values.pr, '--pr <m>') : previews.currentPr();
      if (pr) {
        const p = await previews.fetchPreview(pr);
        previewOAuth = doctor.parsePreviewOAuth(p.oauth);
        previewMissingEnv = p.missingEnv;
        previewMissingEnvTouched = p.missingEnvTouched;
      }
    } catch {}
    const r = { repo: cmd.repoFullName(), ...doctor.diagnose(top, { saved, catalog: await doctor.fetchCatalog(), previewOAuth, previewMissingEnv, previewMissingEnvTouched }) };
    if (r.oauth) delete r.oauth.helperJs;
    print(r, doctor.doctorText);
    if (r.checks.some((c) => c.ok === false)) process.exitCode = 1;
  } else if (command === 'check-lock') {
    // Lo corre el hook pre-push (ghosty-dev init): bloquea el push si el lock no coincide con package.json.
    const r = cmd.repoLock() ?? { ok: true, problems: [] };
    print(r, (x) => (x.ok ? (x.lock ? `${x.lock} coincide con package.json.` : 'Sin lock que comparar.') : x.message));
    if (!r.ok) process.exitCode = 1;
  } else if (command === 'next' || command === 'status') {
    const r = cmd.next();
    print(r, (x) => `Siguiente paso: ${x.step}${x.command ? `\n  ${x.command}` : ''}\n  por qué: ${x.why}`);
  } else if (command === 'deps') {
    const pr = arg === undefined ? previews.currentPr() : num(arg, '<pr>');
    const r = syncDeps(pr);
    print(r, (x) =>
      [`PR #${x.pr}: ${x.dependsOn.length ? `depende de ${x.dependsOn.map((n) => '#' + n).join(', ')}` : 'no depende de otro PR abierto'}.`]
        .concat(x.added.length ? [`  agregué: ${x.added.map((n) => `Depende de #${n}`).join(', ')}`] : [])
        .concat(x.removed.length ? [`  quité: ${x.removed.map((n) => `Depende de #${n}`).join(', ')}`] : [])
        .join('\n'),
    );
  } else if (command === 'box') {
    // Lo que va después de `--` es el comando de exec; antes, `box <op> [<pr>]`.
    const dd = process.argv.indexOf('--', 2);
    const cmdParts = dd === -1 ? [] : process.argv.slice(dd + 1);
    const pre = positionals.slice(0, positionals.length - cmdParts.length);
    const op = pre[1];
    if (!boxes.OPS.includes(op)) throw new cmd.UserError(`Uso: ghosty-dev box ${boxes.OPS.join('|')} [<pr>] (exec: -- <comando…>)`);
    if (op !== 'exec' && cmdParts.length) throw new cmd.UserError('Sólo box exec lleva un comando después de --.');
    const pr = pre[2] === undefined ? previews.currentPr() : num(pre[2], '<pr>');
    const r = await boxes.box(op, pr, { cmd: cmdParts.length ? boxes.shellJoin(cmdParts) : undefined, lines: values.lines });
    print(r, (x) => {
      const tail = x.text.replace(/\n+$/, '');
      if (x.op === 'rebuild') return `Rearmando la vista previa del PR #${x.pr}${x.sha ? ` (commit ${x.sha.slice(0, 7)})` : ''}. Síguela: ghosty-dev preview ${x.pr} --wait`;
      if (x.op === 'restart') return `${tail ? `${tail}\n` : ''}App de la caja del PR #${x.pr} reiniciada${x.exitCode ? ` (salió ${x.exitCode})` : ''}.`;
      return tail || (x.op === 'logs' ? '(el log está vacío)' : '');
    });
    if (!values.json && op === 'exec' && r.exitCode) console.error(`(el comando salió con ${r.exitCode})`);
    process.exitCode = boxes.exitCodeOf(r);
  } else if (command === 'wait' && values.pr !== undefined) {
    const minutes = values.minutes === undefined ? 10 : Number(values.minutes);
    if (!Number.isFinite(minutes) || minutes < 0) throw new cmd.UserError('--minutes va en minutos (default 10).');
    const onChange = (s) => console.log(values.json ? JSON.stringify({ event: 'state', ...s }) : prStateLine(s));
    autoDeps(num(values.pr, '--pr <m>'));
    const r = await waitPr(num(values.pr, '--pr <m>'), { until: values.until ?? 'any', minutes, onChange });
    console.log(
      values.json
        ? JSON.stringify({ event: 'done', ...r })
        : r.timedOut
          ? `Se acabó el tiempo y no ha pasado (${r.until}).${r.stuck ? ` ${r.stuck.hint}` : ''} Vuelve a correr: ghosty-dev wait --pr ${r.pr} --until ${r.until}`
          : r.exitCode
            ? `Listo (${r.until}): ${r.preview.phase === 'failed' ? 'la vista previa falló → ghosty-dev box logs ' + r.pr : 'el CI salió rojo'}.`
            : `Listo (${r.until}).`,
    );
    process.exitCode = r.exitCode;
  } else if (command === 'show') {
    const r = cmd.show(num(arg));
    if (r.kind === 'pr') {
      await printPr(r, `#${r.pr} es un PR, no un pendiente${r.closes.length ? `: cierra ${r.closes.map((c) => '#' + c).join(', ')} (ghosty-dev show ${r.closes[0]})` : ''}.`);
    } else {
      if (!r.pr && r.state !== 'cerrado') r.hint = `#${r.number} no tiene PR que lo cierre; si el PR ya existe: ghosty-dev claim --pr <m> --issue ${r.number}`;
      r.preview = r.pr ? await previewSummary(Number(r.pr.split('/').pop())) : null;
      print(r, (x) =>
        [
          `#${x.number} ${x.title}`,
          `  estado: ${x.state ?? 'sin etiqueta de bitácora'}`,
          `  escritor: ${x.assignees.join(', ') || '—'}`,
          `  bloqueado por: ${x.blockedBy.map((b) => '#' + b).join(', ') || '—'}`,
          `  evidencia: ${x.evidence ? 'sí' : 'no'}`,
          `  pedidos nuevos: ${x.asks.length ? x.asks.map((a) => a.text).join(' · ') : '—'}`,
          ...(x.pr ? [`  PR: ${x.pr}`] : x.hint ? [`  PR: — (${x.hint})`] : []),
          ...previewLine(x.preview),
          ...servicesBlock(x.services),
          ...(x.ficha ? ['', x.ficha] : []),
        ].join('\n'),
      );
    }
  } else if (command === 'close') {
    const r = cmd.close(num(arg));
    print(r, (x) => `#${x.number} cerrado con evidencia.`);
  } else if (command === 'login' && !values.wait && !values.force && (existing = await auth.existingSession())) {
    // Ya hay credenciales (GHOSTY_DEV_TOKEN o sesión vigente/renovable): no se inicia otro login.
    print(existing, (x) => `Ya hay sesión de Ghosty Studio${x.source === 'env' ? ' (GHOSTY_DEV_TOKEN)' : x.email ? ` como ${x.email}` : ''}; no hace falta login. Para cambiar de cuenta: ghosty-dev logout.`);
  } else if (command === 'login' && values['no-wait']) {
    // Paso 1 para agentes: liga + código y sale ya; la persona aprueba y el agente sigue con --wait.
    const r = await auth.loginStart();
    print(r, (x) => `Pásale a la persona esta liga y el código ${x.user_code} (vence ${x.expires_at}):\n  ${x.verification_uri_complete}\nCuando diga que ya: ghosty-dev login --wait`);
  } else if (command === 'login' && values.wait) {
    const timeoutSec = values.timeout === undefined ? 90 : Number(values.timeout);
    if (!Number.isFinite(timeoutSec) || timeoutSec < 0) throw new cmd.UserError('--timeout va en segundos (default 90).');
    const r = await auth.loginWait({ timeoutSec });
    if (r.status === 'pending') {
      print(r, (x) => `Todavía no se aprueba el código ${x.user_code} (${x.verification_uri_complete}). Vuelve a correr: ghosty-dev login --wait`);
      process.exitCode = auth.PENDING_EXIT; // sin process.exit: que stdout termine de salir por el pipe
    } else print(r, (x) => `Sesión de Ghosty Studio lista${x.email ? ` como ${x.email}` : ''} (vence ${x.expiresAt}; se renueva sola).`);
  } else if (command === 'login') {
    // Sin terminal o con --json quien corre es un agente: nunca se abre el navegador, y la liga sale en la PRIMERA
    // línea antes de sondear (en --json como evento de una línea).
    // GHOSTY_DEV_ASSUME_TTY=1 lo desactiva (sólo para probar el loopback sin terminal).
    const agent = values.json || (!process.env.GHOSTY_DEV_ASSUME_TTY && (!process.stdin.isTTY || !process.stdout.isTTY));
    const onPrompt = (p) =>
      process.stdout.write(
        values.json
          ? JSON.stringify({ event: 'login_url', ...p }) + '\n'
          : p.method === 'device'
            ? `Abre ${p.url} y confirma el código ${p.code}\n`
            : `Abriendo tu navegador para entrar a Ghosty Studio. Si no se abre: ${p.url}\n`,
      );
    const r = await auth.login({ device: values.device, agent, onPrompt });
    print(r, (x) => `Sesión de Ghosty Studio lista${x.email ? ` como ${x.email}` : ''} (vence ${x.expiresAt}; se renueva sola).`);
  } else if (command === 'logout') {
    const r = await auth.logout();
    print(r, (x) =>
      [x.loggedOut ? `Sesión cerrada${x.revoked ? ' y revocada en Ghosty Studio' : ' (no se pudo revocar en el servidor; el archivo local ya se borró)'}.` : 'No había sesión guardada.']
        .concat(x.envToken ? ['GHOSTY_DEV_TOKEN sigue puesto: ese token no lo maneja logout.'] : [])
        .join('\n'),
    );
  } else if (command === 'whoami') {
    const r = await auth.whoami();
    print(r, (x) => `${x.email ?? 'Sesión activa'} en ${x.base}${x.expiresAt ? ` (vence ${x.expiresAt}; se renueva sola)` : ''}\n  sesión: ${x.source === 'env' ? 'GHOSTY_DEV_TOKEN' : x.path}${x.scope ? `\n  permisos: ${x.scope}` : ''}`);
  } else if (command === 'env' && arg === 'ls') {
    const r = await envVars.ls();
    print(r, (x) =>
      [
        `${x.repo}${x.workspace ? ` · espacio ${x.workspace}` : ''}`,
        `  guardadas: ${x.saved === null ? 'no se pudieron leer' : x.saved.join(', ') || '—'}`,
        `  faltan: ${x.missing.join(', ') || '—'}`,
        ...x.risks.map((k) => `  riesgo: ${k.key}: ${k.risk}`),
        ...x.blocked.map((b) => `  pedido ${b.id} bloqueado por: ${b.keys.join(', ') || 'variables sin nombre'}`),
        x.canWrite ? '  Guárdalas con: ghosty-dev env push <archivo>' : '  Sólo el dueño del espacio guarda variables.',
      ].join('\n'),
    );
  } else if (command === 'env' && arg === 'push') {
    const p = await envVars.plan(arg2, { replace: values.replace });
    // El resumen (ruta y nombres, nunca valores) va a stderr con --json, para no ensuciar la salida.
    (values.json ? console.error : console.log)(envVars.planText(p));
    if (!values.yes) {
      const retry = `ghosty-dev env push ${arg2}${values.replace ? ' --replace' : ''} --yes`;
      if (!process.stdin.isTTY) throw new cmd.UserError(`Sin terminal para confirmar. Si la persona ya lo aprobó: ${retry}`);
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const answer = await rl.question(`¿Guardar ${p.keys.length} variable(s) en ${p.repo}? [s/N] `);
      rl.close();
      if (!/^(s|si|sí|y|yes)$/i.test(answer.trim())) throw new cmd.UserError('No se guardó nada.');
    }
    const r = await envVars.push(p);
    print(r, (x) =>
      [`Guardadas en ${x.repo}${x.workspace ? ` (espacio ${x.workspace})` : ''}: ${x.keys.join(', ') || '—'}`]
        .concat(x.kept?.length ? [`  se quedaron: ${x.kept.join(', ')}`] : [])
        .concat(x.dropped?.length ? [`  descartadas: ${x.dropped.join(', ')}`] : [])
        .concat(x.risks.map((k) => `  riesgo: ${k.key}: ${k.risk}`))
        .join('\n'),
    );
  } else if (command === 'env') {
    throw new cmd.UserError('Uso: ghosty-dev env ls | ghosty-dev env push <archivo> [--replace] [--yes]');
  } else {
    throw new cmd.UserError(`Comando desconocido: ${command}. Usa ghosty-dev --help.`);
  }
} catch (e) {
  console.error(e instanceof cmd.UserError || e instanceof auth.AuthError || e instanceof cloud.CloudError ? e.message : `Error: ${auth.plain(e.message)}`);
  process.exit(1);
}
