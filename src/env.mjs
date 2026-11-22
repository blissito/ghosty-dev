// Variables (secretos) de la vista previa del repo en Ghosty Studio. Aquí sólo viajan NOMBRES hacia la pantalla:
// los valores salen del archivo que la persona nombra, van directo a gs y nunca se imprimen (ni en errores).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkRepo, plain, request } from './auth.mjs';
import { UserError, repoFullName } from './commands.mjs';

const MAX_BYTES = 32_000; // el tope de gs para el .env entero

// Nombres de un .env (KEY=valor, con `export` opcional). Comentarios y renglones vacíos fuera; el valor no se toca.
export function dotenvKeys(text) {
  const keys = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/);
    if (m && !keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
}

const envPath = (repo) => {
  const [owner, name] = checkRepo(repo);
  return `/api/v2/me/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/env`;
};

// Sólo los campos con nombres: si gs algún día mandara otra cosa, aquí no pasa.
const names = (x) => (Array.isArray(x) ? x.map((k) => plain(k, 200)) : null);
const risksOf = (x) => (Array.isArray(x) ? x.map((r) => ({ key: plain(r?.key, 200), risk: plain(r?.risk, 300) })) : []);

export async function ls() {
  const repo = repoFullName();
  const r = await request('GET', envPath(repo));
  return {
    repo: r.repo != null ? plain(r.repo, 200) : repo,
    workspace: r.workspace != null ? plain(r.workspace, 200) : null,
    rooms: names(r.rooms) ?? [],
    saved: names(r.saved),
    missing: names(r.missing) ?? [],
    risks: risksOf(r.risks),
    blocked: Array.isArray(r.blocked) ? r.blocked.map((b) => ({ id: plain(b?.id, 100), keys: names(b?.keys) ?? [] })) : [],
    canWrite: r.canWrite === true,
  };
}

// Lo que va a pasar, antes de mandar nada: la ruta, los nombres del archivo y qué pasa con las ya guardadas.
export async function plan(file, { replace = false } = {}) {
  if (!file) throw new UserError('Falta el archivo: ghosty-dev env push <archivo> [--replace] [--yes]. Nunca se lee un .env sin que lo nombres.');
  const path = resolve(file);
  if (!existsSync(path) || !statSync(path).isFile()) throw new UserError(`No existe el archivo ${path}.`);
  if (statSync(path).size > MAX_BYTES) throw new UserError(`${path} pasa de ${MAX_BYTES} bytes: Ghosty no lo acepta.`);
  const keys = dotenvKeys(readFileSync(path, 'utf8'));
  if (!keys.length) throw new UserError(`${path} no tiene variables (KEY=valor por renglón).`);
  const current = await ls();
  if (!current.canWrite) throw new UserError(`Sólo el dueño del espacio${current.workspace ? ` ${current.workspace}` : ''} guarda variables de ${current.repo}.`);
  const others = (current.saved ?? []).filter((k) => !keys.includes(k));
  return {
    repo: current.repo,
    workspace: current.workspace,
    file: path,
    keys,
    replace,
    // Sin --replace se quedan como están; con --replace se borran. null = gs no pudo leer las guardadas.
    kept: replace ? [] : current.saved ? others : null,
    removed: replace ? (current.saved ? others : null) : [],
  };
}

export function planText(p) {
  const lines = [`Lee: ${p.file}`, `Variables para ${p.repo}${p.workspace ? ` (espacio ${p.workspace})` : ''}: ${p.keys.join(', ')}`];
  if (p.replace) lines.push(p.removed === null ? 'Con --replace se borran todas las que ya estaban guardadas.' : p.removed.length ? `Con --replace se borran: ${p.removed.join(', ')}` : 'Con --replace no se borra ninguna otra.');
  else if (p.kept === null) lines.push('Las que ya estaban guardadas y no vienen en el archivo se quedan como están.');
  else if (p.kept.length) lines.push(`Se quedan como están (ya guardadas): ${p.kept.join(', ')}`);
  return lines.join('\n');
}

export async function push(p) {
  const dotenv = readFileSync(p.file, 'utf8');
  const r = await request('POST', envPath(p.repo), { dotenv, replace: p.replace });
  return {
    repo: r.repo != null ? plain(r.repo, 200) : p.repo,
    workspace: r.workspace != null ? plain(r.workspace, 200) : p.workspace,
    file: p.file,
    keys: names(r.keys) ?? [],
    sent: names(r.sent),
    kept: names(r.kept),
    dropped: names(r.dropped),
    risks: risksOf(r.risks),
    replace: p.replace,
  };
}
