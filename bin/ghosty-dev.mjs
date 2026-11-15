#!/usr/bin/env node
// CLI de ghosty-dev: el trabajo vive en GitHub Issues, no en la sesión del agente.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import * as cmd from '../src/commands.mjs';

const HELP = `ghosty-dev — el trabajo vive en la bitácora, no en la sesión

Uso: ghosty-dev <comando> [opciones]

  init [--dir D] [--dry-run] [--force] [--no-protect]
                                         etiquetas, plantilla, Action de evidencia, skill, AGENTS.md
                                         y el check ghosty-dev/evidencia obligatorio en la rama principal
  add "título" --goal G --criteria C…    abre un pendiente (--criteria se repite; --by <m> si lo bloquea #m;
                                         --context, --from <n> si lo descubriste trabajando #n)
  ready [--json] [--claim]               pendientes que se pueden tomar ahora (sin bloqueo, o CI ya resuelto)
  claim <n> [--no-worktree]              te asigna el pendiente, lo marca tomado y crea su rama y worktree
  wait <n>                               lo deja en «esperando» (CI); termina tu sesión, ready lo vuelve a ofrecer
  evidence <n> --file evidencia.md       valida y publica el comentario de evidencia
  block <n> --by <m>                     #n queda bloqueado por #m
  show <n> [--json]                      estado, bloqueos y si ya tiene evidencia
  close <n>                              cierra el pendiente, sólo si tiene evidencia válida

Opciones globales: --json (salida en JSON), -h/--help
Requiere gh autenticado (GHOSTY_DEV_GH cambia el binario).`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: 'boolean', short: 'h' },
    json: { type: 'boolean' },
    claim: { type: 'boolean' },
    'no-worktree': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    force: { type: 'boolean' },
    'no-protect': { type: 'boolean' },
    dir: { type: 'string' },
    file: { type: 'string' },
    by: { type: 'string' },
    goal: { type: 'string' },
    criteria: { type: 'string', multiple: true },
    context: { type: 'string' },
    from: { type: 'string' },
  },
});

const [command, arg] = positionals;
const num = (v, what = '<n>') => {
  const n = Number(String(v ?? '').replace(/^#/, ''));
  if (!Number.isInteger(n) || n <= 0) throw new cmd.UserError(`Falta el número del pendiente ${what}.`);
  return n;
};

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
  } else if (command === 'add') {
    const r = cmd.add(arg, {
      goal: values.goal,
      criteria: values.criteria ?? [],
      context: values.context,
      blockedBy: values.by ? num(values.by, '--by <m>') : undefined,
      discoveredIn: values.from ? num(values.from, '--from <n>') : undefined,
    });
    print(r, (x) => `Pendiente #${x.number} abierto: ${x.title}${x.blockedBy ? ` (bloqueado por #${x.blockedBy})` : ''}\n  ${x.url}`);
  } else if (command === 'ready') {
    const list = cmd.ready();
    if (values.claim) {
      if (!list.length) throw new cmd.UserError('No hay pendientes listos.');
      const first = list[0];
      // Los que esperaban CI ya son tuyos: sólo se retoman, no se vuelven a reclamar.
      const result = first.state === 'esperando' ? { ...first, resumed: true } : cmd.claim(first.number, { worktree: !values['no-worktree'] });
      print(result, (r) => `Tomado #${r.number} ${r.title}${r.worktree ? `\n  worktree: ${r.worktree}\n  rama: ${r.branch}` : ''}${r.resumed ? `\n  retoma: ${r.reason}` : ''}`);
    } else {
      print(list, (l) => (l.length ? l.map((i) => `#${i.number}\t${i.reason}\t${i.title}`).join('\n') : 'No hay pendientes listos.'));
    }
  } else if (command === 'claim') {
    const r = cmd.claim(num(arg), { worktree: !values['no-worktree'] });
    print(r, (x) => `Tomado #${x.number} ${x.title}\n  rama: ${x.branch}${x.worktree ? `\n  worktree: ${x.worktree}` : ''}`);
  } else if (command === 'wait') {
    const r = cmd.wait(num(arg));
    print(r, (x) => `#${x.number} esperando el CI. Termina tu sesión: ghosty-dev ready te lo ofrece cuando resuelva.`);
  } else if (command === 'evidence') {
    const r = cmd.evidence(num(arg), values.file);
    print(r, (x) => `Evidencia publicada en #${x.number}.${x.rerun ? ` Puerta del PR re-ejecutada (run ${x.rerun}).` : ''}`);
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
      ].join('\n'),
    );
  } else if (command === 'close') {
    const r = cmd.close(num(arg));
    print(r, (x) => `#${x.number} cerrado con evidencia.`);
  } else {
    throw new cmd.UserError(`Comando desconocido: ${command}. Usa ghosty-dev --help.`);
  }
} catch (e) {
  console.error(e instanceof cmd.UserError ? e.message : `Error: ${e.message}`);
  process.exit(1);
}
