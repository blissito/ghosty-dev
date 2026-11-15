// Envoltura mínima sobre `gh` y `git`. BITACORA_GH permite cambiar el binario (los tests usan un gh falso).
import { execFileSync } from 'node:child_process';

function run(bin, args, { input, allowFail, cwd } = {}) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', input, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    if (allowFail) return null;
    const detail = (e.stderr || e.message || '').toString().trim();
    throw new Error(`${bin} ${args.join(' ')} falló: ${detail}`);
  }
}

export const gh = (args, opts) => run(process.env.BITACORA_GH || 'gh', args, opts);

export function ghJson(args, opts) {
  const out = gh(args, opts);
  return out == null ? null : JSON.parse(out);
}

export const git = (args, opts) => run('git', args, opts);
