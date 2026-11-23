// Una sola forma de instalar y actualizar (Formmy, fila 57: `npm i -g ghosty-dev@latest` da 404; no está en npm).
// `ghosty-dev update` reinstala desde la fuente oficial y dice versión vieja → nueva; `doctor` avisa si hay una nueva.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SOURCE = 'github:blissito/ghosty-dev';
export const INSTALL_LINE = `npm install -g ${SOURCE}`;
const RAW = 'https://raw.githubusercontent.com/blissito/ghosty-dev/main/package.json';

export const currentVersion = () => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;
// La versión de main en la fuente oficial. null sin red (GHOSTY_DEV_NO_NET o sin respuesta en 5 s).
export async function latestVersion({ fetchImpl = fetch } = {}) {
  if (process.env.GHOSTY_DEV_LATEST_VERSION) return VERSION.test(process.env.GHOSTY_DEV_LATEST_VERSION) ? process.env.GHOSTY_DEV_LATEST_VERSION : null;
  if (process.env.GHOSTY_DEV_NO_NET) return null;
  try {
    const res = await fetchImpl(RAW, { redirect: 'follow', signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const v = (await res.json())?.version;
    return typeof v === 'string' && VERSION.test(v) ? v : null;
  } catch {
    return null;
  }
}

// -1 si a < b, 0 si igual, 1 si a > b (sólo mayor.menor.parche).
export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).slice(0, 3).map(Number);
  const pb = String(b).split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  return 0;
}

export function versionCheck(current, latest) {
  if (!latest) return { name: 'version', ok: null, detail: `ghosty-dev ${current}; no pude ver si hay una versión nueva`, fix: null };
  if (compareVersions(current, latest) < 0) return { name: 'version', ok: null, detail: `ghosty-dev ${current}; ya hay ${latest}`, fix: `ghosty-dev update (o: ${INSTALL_LINE})` };
  return { name: 'version', ok: true, detail: `ghosty-dev ${current} (la más reciente)`, fix: null };
}

// Reinstala desde la fuente oficial. `run` y `globalRoot` se cambian en las pruebas.
export function update({ run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }), globalRoot = () => spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout?.trim() } = {}) {
  const before = currentVersion();
  const r = run('npm', ['install', '-g', SOURCE]);
  if (r.status !== 0) return { ok: false, before, after: null, line: INSTALL_LINE };
  let after = null;
  try {
    after = JSON.parse(readFileSync(join(globalRoot(), 'ghosty-dev', 'package.json'), 'utf8')).version;
  } catch {}
  return { ok: true, before, after, line: INSTALL_LINE };
}

export const updateText = (r) =>
  !r.ok
    ? `No se pudo reinstalar. Corre a mano: ${r.line}\n  (sin permisos: no uses sudo; usa npx -y ${SOURCE} en lugar de ghosty-dev)`
    : r.after && r.after !== r.before
      ? `ghosty-dev ${r.before} → ${r.after}`
      : `ghosty-dev ${r.after ?? r.before}: ya era la más reciente.`;
