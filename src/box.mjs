// La caja de la vista previa de un PR (SPEC §5c): el agente que escribe el PR desde su terminal la opera él mismo,
// sin un tercer agente: lee el log del build y del servidor, corre un comando en el checkout, reinicia la app o la
// rearma. API: /api/v2/me/repos/:owner/:name/prs/:pr/box con la sesión de ghosty-dev (permiso `dev`).
// La salida de la caja es texto ajeno: llega a la terminal sin secuencias de control, sin la llave de una liga de
// vista previa (`?k=…`) ni nada con forma de `Bearer …`, y con tope de largo.
import { checkRepo, request } from './auth.mjs';
import { UserError, repoFullName } from './commands.mjs';

export const OPS = ['logs', 'exec', 'restart', 'rebuild'];
const MAX_OUTPUT = 200_000;

const boxPath = (repo, pr) => {
  const [owner, name] = checkRepo(repo);
  return `/api/v2/me/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/prs/${pr}/box`;
};

// Texto de varias líneas que viene de la caja: se quedan \n y \t; fuera escapes ANSI/OSC, otros controles y marcas
// de dirección (un log podría reescribir la pantalla o esconder texto).
export function cleanOutput(v, max = MAX_OUTPUT) {
  let s = String(v ?? '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '') // OSC (títulos, hipervínculos)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI (colores, cursor)
    .replace(/\x1b[@-Z\\-_]?/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '')
    .replace(/([?&]k=)[^\s&"'<>]+/g, '$1[oculto]')
    .replace(/(bearer\s+)\S+/gi, '$1[oculto]');
  if (s.length > max) s = `[…recortado: ${s.length - max} caracteres antes]\n${s.slice(-max)}`;
  return s;
}

// Un comando en varios argumentos (lo que va después de `--`) en una sola línea de shell: cada argumento que no es
// seguro tal cual va entre comillas simples. Un solo argumento se manda como está (ya es una línea de shell).
export function shellJoin(parts) {
  if (parts.length === 1) return parts[0];
  return parts.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

const sha = (v) => (typeof v === 'string' && /^[0-9a-f]{7,64}$/i.test(v) ? v.toLowerCase() : null);
const code = (v) => (Number.isInteger(v) ? Math.max(0, Math.min(255, v)) : null);

const view = (repo, pr, op, r) => ({
  repo,
  pr,
  op,
  phase: typeof r?.phase === 'string' ? cleanOutput(r.phase, 40) : null,
  sha: sha(r?.sha),
  exitCode: code(r?.exitCode),
  text: r?.text == null ? '' : cleanOutput(r.text),
});

// op: logs | exec | restart | rebuild. `cmd` sólo con exec; `lines` sólo con logs.
export async function box(op, pr, { cmd, lines } = {}) {
  if (!OPS.includes(op)) throw new UserError(`Uso: ghosty-dev box ${OPS.join('|')} [<pr>] (exec: -- <comando…>)`);
  const repo = repoFullName();
  const path = boxPath(repo, pr);
  if (op === 'logs') {
    const n = lines === undefined ? 200 : Number(lines);
    if (!Number.isInteger(n) || n <= 0 || n > 5000) throw new UserError('--lines va de 1 a 5000.');
    return view(repo, pr, op, await request('GET', `${path}?lines=${n}`, undefined, { scope: 'dev' }));
  }
  if (op === 'exec') {
    if (!cmd || !cmd.trim()) throw new UserError('Falta el comando: ghosty-dev box exec [<pr>] -- <comando…>');
    if (cmd.length > 4000) throw new UserError('El comando pasa de 4000 caracteres.');
    return view(repo, pr, op, await request('POST', path, { op: 'exec', cmd }, { scope: 'dev' }));
  }
  return view(repo, pr, op, await request('POST', path, { op }, { scope: 'dev' }));
}

// exec sale con el código del comando (sin código: 1); logs y restart con 0 si respondieron; rebuild con 0.
export const exitCodeOf = (r) => (r.op === 'exec' || r.op === 'restart' ? r.exitCode ?? (r.op === 'exec' ? 1 : 0) : 0);
