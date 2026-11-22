#!/usr/bin/env node
// CLI de ghosty-dev: el trabajo vive en GitHub Issues, no en la sesión del agente.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import * as cmd from '../src/commands.mjs';
import * as cloud from '../src/cloud.mjs';
import * as auth from '../src/auth.mjs';
import * as envVars from '../src/env.mjs';
import { createInterface } from 'node:readline/promises';

const HELP = `ghosty-dev — el trabajo vive en la bitácora, no en la sesión

Uso: ghosty-dev <comando> [opciones]

  init [--dir D] [--dry-run] [--force] [--no-protect]
                                         etiquetas, plantilla, Action de evidencia, skill, AGENTS.md
                                         (protege la rama sólo si la puerta ya está en ella)
  protect                                vuelve obligatorio ghosty-dev/evidencia en la rama principal
  add "título" --goal G --criteria C…    abre un pendiente (--criteria se repite; --by <m> si lo bloquea #m;
                                         --context, --from <n> si lo descubriste trabajando #n)
  review <n> [--file revision.md]        sin --file: el encargo para el revisor (otra sesión, contexto limpio);
                                         con --file: el revisor publica su revisión atada al commit del PR
  board                                  abre en el navegador los pendientes abiertos del repo
  ready [--json] [--claim] [--cloud]     pendientes que se pueden tomar ahora (sin bloqueo, o CI ya resuelto)
  claim <n> [--no-worktree]              te asigna el pendiente, lo marca tomado y crea su rama y worktree
  claim <n> --cloud                      lo manda a una caja de trabajo de tu cuenta de Ghosty: un agente lo
                                         construye ahí, abre el PR, espera el CI y la revisión, y te avisa
  claim --cloud --pr <m>                 sin pendiente: Ghosty le pone vista previa, revisión y checks al PR #m
                                         y tu terminal lo sigue escribiendo
  cloud                                  los pendientes de este repo que van en la nube
  stop <n>                               detiene #n en la nube y libera su lugar
  teleport <n>                           detiene #n en la nube y trae su rama para seguir en tu compu
  wait <n> [--watch] [--minutes M]       lo deja en esperando-ci; con --watch espera al CI o a un pedido de la persona
                                         (tope 5 min), dice si quedó verde o rojo y avisa cuando la vista previa y la
                                         revisión de Ghosty terminan (no las espera: el CI manda)
  asks <n> [--peek]                      los pedidos nuevos de la persona (@ghosty o desde Ghosty); los marca leídos
  evidence <n> --file evidencia.md       valida y publica el comentario de evidencia
  evidence --check --file e.md [--issue-file pendiente.md]
  review --check --file revision.md      sólo validan el formato, sin gh ni red (no publican nada)
  block <n> --by <m>                     #n queda bloqueado por #m
  show <n> [--json]                      estado, bloqueos, evidencia, la ficha y los servicios del PR
                                         (vista previa, revisión, smoke y CI del commit actual)
  close <n>                              cierra el pendiente, sólo si tiene evidencia válida

Sesión propia en Ghosty Studio (nube y variables de la vista previa; GitHub sigue siendo gh):
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

const printCloud = (r) =>
  print(r, (x) =>
    x.services
      ? `PR #${x.pr ?? '?'}: vista previa, revisión y checks en cada push; tu terminal lo sigue escribiendo.${x.prUrl ? `\n  ${x.prUrl}` : ''}${x.note ? `\n  ${x.note}` : ''}\n  Síguelo: ghosty-dev wait <n> --watch · ghosty-dev show <n>`
      : `${x.already ? 'Ya iba en la nube' : 'Mandado a la nube'}: #${x.number} ${x.title}\n  estado: ${x.state}\n  ${x.pr ?? x.url}\n  Síguelo: ghosty-dev cloud   ·   Detenlo: ghosty-dev stop ${x.number}`,
  );

// Una línea por servicio de la plataforma (vista previa, revisión, smoke) y el CI del commit del PR.
const SERVICE_WORD = { pendiente: 'en curso', listo: 'lista', fallo: 'falló', neutral: 'neutral', 'sin-check': '—' };
function serviceLine(key, s) {
  const label = { preview: 'Vista previa', review: 'Revisión', smoke: 'Smoke' }[key];
  const word = key === 'review' && s.status === 'listo' ? 'terminada' : SERVICE_WORD[s.status];
  const extra = [s.title, key === 'review' && s.comments ? `${s.comments} comentario(s) de hallazgos` : null].filter(Boolean).join(' · ');
  const url = key === 'preview' ? s.deployment ?? s.url : s.url;
  return `  ${label}: ${word}${extra ? ` (${extra})` : ''}${url ? `\n    ${url}` : ''}`;
}
const servicesBlock = (sv) =>
  sv ? ['', `Servicios del PR (commit ${sv.sha.slice(0, 7)}):`, ...['preview', 'review', 'smoke'].map((k) => serviceLine(k, sv[k])), `  CI: ${sv.ci}`] : [];

function print(data, human) {
  if (values.json) console.log(JSON.stringify(data, null, 2));
  else console.log(human(data));
}

try {
  if (values.help || !command || command === 'help') {
    console.log(HELP);
  } else if (command === 'init') {
    const dir = resolve(values.dir ?? process.cwd());
    const plan = cmd.init(dir, { dryRun: values['dry-run'], force: values.force, protectBranch: !values['no-protect'] });
    print(plan, (p) =>
      [values['dry-run'] ? `Ensayo en seco en ${dir} (no se escribe nada):` : `Bitácora instalada en ${dir}:`]
        .concat(p.map((x) => `  ${x.action.padEnd(6)} ${x.name ?? x.path}`))
        .join('\n'),
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
    const r = cmd.review(num(arg), { file: values.file });
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
        printCloud(await cloud.start(next.number));
        process.exit(0);
      }
      const result = first.state === 'esperando' ? { ...first, resumed: true } : cmd.claim(first.number, { worktree: !values['no-worktree'] });
      print(result, (r) => `Tomado #${r.number} ${r.title}${r.worktree ? `\n  worktree: ${r.worktree}\n  rama: ${r.branch}` : ''}${r.resumed ? `\n  retoma: ${r.reason}` : ''}`);
    } else {
      print(list, (l) => (l.length ? l.map((i) => `#${i.number}\t${i.reason}\t${i.title}`).join('\n') : 'No hay pendientes listos.'));
    }
  } else if (command === 'claim' && values.cloud) {
    const pr = values.pr === undefined ? undefined : num(values.pr, '--pr <m>');
    printCloud(await cloud.start(arg === undefined && pr ? undefined : num(arg), { pr }));
  } else if (command === 'cloud') {
    print(await cloud.list(), (l) => (l.length ? l.map((r) => `#${r.number}\t${r.state}\t${r.title}${r.pr ? `\t${r.pr}` : ''}`).join('\n') : 'No hay pendientes de este repo en la nube.'));
  } else if (command === 'stop') {
    print(await cloud.stop(num(arg)), (r) => `#${r.number} detenido en la nube. El issue y la rama se quedan.`);
  } else if (command === 'teleport') {
    print(await cloud.teleport(num(arg)), (r) => `#${r.number} ya no va en la nube.${r.branch ? `\n  rama: ${r.branch}\n  Sigue aquí: ghosty-dev claim ${r.number}` : ''}`);
  } else if (command === 'claim') {
    const r = cmd.claim(num(arg), { worktree: !values['no-worktree'] });
    print(r, (x) => `Tomado #${x.number} ${x.title}\n  rama: ${x.branch}${x.worktree ? `\n  worktree: ${x.worktree}` : ''}`);
  } else if (command === 'wait') {
    // Aviso en vivo (stderr, para no ensuciar el --json) cuando la vista previa o la revisión terminan.
    const onService = (key, s) => console.error(serviceLine(key, s).trim());
    const r = cmd.wait(num(arg), { watch: values.watch, minutes: values.minutes ? Number(values.minutes) : undefined, onService });
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
    print(r, (x) => (x.asks.length ? x.asks.map((a) => `- ${a.text}${a.by ? ` (@${a.by})` : ''}`).join('\n') : `#${x.number}: sin pedidos nuevos.`));
  } else if (command === 'evidence') {
    const r = cmd.evidence(num(arg), values.file);
    print(r, (x) => `Evidencia publicada en #${x.number}${x.url ? `: ${x.url}` : ''}.${x.rerun ? ` Puerta del PR re-ejecutada (run ${x.rerun}).` : ''}`);
  } else if (command === 'block') {
    const r = cmd.block(num(arg), num(values.by, '--by <m>'));
    print(r, (x) => `#${x.number} bloqueado por #${x.blockedBy} (${x.via === 'github' ? 'dependencia nativa de GitHub' : 'lista en el cuerpo'}).`);
  } else if (command === 'show') {
    const r = cmd.show(num(arg));
    print(r, (x) =>
      [
        `#${x.number} ${x.title}`,
        `  estado: ${x.state ?? 'sin etiqueta de bitácora'}`,
        `  escritor: ${x.assignees.join(', ') || '—'}`,
        `  bloqueado por: ${x.blockedBy.map((b) => '#' + b).join(', ') || '—'}`,
        `  evidencia: ${x.evidence ? 'sí' : 'no'}`,
        `  pedidos nuevos: ${x.asks.length ? x.asks.map((a) => a.text).join(' · ') : '—'}`,
        ...(x.pr ? [`  PR: ${x.pr}`] : []),
        ...servicesBlock(x.services),
        ...(x.ficha ? ['', x.ficha] : []),
      ].join('\n'),
    );
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
