// Envoltura mínima sobre `gh` y `git`. GHOSTY_DEV_GH permite cambiar el binario (los tests usan un gh falso).
import { execFileSync } from 'node:child_process';

function run(bin, args, { input, allowFail, cwd, timeout } = {}) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', input, cwd, timeout, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    if (allowFail) return null;
    const detail = (e.stderr || e.message || '').toString().trim();
    throw new Error(`${bin} ${args.join(' ')} falló: ${detail}`);
  }
}

export const gh = (args, opts) => run(process.env.GHOSTY_DEV_GH || 'gh', args, opts);

export function ghJson(args, opts) {
  const out = gh(args, opts);
  return out == null ? null : JSON.parse(out);
}

export const git = (args, opts) => run('git', args, opts);

// API REST de GitHub. Todo el CLI habla REST (nada de `gh issue`/`gh pr`, que usan GraphQL): así el mismo CLI
// funciona detrás de un intermediario que sólo deja pasar rutas REST acotadas. `{owner}/{repo}` los resuelve gh.
export function api(method, path, body, { allowFail, cwd } = {}) {
  const args = ['api', '-X', method, path];
  if (body !== undefined) args.push('--input', '-');
  const out = gh(args, { allowFail, cwd, input: body === undefined ? undefined : JSON.stringify(body) });
  if (out == null) return null;
  return out.trim() ? JSON.parse(out) : {};
}

// Listas completas, de 100 en 100 (tope 10 páginas). `pick` saca el arreglo cuando viene envuelto.
export function apiAll(path, { pick = (x) => x, allowFail, cwd } = {}) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const res = api('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, undefined, { allowFail, cwd });
    if (res == null) return allFail(all, allowFail);
    const items = pick(res) || [];
    all.push(...items);
    if (items.length < 100) break;
  }
  return all;
}
const allFail = (all, allowFail) => (allowFail && all.length === 0 ? null : all);
