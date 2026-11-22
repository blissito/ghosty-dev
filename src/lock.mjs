// ¿El lock coincide con package.json? (Formmy: un PR subió package.json sin su package-lock.json y la caja de la
// vista previa tronó en `npm ci`.) Sin red y sin instalar nada: se comparan las dependencias declaradas con las que
// el lock registra, en el commit que se va a subir (HEAD) o, si no hay commit, en el disco.
//   npm  → package-lock.json v2/v3: packages[""] (y cada workspace) contra su package.json
//   pnpm → pnpm-lock.yaml: importers["."].*.specifier (v6+) o specifiers (v5)
//   yarn → yarn.lock: cada `nombre@rango` declarado aparece como llave (classic) o `nombre@npm:rango` (berry)
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './gh.mjs';

const KINDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const FIX = { npm: 'npm install', pnpm: 'pnpm install', yarn: 'yarn install' };
const LOCKS = [['package-lock.json', 'npm'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn']];

function reader(dir, { rev = 'HEAD' } = {}) {
  const atRev = rev && git(['rev-parse', '--verify', '--quiet', rev], { cwd: dir, allowFail: true }) !== null;
  return (path) => {
    if (atRev) return git(['show', `${rev}:${path}`], { cwd: dir, allowFail: true });
    const f = join(dir, path);
    return existsSync(f) ? readFileSync(f, 'utf8') : null;
  };
}

const declared = (pkg, kinds = KINDS) => {
  const out = new Map();
  for (const k of kinds) for (const [name, spec] of Object.entries(pkg?.[k] ?? {})) if (!out.has(name)) out.set(name, String(spec));
  return out;
};

function diff(want, have) {
  const bad = [];
  for (const [name, spec] of want) {
    if (!have.has(name)) bad.push(`${name} falta en el lock`);
    else if (have.get(name) !== spec) bad.push(`${name}: ${spec} en package.json, ${have.get(name)} en el lock`);
  }
  for (const name of have.keys()) if (!want.has(name)) bad.push(`${name} sigue en el lock y ya no está en package.json`);
  return bad;
}

function checkNpm(read, lockText) {
  let lock;
  try {
    lock = JSON.parse(lockText);
  } catch {
    return ['package-lock.json no es JSON válido'];
  }
  if (!lock.packages) return []; // lockfile v1 (npm 6): sin la raíz declarada; no se juzga
  const bad = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path.includes('node_modules/') || path.startsWith('node_modules')) continue;
    const text = read(path ? `${path}/package.json` : 'package.json');
    if (text == null) continue;
    let pkg;
    try {
      pkg = JSON.parse(text);
    } catch {
      continue;
    }
    // npm no guarda peerDependencies del proyecto como requisito del lock de la raíz de la misma forma: se comparan
    // las tres que `npm ci` exige.
    const kinds = KINDS.slice(0, 3);
    bad.push(...diff(declared(pkg, kinds), declared(entry, kinds)).map((b) => (path ? `${path}: ${b}` : b)));
  }
  return bad;
}

// pnpm-lock.yaml sin parser: importers → "." → {dependencies,devDependencies,optionalDependencies} → nombre → specifier.
function checkPnpm(pkg, text) {
  const have = new Map();
  const lines = text.split('\n');
  const v5 = lines.findIndex((l) => /^specifiers:\s*$/.test(l));
  if (v5 !== -1) {
    for (let i = v5 + 1; i < lines.length && /^\s+\S/.test(lines[i]); i++) {
      const m = lines[i].match(/^\s+['"]?([^'":]+(?::[^'":]+)?)['"]?:\s*['"]?(.+?)['"]?\s*$/);
      if (m) have.set(m[1], m[2]);
    }
  } else {
    let i = lines.findIndex((l) => /^importers:\s*$/.test(l));
    if (i === -1) return [];
    while (++i < lines.length && !/^\s{2}['"]?\.['"]?:\s*$/.test(lines[i])) if (/^\S/.test(lines[i])) return [];
    let name = null;
    for (i++; i < lines.length && (/^\s{4}/.test(lines[i]) || !lines[i].trim()); i++) {
      const dep = lines[i].match(/^\s{6}['"]?(.+?)['"]?:\s*$/);
      if (dep) name = dep[1];
      const spec = lines[i].match(/^\s{8}specifier:\s*['"]?(.+?)['"]?\s*$/);
      if (spec && name) have.set(name, spec[1]);
    }
  }
  return diff(declared(pkg, KINDS.slice(0, 3)), have);
}

function checkYarn(pkg, text) {
  const keys = new Set();
  for (const l of text.split('\n')) {
    if (!/^\S.*:\s*$/.test(l) || l.startsWith('#')) continue;
    for (const k of l.replace(/:\s*$/, '').split(/,\s*/)) keys.add(k.trim().replace(/^"|"$/g, ''));
  }
  const bad = [];
  for (const [name, spec] of declared(pkg, KINDS.slice(0, 3))) {
    if (/^(workspace|link|file|portal|patch):/.test(spec)) continue;
    if (!keys.has(`${name}@${spec}`) && !keys.has(`${name}@npm:${spec}`)) bad.push(`${name}@${spec} falta en el lock`);
  }
  return bad;
}

// { ok, tool, lock, problems, fix, message }. Sin package.json o sin lock: ok (nada que comparar).
export function checkLock(dir, opts) {
  const read = reader(dir, opts);
  const pkgText = read('package.json');
  if (pkgText == null) return { ok: true, tool: null, lock: null, problems: [] };
  let pkg;
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    return { ok: false, tool: null, lock: null, problems: ['package.json no es JSON válido'], message: 'package.json no es JSON válido.' };
  }
  for (const [lock, tool] of LOCKS) {
    const text = read(lock);
    if (text == null) continue;
    const problems = tool === 'npm' ? checkNpm(read, text) : tool === 'pnpm' ? checkPnpm(pkg, text) : checkYarn(pkg, text);
    const ok = problems.length === 0;
    return { ok, tool, lock, problems, fix: FIX[tool], message: ok ? null : `${lock} no coincide con package.json (${problems.slice(0, 3).join('; ')}${problems.length > 3 ? `; y ${problems.length - 3} más` : ''}): corre \`${FIX[tool]}\` y súbelo.` };
  }
  return { ok: true, tool: null, lock: null, problems: [] };
}

// El hook pre-push que instala `init`: corre el chequeo sobre lo que se va a subir. Sin ghosty-dev en el PATH no
// bloquea (no se rompe el push de quien no lo tiene).
export const HOOK_MARK = '# ghosty-dev:pre-push';
export const PRE_PUSH = `#!/bin/sh
${HOOK_MARK} — chequeo del lock antes de subir (ghosty-dev init). Para saltarlo una vez: git push --no-verify
command -v ghosty-dev >/dev/null 2>&1 || exit 0
exec ghosty-dev check-lock
`;
