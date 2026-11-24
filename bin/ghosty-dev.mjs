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
import * as factory from '../src/factory.mjs';
import { waitPr } from '../src/watch.mjs';
import { syncDeps } from '../src/deps.mjs';
import { createInterface } from 'node:readline/promises';
import { git } from '../src/gh.mjs';
import { parseRef, hasRepo, sameRepo, fmtRef, repoOfDir, findCheckout, cloneCommand } from '../src/ref.mjs';
const HELP = `ghosty-dev — el trabajo vive en la bitácora, no en la sesión

Uso: ghosty-dev <comando> [opciones]

  Referencias: todo <n> acepta n, #n u owner/repo#n (patrón de GitHub). Con otro repo el comando corre en su clon local
  (cwd, ~/ y GHOSTY_DEV_REPOS); sin clon, claim/teleport dicen cómo clonarlo. add --repo owner/repo abre el pendiente allá
  (enlace cruzado en ambos lados); --from y --by también entienden owner/repo#n.

  init [--dir D] [--dry-run] [--force] [--no-protect] [--files-only] [--no-checks] [--yes]
                                         --no-checks: no escribe .github/workflows/ghosty-checks.yml (CI extra que no es de la puerta;
                                         el PR de preparación sólo toca la puerta)
                                         --files-only: SÓLO escribe archivos (sin gh, sin etiquetas ni protección): para una caja
                                         sin credenciales; se sube con commit + PR y la persona corre luego init y protect
                                         etiquetas, plantilla, Action de evidencia, skill, AGENTS.md
                                         (protege la rama sólo si la puerta ya está en ella). Dice repo y rama antes
                                         de escribir (fuera de la rama principal pide --yes), confirma las etiquetas
                                         (sin terminal, sólo con --yes) y lista los workflows que dispara el push
  protect [--dry-run]                    vuelve obligatorio ghosty-dev/evidencia en la rama principal; --dry-run
                                         lista los PR abiertos que quedarían bloqueados y por qué
  confirm <n> --criterion <i> [--note "…"]
                                         verificación de la persona: confirma el criterio i (1 = el primero) que la evidencia
                                         declaró «- [~] … — verificación de la persona: …». Sólo con permiso de escritura;
                                         deja un comentario de rastro (quién, cuándo, nota) y vuelve a correr la puerta
  add "título" --goal G --criteria C…    abre un pendiente (--criteria se repite; --by <m> si lo bloquea #m;
                                         --context, --from <n> si lo descubriste trabajando #n)
  criteria <n> [--set <i> "texto" --reason "…"]
                                         sin --set lista los criterios de #n; con --set cambia SÓLO el criterio i (1 = el
                                         primero, conserva su casilla) y deja un comentario con quién, cuándo, el texto
                                         anterior, el nuevo y el motivo. Para un criterio que no se puede cumplir: se
                                         enmienda con rastro, nunca se marca ni se edita a escondidas
  review <n> [--pr <m>] [--file r.md]    sin --file: el encargo para el revisor (otra sesión, contexto limpio);
                                         con --file: el revisor publica su revisión atada al commit del PR
  board                                  abre en el navegador los pendientes abiertos del repo
  factory [status] [--all]               ¿trabaja la fábrica de este repo? (encendida, en pausa hasta…, horario)
  factory pause [--until ISO] [--reason "…"] [--all]
                                         pausa la fábrica (sin --until, hasta que la reanuden): nada nuevo arranca,
                                         lo que corre termina. --all = todos tus repos
  factory resume [--all]                 la reanuda: arranca lo que quedó en fila
  factory schedule <day|night|weekdays|"cron"> [--timezone Z] [--all]
                                         horario (day 8–22, night 22–8, weekdays sin fines de semana, o un cron de
                                         las horas en que SÍ trabaja; zona por defecto CDMX). Con la fábrica en pausa,
                                         next, claim y asks se detienen con la línea de la pausa y salen 6
  next (o status) [--json]               el siguiente paso correcto según el estado del repo, con el comando exacto
                                         (empieza por aquí tras compactar o retomar una sesión)
  ready [--json] [--claim] [--cloud]     pendientes que se pueden tomar ahora (sin bloqueo, o CI ya resuelto);
                                         avisa los PR abiertos que no están ligados a un pendiente
  claim <n> [--no-worktree] [--base B]   te asigna el pendiente y crea su rama y worktree desde origin/main (o B)
                                         si el repo no está preparado (puerta, revisor Ghosty Review, protección) NO arranca:
                                         abre «Preparar el repo para ghosty-dev» (una vez), bloquea #n por él y sale 7;
                                         --skip-readiness lo salta. doctor muestra el detalle («puerta-…»)
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
  tell <n> "mensaje" | --file m.md | -   le manda un mensaje al escritor de #n en la nube (si preguntó, es la
                                         respuesta; si trabaja, un aviso; si está detenido, lo reanuda); - lee stdin
  tell <n> --again                       «otra vuelta»: el escritor reintenta sin mensaje nuevo
  reopen <n>                             retoma #n si lo detuvieron y su PR sigue abierto (misma rama, caja nueva)
  release <n>                            #n sigue sin esperar el PR que lo bloqueaba (no cierra nada)
  recover [--start] [--pr m,n]           PRs de este repo cerrados sin merge con su rama viva; con --start Ghosty los
                                         retoma sobre su misma rama con un PR NUEVO (reabre su issue; el PR viejo no)
  claim <n> --cloud                     si llevas trabajo aquí (cambios o commits sin subir) lo sube a ghosty-dev/<n>-traspaso
                                         (commit «WIP: traspaso a la nube») y la nube sigue desde ahí; --no-handoff lo salta
  claim <n> --cloud --reopen             con un issue cerrado cuyo trabajo nunca entró a main: lo reabre y lo manda
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
  block <n> --reason "…"                 #n queda bloqueado con su motivo (comentario en el issue y su PR; el tablero
                                         lo enseña). Úsalo si la verificación real falla y no lo puedes arreglar ahora.
                                         --person: le toca a la persona (credencial, acceso, decisión) → «Te necesita»
  unblock <n>                            quita el bloqueo con motivo (el tablero vuelve a su estado)
  add … --flow "qué y cómo"              el flujo principal que se probará con sesión (va en la evidencia)
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
  preview [<pr>] --with <m>[,<k>] [--wait] [--open] [--down]
                                         vista previa COMBINADA (este PR + otros, sin rama ni PR borrador): gs mezcla
                                         los heads sobre la base en una caja que se borra sola en 2 h; si chocan, dice
                                         en qué archivos. --down la quita antes
  preview [<pr>] --login [--path /x] [--open]  liga de UN solo uso (10 min) que entra con sesión de prueba
                                         (identidad de servicio de Ghosty); con --check, prueba de punta a punta:
                                         entrar, cerrar sesión, que no se reabra, volver a entrar [--logout
                                         "POST /api/login intent=logout"] [--relogin "…"] (o logout:/relogin:
                                         en .ghosty/factory.md)
  preview share [<pr>]                   liga pública para alguien sin cuenta (la única vez que se imprime)
  preview unshare [<pr>]                 la revoca; quien la abra puede pedir acceso
  preview requests [<pr>] [--status pending|accepted|rejected|all]
  preview accept|reject <id> [--pr <m>]  decide una solicitud de acceso
  doctor [--path /x]                     lo que va a fallar en la vista previa: lock, llaves y callback de OAuth;
                                         con la vista previa lista, prueba de verdad el login (ruta: --path o
                                         login_path: de .ghosty/factory.md, si no /dashboard)
  check-lock                             ¿el lock (npm/pnpm/yarn) coincide con package.json en HEAD? Lo corre el pre-push
                                         (y si el push toca rutas o módulos de servidor/cliente, sugiere correr el build)
  update                                 reinstala ghosty-dev desde la fuente oficial (npm install -g github:blissito/ghosty-dev)
                                         y dice versión vieja → nueva
  box rebuild [<pr>]                     rearma la vista previa del último commit (síguela con preview --wait)
  deps [<pr>]                            escribe «Depende de #N» en la descripción si el PR va apilado sobre otro PR
                                         abierto (o trae su commit) y la quita cuando ése entra; preview y wait lo
                                         hacen solos
  wait --pr <m> [--until preview|ci|review|any] [--minutes 10]
                                         espera por PR, sin pendiente: hasta que la vista previa, el CI o la revisión
                                         del último commit terminen (any: el primer cambio). Un renglón (JSON con
                                         --json) por cambio; sale 0 cumplido, 1 falló/rojo, 75 se acabó el tiempo
  close <n>                              cierra el pendiente, sólo si tiene evidencia válida
  merge [<pr>] [--wait] [--minutes 10] [--method squash|merge|rebase] [--no-deploy]
                                         merge SÓLO con todos los checks del último commit resueltos en verde (o
                                         neutral), la puerta de evidencia en verde, sin borrador ni conflicto; si no,
                                         dice qué falta (--wait espera a que resuelva). Después espera el deploy de
                                         producción (workflow en push a la rama base) y dice cómo salió. Usa esto,
                                         no gh pr merge. Sale 0 hecho, 1 falta algo o el deploy falló, 75 en curso

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
    'skip-readiness': { type: 'boolean' },
    'no-handoff': { type: 'boolean' },
    version: { type: 'boolean', short: 'v' },
    json: { type: 'boolean' },
    claim: { type: 'boolean' },
    cloud: { type: 'boolean' },
    reopen: { type: 'boolean' },
    again: { type: 'boolean' },
    start: { type: 'boolean' },
    'no-worktree': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    force: { type: 'boolean' },
    'no-protect': { type: 'boolean' },
    'files-only': { type: 'boolean' },
    'no-checks': { type: 'boolean' },
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
    criterion: { type: 'string' },
    note: { type: 'string' },
    context: { type: 'string' },
    from: { type: 'string' },
    device: { type: 'boolean' },
    'no-wait': { type: 'boolean' },
    pr: { type: 'string' },
    wait: { type: 'boolean' },
    login: { type: 'boolean' },
    path: { type: 'string' },
    logout: { type: 'string' },
    relogin: { type: 'string' },
    open: { type: 'boolean' },
    with: { type: 'string' },
    down: { type: 'boolean' },
    lines: { type: 'string' },
    issue: { type: 'string' },
    workspace: { type: 'string' },
    status: { type: 'string' },
    base: { type: 'string' },
    until: { type: 'string' },
    timeout: { type: 'string' },
    replace: { type: 'boolean' },
    method: { type: 'string' },
    'no-deploy': { type: 'boolean' },
    flow: { type: 'string' },
    set: { type: 'string' },
    reason: { type: 'string' },
    person: { type: 'boolean' },
    all: { type: 'boolean' },
    timezone: { type: 'string' },
    yes: { type: 'boolean', short: 'y' },
    repo: { type: 'string' },
  },
});
if (values.version) {
  const { readFileSync } = await import('node:fs');
  console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  process.exit(0);
}


let [command, arg, arg2] = positionals;
let existing = null; // sesión que ya había al pedir login
const num = (v, what = '<n>') => parseRef(v, what).n;

// ---- Referencias entre repos: `n`, `#n` u `owner/repo#n` (patrón de GitHub) ----
// Sin repo explícito todo sigue siendo el repo del directorio. Con `owner/repo#n` de OTRO repo el comando se
// ejecuta allá: se ubica su clon local (cwd, ~/ y GHOSTY_DEV_REPOS), se entra y GH_REPO apunta a ese repo, así
// nunca se crea una rama ni un worktree en el repo equivocado. Sin clon, sólo claim/teleport se detienen.
const ORIGIN_REPO = repoOfDir();
let targetRepo = null; // repo ajeno sobre el que corre este comando (null = el del directorio)
const refOf = (v, what) => {
  const r = parseRef(v, what);
  return r.repo && sameRepo(r.repo, targetRepo ?? ORIGIN_REPO) ? { repo: null, n: r.n } : r;
};
function useTargetRepo() {
  const from = [['<n>', arg], ['--issue', values.issue], ['--pr', values.pr]].filter(([, v]) => v !== undefined && hasRepo(v));
  const repos = [...new Set(from.map(([, v]) => parseRef(v).repo.toLowerCase()))];
  if (repos.length > 1) throw new cmd.UserError(`Las referencias son de repos distintos (${repos.join(', ')}): un comando trabaja en un solo repo.`);
  if (!repos.length) return;
  const repo = parseRef(from[0][1]).repo;
  // Las referencias se vuelven números simples dentro del repo destino.
  if (arg !== undefined && hasRepo(arg)) arg = String(parseRef(arg).n);
  for (const k of ['issue', 'pr']) if (values[k] !== undefined && hasRepo(values[k])) values[k] = String(parseRef(values[k]).n);
  if (sameRepo(repo, ORIGIN_REPO)) return;
  const needsCheckout = (command === 'claim' && !values.cloud) || command === 'teleport';
  const dir = findCheckout(repo);
  if (!dir && needsCheckout) {
    throw new cmd.UserError(`${repo} no es el repo de este directorio${ORIGIN_REPO ? ` (${ORIGIN_REPO})` : ''} y no encuentro un clon local suyo (busqué aquí, en ~/ y en GHOSTY_DEV_REPOS).\n  Clónalo y repite: ${cloneCommand(repo)} && ghosty-dev ${command} ${fmtRef(repo, arg ?? values.issue ?? values.pr)}`);
  }
  targetRepo = repo;
  process.env.GH_REPO = repo;
  if (dir) {
    // Las rutas relativas (--file…) se resuelven antes de cambiar de directorio.
    for (const k of ['file', 'issue-file']) if (typeof values[k] === 'string' && values[k] !== '-') values[k] = resolve(values[k]);
    process.chdir(dir);
  } else if (command === 'claim' && values.cloud) values['no-handoff'] = true; // sin clon no hay trabajo local que traspasar
  console.error(`Repo: ${repo}${dir ? ` · clon: ${dir}` : ' · sin clon local (sólo GitHub)'}`);
}
// Con ≥2 repos en juego, todo número suelto se imprime como owner/repo#n (el número solo es ambiguo).
const qualify = (t) => (targetRepo && typeof t === 'string' ? t.replace(/(?<![\w/.#&-])#(\d+)\b/g, `${targetRepo}#$1`) : t);
for (const k of ['log', 'error']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => orig(...a.map((x) => (k === 'error' || !values.json ? qualify(x) : x)));
}
const blockerLabel = (b) => (typeof b === 'number' ? `#${b}` : b);

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
// Si el repo no está preparado (puerta, revisor, protección), PREPARAR es el primer pendiente y #n espera. Sale 7.
async function blockedByPreparation(n) {
  if (values['skip-readiness'] || process.env.GHOSTY_DEV_SKIP_READINESS || process.env.GHOSTY_DEV_NO_NET) return false;
  let r;
  try {
    r = cmd.ensurePreparation(n);
  } catch (e) {
    console.error(`Aviso: no pude revisar si el repo está preparado (${e.message}).`);
    return false;
  }
  if (!r) return false;
  const msg = `El repo no está preparado para ghosty-dev:\n${r.blocking.map((c) => `  - ${c.why} → ${c.fix}`).join('\n')}\n` +
    `Preparar es el primer pendiente: #${r.prep}${r.created ? ' (lo abrí)' : ''}${r.blocked ? `; #${r.blocked} quedó bloqueado por él` : ''}.\n  ghosty-dev claim ${r.prep}   (o --skip-readiness si sabes lo que haces)`;
  if (values.json) console.log(JSON.stringify({ ok: false, notReady: true, ...r }));
  else console.error(msg);
  process.exitCode = 7;
  return true;
}

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
      : `${x.queued ? 'En fila (fábrica en pausa)' : x.already ? 'Ya iba en la nube' : 'Mandado a la nube'}: #${x.number} ${x.title}${x.note ? `\n  ${x.note}` : ''}\n  estado: ${x.state}\n  ${x.pr ?? x.url}\n  Síguelo: ghosty-dev cloud   ·   Detenlo: ghosty-dev stop ${x.number}`,
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

const LOGIN_WORD = { session: 'ok: entra con sesión', no_session: 'MAL: no entra con sesión', public_path: 'sin probar: ruta que no exige sesión', app_error: 'MAL: la app truena', unreachable: 'MAL: no se pudo abrir' };
// Formmy fila 59: gs sigue las redirecciones; se muestra el primer estado y dónde terminó (302 → /dashboard/agentes (200)).
const hopText = (h) => (!h ? '—' : h.final && h.finalStatus && h.status >= 300 && h.status < 400 ? `${h.status} → ${h.final} (${h.finalStatus})` : `${h.status}${h.location ? ` → ${h.location}` : ''}`);
// Formmy fila 61: un renglón por paso del recorrido (entrar, cerrar sesión, no se reabre, volver a entrar, sin identidad).
const STEP_LINE = { enter: 'entrar', logout: 'cerrar sesión', stays_out: 'no se reabre', reenter: 'volver a entrar', no_identity: 'sin identidad' };
function loginCheckText(x) {
  const head = `Login en la vista previa del PR #${x.pr} (${x.path}): ${LOGIN_WORD[x.verdict] ?? x.verdict}${x.flow === 'failed' && x.verdict === 'session' ? ', pero el recorrido falla' : ''}\n  con identidad ${hopText(x.withIdentity)} · sin identidad ${hopText(x.withoutIdentity)}`;
  if (!x.steps?.length) return `${head}${x.message ? `\n  ${x.message}` : ''}`;
  return `${head}\n${x.steps.map((s) => `  ${s.ok === true ? 'ok ' : s.ok === false ? 'MAL' : '-- '} ${STEP_LINE[s.name] ?? s.name}: ${s.detail}`).join('\n')}`;
}

// La combinada: «Combinada #73 + #101 · abc1234 (base main def5678; #73 e90deb4, #101 a94f32e)».
function combinedLabel(x) {
  const parts = [x.base?.ref ? `base ${x.base.ref}${x.base.sha ? ` ${x.base.sha.slice(0, 7)}` : ''}` : null, ...x.heads.map((h) => `#${h.pr} ${h.sha.slice(0, 7)}`)].filter(Boolean);
  return `Combinada #${x.prs.join(' + #')} · ${x.repo}${x.sha ? ` · commit ${x.sha.slice(0, 7)}` : ''}${parts.length ? ` (${parts.join('; ')})` : ''}`;
}
function combinedText(x, { opened } = {}) {
  const until = x.expiresAt ? new Date(x.expiresAt).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : null;
  const head = `${combinedLabel(x)}: ${PHASE_WORD[x.phase] ?? x.phase}`;
  const tail = `\n  Sin rama ni PR en GitHub; cuenta como una caja${until ? ` y se borra sola a las ${until}` : ''} o al cerrar cualquiera de los PR. Quitarla antes: ghosty-dev preview ${x.prs[0]} --with ${x.prs.slice(1).join(',')} --down`;
  if (x.phase === 'ready') return (x.url ? `${head}\n${opened ? '  Abierta en tu navegador.' : `  ${x.url}`}` : `${head}, pero Ghosty Studio no mandó una liga válida.`) + tail;
  if (x.phase === 'failed') return `${head}${x.error ? `\n  ${x.error}` : ''}`;
  return `${head}. Espérala: ghosty-dev preview ${x.prs[0]} --with ${x.prs.slice(1).join(',')} --wait` + tail;
}

function previewText(x, { opened } = {}) {
  const head = `Vista previa del PR #${x.pr}${x.sha ? ` (commit ${x.sha.slice(0, 7)})` : ''}: ${PHASE_WORD[x.phase] ?? x.phase}`;
  const top = (x.missingEnvPriority ?? []).filter((n) => x.missingEnv?.includes(n));
  const rest = (x.missingEnv ?? []).filter((n) => !top.includes(n));
  const list = (l) => `${l.slice(0, 8).join(', ')}${l.length > 8 ? ` y ${l.length - 8} más` : ''}`;
  const env =
    (top.length ? `\n  ${top.length === 1 ? 'Falta 1' : `Faltan ${top.length}`} que usa este PR o el arranque: ${list(top)}. Súbelas con ghosty-dev env push (entran en el siguiente armado).` : '') +
    (rest.length ? `\n  ${top.length ? 'Y' : 'Informativo: faltan'} ${rest.length} más del resto de la app (ghosty-dev doctor las lista).` : '');
  if (x.phase === 'ready')
    return (x.url ? `${head}\n${opened ? '  Abierta en tu navegador.' : `  ${x.url}`}` : `${head}, pero Ghosty Studio no mandó una liga válida.${x.page ? ` Ábrela en ${x.page}` : ''}`) + env;
  if (x.phase === 'failed') return `${head}${x.error ? `\n  ${x.error}` : ''}${x.page ? `\n  Detalle: ${x.page}` : ''}`;
  if (x.phase === 'none') {
    const msg = x.message ?? 'Se arma sola con el siguiente push (PR no borrador).';
    return `${head}. ${msg}${/rebuild|es borrador|está cerrado|fork|no aplica/.test(msg) ? '' : `\n  Para armarla sin push: ghosty-dev box rebuild ${x.pr}`}`;
  }
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
        ...(x.next ? [`  ${x.next.line}`] : []),
        ...(x.closed ? [`  ${cmd.closedLine(x.closed)}`] : []),
        ...(x.deploy ? [`  deploy: ${x.deploy.label}${x.deploy.state === 'success' && x.deploy.site ? ` · ${x.deploy.site}` : x.deploy.url ? ` · ${x.deploy.url}` : ''}`] : []),
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
  if (values.json) console.log(JSON.stringify(targetRepo && data && typeof data === 'object' && !Array.isArray(data) ? { repo: targetRepo, ...data } : data, null, 2));
  else console.log(human(data));
}

try {
  if (!values.help && command && command !== 'help') useTargetRepo();
  if (values.help || !command || command === 'help') {
    console.log(HELP);
  } else if (command === 'init') {
    const dir = resolve(values.dir ?? process.cwd());
    // Antes de escribir nada: a qué repo y rama va (con --json, a stderr para no ensuciar la salida).
    const filesOnly = Boolean(values['files-only']);
    const t = filesOnly ? cmd.initTargetLocal(dir) : cmd.initTarget(dir);
    const say = values.json ? console.error : console.log;
    say(`Repo: ${t.repo} · rama actual: ${t.branch ?? '?'} (principal: ${t.defaultBranch})`);
    if (!filesOnly && !values['dry-run'] && t.branch !== t.defaultBranch && !values.yes)
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
    const plan = cmd.init(dir, { dryRun: values['dry-run'], force: values.force, protectBranch: !values['no-protect'], labels, filesOnly, noChecks: Boolean(values['no-checks']) });
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
      `Evidencia válida${x.criteriaChecked ? '' : ' (sin comparar criterios: falta --issue-file)'}.${x.manual?.length ? ` Pendiente de la persona: ${x.manual.map((m) => m.criterion).join('; ')}.` : ''} No se publicó nada.`,
    );
  } else if (command === 'review') {
    const r = cmd.review(num(arg), { file: values.file, pr: values.pr === undefined ? undefined : num(values.pr, '--pr <m>') });
    if (r.brief) print(r, (x) => x.brief);
    else print(r, (x) => `Revisión publicada en #${x.number} (commit ${x.sha.slice(0, 7)}): ${x.open} hallazgo(s) abierto(s).${x.url ? `\n  ${x.url}` : ''}${x.open ? `\n  ${cmd.blockHint(x.number)}` : ''}`);
  } else if (command === 'confirm') {
    const r = cmd.confirm(num(arg), { criterion: values.criterion, note: values.note, pr: values.pr === undefined ? undefined : num(values.pr, '--pr <m>') });
    print(r, (x) => `Criterio ${x.index} de #${x.number} confirmado por @${x.by} (commit ${x.sha.slice(0, 7)}): ${x.criterion}.${x.rerun ? ` Puerta del PR re-ejecutada (run ${x.rerun}).` : ''}${x.url ? `\n  ${x.url}` : ''}`);
  } else if (command === 'criteria') {
    const r = cmd.criteria(num(arg), { set: values.set, text: arg2, reason: values.reason });
    print(r, (x) => (x.criteria ? (x.criteria.length ? x.criteria.map((c) => `${c.index}. ${c.text}`).join('\n') : `#${x.number} no tiene criterios.`) : `Criterio ${x.index} de #${x.number} enmendado (comentario de rastro publicado).\n  antes: ${x.before}\n  ahora: ${x.after}`));
  } else if (command === 'board') {
    const r = cmd.board();
    print(r, (x) => `Pendientes abiertos en el navegador: ${x.url}`);
  } else if (command === 'add') {
    const r = cmd.add(arg, {
      goal: values.goal,
      criteria: values.criteria ?? [],
      context: values.context,
      blockedBy: values.by ? refOf(values.by, '--by <m>') : undefined,
      discoveredIn: values.from ? refOf(values.from, '--from <n>') : undefined,
      flow: values.flow,
      repo: values.repo,
    });
    // Con ≥2 repos en juego (--repo, o --by/--from de otro repo) el número solo es ambiguo: se imprime completo.
    if ((values.repo || [values.by, values.from].some((v) => v && refOf(v).repo)) && !r.ref) r.ref = fmtRef(values.repo ?? ORIGIN_REPO ?? cmd.repoFullName(), r.number);
    print(r, (x) => `Pendiente ${x.ref ?? '#' + x.number} ${x.reused ? 'ya existía (lo reutilicé)' : 'abierto'}: ${x.title}${x.blockedBy ? ` (bloqueado por ${blockerLabel(x.blockedBy)})` : ''}\n  ${x.url}${x.board ? `\n  Tablero abierto en el navegador: ${x.board}` : ''}`);
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
      const result = first.state === 'esperando' ? { ...first, resumed: true } : cmd.claim(first.number, { worktree: !values['no-worktree'], base: values.base, onWarning: (w) => console.error(`Aviso: ${w}`), onProgress: (m) => console.error(m) });
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
  } else if (command === 'factory') {
    const op = arg ?? 'status';
    const r = op === 'status' ? await factory.status({ all: values.all }) : await factory.set(op, { until: values.until, reason: values.reason, schedule: arg2, timezone: values.timezone, all: values.all });
    print(r, factory.statusText);
  } else if (command === 'claim' && values.cloud) {
    const pr = values.pr === undefined ? undefined : num(values.pr, '--pr <m>');
    const n = arg === undefined && pr ? undefined : num(arg);
    const notReady = n ? await blockedByPreparation(n) : false;
    const retry = `ghosty-dev claim${n ? ` ${n}` : ''} --cloud${pr ? ` --pr ${pr}` : ''}${values.workspace ? ` --workspace ${values.workspace}` : ''} --yes`;
    if (!notReady && (await confirmCloud({ n, pr }, retry))) {
      // Lo que llevas aquí se hereda: sube tu trabajo a una rama de traspaso y la caja parte de ahí.
      const handoff = n && !pr && !values['no-handoff'] ? cmd.handoffToCloud(n, { onProgress: (m) => console.error(m) }) : null;
      if (handoff) console.error(`Traspaso: tu trabajo${handoff.wip ? ' (con un commit «WIP: traspaso a la nube» de lo que no habías commiteado)' : ''} quedó en ${handoff.branch}; la nube sigue desde ahí.`);
      printCloud(await cloud.start(n, { pr, workspace: values.workspace, reopen: values.reopen, fromBranch: handoff?.branch }));
    }
  } else if (command === 'claim' && values.pr !== undefined) {
    await factory.guard();
    // Adoptar lo que ya existe: un PR abierto queda como el trabajo del pendiente, sin rama ni worktree nuevos.
    const n = num(values.issue ?? arg, '--issue <n>');
    const r = cmd.adopt(n, num(values.pr, '--pr <m>'));
    // Preguntar por la preview la arma si el aviso de GitHub se perdió (gs; Formmy, fila 48).
    if (!process.env.GHOSTY_DEV_NO_NET) {
      try {
        r.preview = previews.publicPreview(await previews.fetchPreview(r.pr));
      } catch {}
    }
    print(r, (x) => `Tomado #${x.number} ${x.title} con el PR #${x.pr} (rama ${x.branch}).${x.linked ? `\n  Agregué «Closes #${x.number}» a la descripción del PR.` : ''}${x.alsoCloses.length ? `\n  Ese PR también cierra ${x.alsoCloses.map((c) => '#' + c).join(', ')}.` : ''}${x.preview ? `\n  Vista previa: ${PHASE_WORD[x.preview.phase] ?? x.preview.phase}${x.preview.phase === 'ready' ? '' : ` (síguela: ghosty-dev preview ${x.pr} --wait)`}` : ''}\n  Sigue: ghosty-dev next`);
  } else if (command === 'cloud') {
    print(cloud.groupByIssue(await cloud.list()), (l) => (l.length ? l.map((r) => `#${r.number}\t${r.state}\t${r.title}${r.pr ? `\t${r.pr}` : ''}${r.attempts ? `\t(+${r.attempts} intento${r.attempts > 1 ? 's' : ''} anterior${r.attempts > 1 ? 'es' : ''})` : ''}`).join('\n') : 'No hay pendientes de este repo en la nube.'));
  } else if (command === 'tell') {
    const n = num(arg);
    let note = null;
    if (!values.again) {
      const { readFileSync } = await import('node:fs');
      if (values.file !== undefined) note = readFileSync(values.file, 'utf8');
      else if (arg2 === '-') note = readFileSync(0, 'utf8');
      else note = positionals.slice(2).join(' ');
    }
    const r = await cloud.tell(n, { note, again: values.again });
    const PHASES = { needs_person: 'Te necesita', working: 'Trabajando', queued: 'En fila', waiting_ci: 'Esperando el CI', reviewing: 'En revisión', blocked: 'Esperando otro PR', merging: 'Mergeando', stopped: 'Detenido' };
    print(r, (x) => `${x.op === 'resume' ? 'Otra vuelta pedida' : x.answered ? 'Respondí la pregunta del escritor' : 'Mensaje enviado al escritor'} de #${x.number} en la nube.\n  fase: ${PHASES[x.phase] ?? x.state ?? x.phase}\n  Síguelo: ghosty-dev cloud   ·   ghosty-dev show ${x.number}`);
  } else if (command === 'reopen') {
    const r = await cloud.reopen(num(arg));
    print(r, (x) => `#${x.number} retomado en la nube: ${x.state}.\n  ${x.pr ?? x.url}`);
  } else if (command === 'release') {
    const r = await cloud.release(num(arg));
    print(r, (x) => `#${x.number} sigue sin esperar el otro PR: ${x.state}.`);
  } else if (command === 'recover') {
    const prs = values.pr ? String(values.pr).split(',').map((x) => num(x.trim().replace(/^#/, ''), '--pr <m,n>')) : undefined;
    const r = await cloud.recover({ start: values.start, prs });
    print(r, (x) =>
      x.started
        ? x.started.length ? x.started.map((s) => (s.ok ? `PR #${s.pr}: retomado (PR nuevo sobre su rama).` : `PR #${s.pr}: no se pudo — ${s.error}`)).join('\n') : 'No hay nada que recuperar.'
        : x.candidates.length
          ? `${x.candidates.map((c) => `PR #${c.pr}\t${c.branch}${c.issue ? `\t#${c.issue}` : ''}\t${c.title}`).join('\n')}\n  Retómalos: ghosty-dev recover --start${x.candidates.length > 1 ? '   (o --pr m,n para algunos)' : ''}`
          : 'No hay PRs cerrados sin merge con su rama viva.',
    );
  } else if (command === 'stop') {
    print(await cloud.stop(num(arg)), (r) => `#${r.number} detenido en la nube. El issue y la rama se quedan.`);
  } else if (command === 'teleport') {
    print(await cloud.teleport(num(arg)), (r) => `#${r.number} ya no va en la nube.${r.branch ? `\n  rama: ${r.branch}\n  Sigue aquí: ghosty-dev claim ${r.number}` : ''}`);
  } else if (command === 'claim') {
    await factory.guard();
    const notReady = await blockedByPreparation(num(arg));
    // Si la nube ya lo escribe, un solo escritor: se detiene su caja y se trae su rama para seguir aquí.
    const back = notReady || process.env.GHOSTY_DEV_NO_NET ? null : await cloud.takeBack(num(arg));
    if (back) console.error(`#${back.number} iba en la nube: la detuve y traje su rama${back.branch ? ` (${back.branch})` : ''}.`);
    const r = notReady ? null : cmd.claim(num(arg), { worktree: !values['no-worktree'], base: values.base, onWarning: (w) => console.error(`Aviso: ${w}`), onProgress: (m) => console.error(m) });
    if (r) print(r, (x) => `Tomado #${x.number} ${x.title}\n  rama: ${x.branch}${x.base ? ` (parte de ${x.base})` : ''}${x.worktree ? `\n  worktree: ${x.worktree}` : ''}`);
  } else if (command === 'wait' && values.pr === undefined) {
    // Aviso en vivo (stderr, para no ensuciar el --json) cuando la vista previa o la revisión terminan.
    const onService = (key, s) => console.error(serviceLine(key, s).trim());
    // Esperar = ya empujó: la tarjeta regresa a «En revisión».
    await writer.beat(num(arg), 'pushed');
    // Escuchando: en gs el pedido sale «le llega al instante» y no se avisa que nadie revisa.
    const minutes = values.minutes ? Number(values.minutes) : 5;
    if (values.watch) await writer.ack(num(arg), { listening: true, minutes });
    const r = await cmd.wait(num(arg), { watch: values.watch, minutes: values.minutes ? Number(values.minutes) : undefined, onService });
    // Dejó de escuchar; los pedidos que lo despertaron quedan «leídos» en gs.
    if (values.watch || r.asks?.length) await writer.ack(num(arg), { seen: (r.asks ?? []).map((a) => a.id), ...(values.watch ? { listening: false } : {}) });
    if (r.pr) autoDeps(Number(String(r.pr).split('/').pop()));
    // Lo despertó un pedido o el CI salió rojo: le toca corregir (la tarjeta vuelve a «Escribiendo»).
    if (r.asks?.length) await writer.beat(num(arg), 'working', `pedido: ${r.asks[0].text}`);
    else if (values.watch && !r.timedOut && r.ci && !['verde', 'sin-pr', 'sin-checks'].includes(r.ci)) await writer.beat(num(arg), 'working', `CI ${r.ci}`);
    if (r.factory) process.exitCode = factory.FACTORY_PAUSED_EXIT;
    print(r, (x) =>
      x.factory
        ? `#${x.number}: ${x.factory.line}. No tomes trabajo nuevo; termina lo que traes y detente.`
        : x.closed
        ? `#${x.number}: primero esto: ${cmd.closedLine(x.closed)}\n  Mientras siga cerrado, un push a su rama no corre CI, vista previa ni revisión.`
        : x.asks?.length
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
    if (!values.peek) await factory.guard();
    const r = cmd.asks(num(arg), { peek: values.peek });
    // Acuse a gs: «Lo leyó tu agente» bajo cada pedido (y, sin pedidos, que sí está revisando).
    if (!values.peek) await writer.ack(num(arg), { pr: r.pr, seen: [...r.asks, ...r.stale].map((a) => a.id) });
    // Tomó el pedido: está corrigiendo.
    if (!values.peek && r.asks.length) await writer.beat(num(arg), 'working', `pedido: ${r.asks[0].text}`);
    print(r, (x) =>
      [x.asks.length ? x.asks.map((a) => `- ${a.text}${a.by ? ` (@${a.by})` : ''}`).join('\n') : `#${x.number}: sin pedidos nuevos.`]
        .concat(x.stale.length ? [`Obsoletos (avisos del bot que ya no aplican a la cabeza del PR; no hay que hacerlos):`, ...x.stale.map((a) => `  - ${a.reason}: ${a.text.split('\n')[0].slice(0, 120)}`)] : [])
        .join('\n'),
    );
  } else if (command === 'evidence') {
    const r = cmd.evidence(num(arg), values.file, { pr: values.pr === undefined ? undefined : num(values.pr, '--pr <m>') });
    print(r, (x) => `Evidencia publicada en #${x.number}${x.url ? `: ${x.url}` : ''}.${x.rerun ? ` Puerta del PR re-ejecutada (run ${x.rerun}).` : ''}${x.awaitingPerson?.length ? `\n  Falta tu verificación: ${x.awaitingPerson.join('; ')} → ghosty-dev confirm ${x.number} --criterion <i>` : ''}`);
  } else if (command === 'block') {
    const r = cmd.block(num(arg), values.by === undefined ? undefined : (() => { const b = refOf(values.by, '--by <m>'); return b.repo ? b : b.n; })(), { reason: values.reason, person: values.person === true });
    print(r, (x) =>
      x.via === 'motivo'
        ? `#${x.number} bloqueado: ${x.reason}${x.pr ? ` (también en el PR #${x.pr})` : ''}. El tablero lo enseña como «Bloqueado»${x.person ? ' y le avisa a la persona («Te necesita»)' : ''}. Al resolverlo: ghosty-dev unblock ${x.number}.`
        : `#${x.number} bloqueado por ${blockerLabel(x.blockedBy)} (${x.via === 'github' ? 'dependencia nativa de GitHub' : 'lista en el cuerpo'}).${x.reason ? ` Motivo: ${x.reason}` : ''}`,
    );
  } else if (command === 'unblock') {
    const r = cmd.unblock(num(arg));
    print(r, (x) => `#${x.number} desbloqueado${x.pr ? ` (también en el PR #${x.pr})` : ''}.${x.wasLabeled ? '' : ' No tenía la etiqueta: sólo se dejó la marca.'}`);
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
  } else if (command === 'preview' && values.login) {
    // Login de prueba (Formmy filas 53–54): liga de un solo uso con la identidad de servicio, o con --check la prueba
    // de punta a punta (misma ruta con y sin identidad).
    const pr = arg === undefined ? undefined : num(arg, '<pr>');
    if (values.check) {
      const { loginPathOf, loginFlowOf } = await import('../src/doctor.mjs');
      const top = cmd.repoTop();
      const flow = top ? loginFlowOf(top) : {};
      const r = await previews.previewLoginCheck(pr, { path: values.path ?? (top ? loginPathOf(top) : undefined), logout: values.logout ?? flow.logout, relogin: values.relogin ?? flow.relogin });
      print(r, loginCheckText);
      process.exitCode = r.verdict === 'session' && r.flow !== 'failed' ? 0 : 1;
    } else {
      const r = await previews.previewLogin(pr, { path: values.path });
      if (values.open) auth.openBrowser(r.url);
      print(r, (x) => `Login de prueba en la vista previa del PR #${x.pr} como ${x.identity?.email || 'la identidad de servicio'} (un solo uso, ${Math.round(x.expiresIn / 60)} min, aterriza en ${x.path}):\n${values.open ? '  Abierta en tu navegador.' : `  ${x.url}\n  Nadie la ha abierto: se gasta la primera vez que la abras (navegador o curl), no al generarla. Para abrirla tú: --open.\n  Con curl: curl -sL -c jar "<liga>" -o /dev/null && curl -s -b jar <host de la preview>${x.path}`}`);
    }
  } else if (command === 'preview' && values.with !== undefined) {
    // Vista previa combinada (Formmy fila 63): este PR + otros, sin rama ni PR borrador.
    const pr = arg === undefined ? undefined : num(arg, '<pr>');
    const withPrs = previews.parseWith(values.with);
    if (values.down) {
      print(await previews.previewCombinedDown(pr, withPrs), (x) => (x.removed ? `Quité la vista previa combinada #${x.prs.join(' + #')}.` : `No había vista previa combinada #${x.prs.join(' + #')}.`));
    } else {
      const r = await previews.previewCombined(pr, withPrs, { wait: values.wait || values.open, onNote: (n) => console.error(n) });
      if (r.url && values.open) {
        console.error(`Abriendo ${combinedLabel(r)}`);
        auth.openBrowser(r.url);
      }
      print(r, (x) => combinedText(x, { opened: values.open }));
      process.exitCode = previews.exitCodeOf(r);
    }
  } else if (command === 'preview') {
    const pr = arg === undefined ? undefined : num(arg, '<pr>');
    // Los avisos (commit viejo, falta push) van a stderr y nunca llevan la liga.
    autoDeps(pr ?? previews.currentPr());
    const r = await previews.preview(pr, { wait: values.wait, onNote: (n) => console.error(n) });
    // Fila 62: antes de abrir, a qué PR y commit apunta (stderr; nunca la liga).
    if (r.url && values.open) {
      console.error(`Abriendo la vista previa del PR #${r.pr} · ${r.repo}${r.sha ? ` · commit ${r.sha.slice(0, 7)}` : ''}${r.prHead && r.sha && !r.prHead.startsWith(r.sha) && !r.sha.startsWith(r.prHead) ? ` (el PR va en ${r.prHead.slice(0, 7)}: rearma con ghosty-dev box rebuild ${r.pr})` : ''}`);
      auth.openBrowser(r.url);
    }
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
    let previewMissingEnvPriority = [];
    let loginProbe = null;
    try {
      const pr = values.pr !== undefined ? num(values.pr, '--pr <m>') : previews.currentPr();
      if (pr) {
        const p = await previews.fetchPreview(pr);
        previewOAuth = doctor.parsePreviewOAuth(p.oauth);
        previewMissingEnv = p.missingEnv;
        previewMissingEnvTouched = p.missingEnvTouched;
        previewMissingEnvPriority = p.missingEnvPriority;
        // Petición real (filas 53–54): ¿la app de la vista previa entra con la identidad? Sólo si está lista.
        if (p.phase === 'ready' && doctor.identityCheck(top)?.ok) {
          const flow = doctor.loginFlowOf(top);
          loginProbe = await previews.previewLoginCheck(pr, { path: values.path ?? doctor.loginPathOf(top), logout: values.logout ?? flow.logout, relogin: values.relogin ?? flow.relogin }).catch(() => null);
        }
      }
    } catch {}
    const catalog = await doctor.fetchCatalog();
    // ¿El proveedor ya acepta el callback de Ghosty? Con el client id (público) del .env local; la preview del PR manda.
    const probes = await doctor.probeProviders(top, catalog).catch(() => ({}));
    // Sólo si el código llama a un agente de partner: ¿existe en Ghosty Studio? (fila 50)
    const partnerAgents = doctor.partnerAgentRefs(top).length ? await doctor.fetchPartnerAgents(cmd.repoFullName()) : null;
    const r = { repo: cmd.repoFullName(), ...doctor.diagnose(top, { saved, catalog, previewOAuth, previewMissingEnv, previewMissingEnvTouched, previewMissingEnvPriority, probes, partnerAgents, loginProbe }) };
    if (r.oauth) delete r.oauth.helperJs;
    // ¿Hay ghosty-dev más nuevo? (fila 57) Primero, con la línea exacta para actualizar.
    const up = await import('../src/update.mjs');
    r.checks.unshift(up.versionCheck(up.currentVersion(), await up.latestVersion()));
    // ¿Está el repo preparado? La puerta, su revisor y la protección (Formmy, 23-nov: sin esto ningún PR de la nube pasaba).
    try {
      r.checks.push(...cmd.readinessChecks(cmd.repoReadiness({ dir: top })));
    } catch (e) {
      r.checks.push({ name: 'puerta', ok: null, detail: `no pude leer la preparación del repo: ${e.message}` });
    }
    print(r, doctor.doctorText);
    if (r.checks.some((c) => c.ok === false)) process.exitCode = 1;
  } else if (command === 'update') {
    const up = await import('../src/update.mjs');
    const r = up.update();
    print(r, up.updateText);
    if (!r.ok) process.exitCode = 1;
  } else if (command === 'check-lock') {
    // Lo corre el hook pre-push (ghosty-dev init): bloquea el push si el lock no coincide con package.json.
    const r = cmd.repoLock() ?? { ok: true, problems: [] };
    // Push a la rama de un PR cerrado sin merge: no habrá run (Formmy, fila 42). Sólo avisa: el push sigue.
    const closed = process.env.GHOSTY_DEV_NO_NET ? null : cmd.closedPrOfBranch();
    if (closed) console.error(`Aviso: ${cmd.closedLine(closed)}. Este push no corre CI, vista previa ni revisión mientras siga cerrado.`);
    // Rutas o módulos de servidor/cliente: pruebas y tsc no ven un build roto (Formmy, fila 52). Sólo avisa.
    const build = cmd.buildHint();
    if (build) console.error(`Aviso: ${build}`);
    print(r, (x) => (x.ok ? (x.lock ? `${x.lock} coincide con package.json.` : 'Sin lock que comparar.') : x.message));
    if (!r.ok) process.exitCode = 1;
  } else if (command === 'next' || command === 'status') {
    await factory.guard();
    const r = cmd.next();
    print(r, (x) => `Siguiente paso: ${x.step}${x.command ? `\n  ${x.command}` : ''}\n  por qué: ${x.why}${x.board ? `\n  tablero: ${x.board.line}` : ''}`);
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
    // Cerrado sin merge: no hay nada que esperar; se dice quién y cómo reabrirlo (Formmy, fila 42).
    if (r.state === 'cerrado') {
      const c = cmd.closedInfo(r.pr);
      if (c) r.closed = c;
      console.log(values.json ? JSON.stringify({ event: 'done', ...r }) : c ? cmd.closedLine(c) : `El PR #${r.pr} está cerrado sin merge: ¿reabrir? gh pr reopen ${r.pr}`);
      process.exitCode = 1;
    } else {
    console.log(
      values.json
        ? JSON.stringify({ event: 'done', ...r })
        : r.factory
          ? `${r.factory.line}. No tomes trabajo nuevo; termina lo que traes y detente.`
        : r.timedOut
          ? `Se acabó el tiempo y no ha pasado (${r.until}).${r.stuck ? ` ${r.stuck.hint}` : ''} Vuelve a correr: ghosty-dev wait --pr ${r.pr} --until ${r.until}`
          : r.exitCode
            ? `Listo (${r.until}): ${r.preview.phase === 'failed' ? 'la vista previa falló → ghosty-dev box logs ' + r.pr : 'el CI salió rojo'}.`
            : `Listo (${r.until}).`,
    );
    process.exitCode = r.exitCode;
    }
  } else if (command === 'show') {
    const r = cmd.show(num(arg));
    if (r.kind === 'pr') {
      await printPr(r, `#${r.pr} es un PR, no un pendiente${r.closes.length ? `: cierra ${r.closes.map((c) => '#' + c).join(', ')} (ghosty-dev show ${r.closes[0]})` : ''}.`);
    } else {
      if (!r.pr && !r.closed && r.state !== 'cerrado') r.hint = `#${r.number} no tiene PR que lo cierre; si el PR ya existe: ghosty-dev claim --pr <m> --issue ${r.number}`;
      r.preview = r.pr ? await previewSummary(Number(r.pr.split('/').pop())) : null;
      // Dónde vive el trabajo (nube o tu compu) y cómo cambiarlo: un solo escritor a la vez.
      const cloudRun = (await cloud.list().catch(() => [])).find((c) => c.number === r.number) ?? null;
      const localBranch = (git(['branch', '--list', `ghosty-dev/${r.number}-*`], { allowFail: true }) ?? '').split('\n').map((l) => l.replace(/^[*+\s]+/, '').trim()).find(Boolean) ?? null;
      r.writer = cmd.writerOf({ number: r.number, cloudRun, localBranch });
      // Si el escritor de la nube preguntó algo, se muestra con la línea exacta para contestar.
      r.asked = cloudRun ? await cloud.asked(r.number) : null;
      const head = r.services?.sha ?? null;
      r.evidenceStale = Boolean(r.evidence && r.evidenceCommit && head && !head.startsWith(r.evidenceCommit) && !r.evidenceCommit.startsWith(head.slice(0, 7)));
      print(r, (x) =>
        [
          `#${x.number} ${x.title}`,
          `  estado: ${x.state ?? 'sin etiqueta de bitácora'}`,
          `  escribe: ${x.writer.where}${x.writer.detail ? ` (${x.writer.detail})` : ''} — para cambiarlo: ${x.writer.move}`,
          `  escritor: ${x.assignees.join(', ') || '—'}`,
          `  bloqueado por: ${x.blockedBy.map(blockerLabel).join(', ') || '—'}`,
          `  evidencia: ${x.evidence ? (x.evidenceStale ? `VIEJA: es del commit ${x.evidenceCommit}, la punta del PR es ${x.services.sha.slice(0, 7)} — hay que publicarla otra vez (ghosty-dev evidence ${x.number} --file e.md)` : 'sí') : 'no'}`,
          ...(x.asked ? [`  el escritor pregunta: ${x.asked.question}`, ...(x.asked.options.length ? [`    opciones: ${x.asked.options.join(' · ')}`] : []), `    contesta: ghosty-dev tell ${x.number} "${x.asked.options[0] ?? '<tu respuesta>'}"`] : []),
          `  pedidos nuevos: ${x.asks.length ? x.asks.map((a) => a.text).join(' · ') : '—'}`,
          ...(x.pr ? [`  PR: ${x.pr}`] : x.closed ? [`  PR: ${cmd.closedLine(x.closed)}`] : x.hint ? [`  PR: — (${x.hint})`] : []),
          ...previewLine(x.preview),
          ...servicesBlock(x.services),
          ...(x.ficha ? ['', x.ficha] : []),
        ].join('\n'),
      );
    }
  } else if (command === 'merge') {
    const { merge, mergeText } = await import('../src/merge.mjs');
    const pr = arg === undefined ? (values.pr !== undefined ? num(values.pr, '--pr <m>') : previews.currentPr()) : num(arg, '<pr>');
    const minutes = values.minutes === undefined ? 10 : Number(values.minutes);
    if (!Number.isFinite(minutes) || minutes < 0) throw new cmd.UserError('--minutes va en minutos (default 10).');
    const r = await merge(pr, { wait: values.wait, minutes, method: values.method, deploy: !values['no-deploy'], onNote: (n) => console.error(n) });
    print(r, mergeText);
    process.exitCode = r.exitCode;
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
  if (e instanceof factory.FactoryPaused) {
    if (values.json) console.log(JSON.stringify({ factory: e.state, message: e.message }, null, 2));
    else console.error(e.message);
    process.exit(factory.FACTORY_PAUSED_EXIT);
  }
  console.error(e instanceof cmd.UserError || e instanceof auth.AuthError || e instanceof cloud.CloudError ? e.message : `Error: ${auth.plain(e.message)}`);
  process.exit(1);
}
