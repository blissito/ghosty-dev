// Deja el worktree de `claim` listo para trabajar (feedback del 26-nov: nacía sin node_modules y typecheck fallaba).
// Nunca tumba el claim: si algo falla, se avisa con el comando para hacerlo a mano.
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const INSTALL_TIMEOUT_MS = () => Number(process.env.GHOSTY_DEV_INSTALL_TIMEOUT_MS) || 600_000;

// El gestor y su instalación reproducible, según el lockfile del repo. null = no es un proyecto de Node.
export function installerFor(dir) {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return { tool: 'pnpm', args: ['install', '--frozen-lockfile'] };
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return { tool: 'bun', args: ['install', '--frozen-lockfile'] };
  if (existsSync(join(dir, 'yarn.lock'))) return { tool: 'yarn', args: ['install', '--frozen-lockfile'] };
  if (existsSync(join(dir, 'package-lock.json'))) return { tool: 'npm', args: ['ci', '--no-audit', '--no-fund'] };
  if (existsSync(join(dir, 'package.json'))) return { tool: 'npm', args: ['install', '--no-audit', '--no-fund'] };
  return null;
}

// ¿Usa React Router 7 (necesita `react-router typegen` antes del typecheck)?
export function needsTypegen(dir) {
  try {
    const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return Boolean({ ...p.dependencies, ...p.devDependencies }['@react-router/dev']);
  } catch {
    return false;
  }
}

/**
 * mode: 'install' (por defecto: instala con el lockfile), 'link' (enlaza el node_modules del clon principal: segundos,
 * pero comparte dependencias) o 'skip'. Regresa { done, how, warning }.
 */
export function prepareWorktree(path, mainDir, { mode = 'install', onProgress = () => {} } = {}) {
  if (mode === 'skip') return { done: false, how: 'skip', warning: null };
  const inst = installerFor(path);
  if (!inst) return { done: false, how: 'none', warning: null };
  if (existsSync(join(path, 'node_modules'))) return { done: true, how: 'present', warning: null };
  if (mode === 'link') {
    const src = join(mainDir, 'node_modules');
    if (!existsSync(src)) return { done: false, how: 'link', warning: `no hay ${src} para enlazar; instala en el worktree: cd ${path} && ${inst.tool} ${inst.args.join(' ')}` };
    symlinkSync(src, join(path, 'node_modules'), 'dir');
    onProgress(`node_modules enlazado desde ${mainDir}.`);
  } else {
    onProgress(`instalando dependencias (${inst.tool} ${inst.args.join(' ')}; tope ${Math.round(INSTALL_TIMEOUT_MS() / 1000)} s)…`);
    const r = spawnSync(inst.tool, inst.args, { cwd: path, stdio: 'ignore', timeout: INSTALL_TIMEOUT_MS() });
    if (r.error || r.status !== 0) {
      const why = r.error?.code === 'ENOENT' ? `no encontré ${inst.tool}` : r.error?.code === 'ETIMEDOUT' || r.signal ? 'se pasó del tope' : `salió con ${r.status}`;
      return { done: false, how: 'install', warning: `la instalación ${why}; hazla a mano: cd ${path} && ${inst.tool} ${inst.args.join(' ')} (o reintenta con --fast para enlazar el node_modules del clon)` };
    }
  }
  if (needsTypegen(path)) spawnSync('npx', ['react-router', 'typegen'], { cwd: path, stdio: 'ignore', timeout: 120_000 });
  return { done: true, how: mode, warning: null };
}
