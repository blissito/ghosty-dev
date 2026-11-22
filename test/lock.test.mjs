// El lock tiene que coincidir con package.json antes de subir (C30): check-lock, el pre-push de init, evidence y next.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRE_PUSH, checkLock } from '../src/lock.mjs';

const BIN = new URL('../bin/ghosty-dev.mjs', import.meta.url).pathname;
import { setup, issue, VALID_EVIDENCE, SHA } from '../testkit/helpers.mjs';

const dirWith = (files) => {
  const d = mkdtempSync(join(tmpdir(), 'lock-'));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(d, f, '..'), { recursive: true });
    writeFileSync(join(d, f), typeof text === 'string' ? text : JSON.stringify(text));
  }
  return d;
};
const pkg = { name: 'app', dependencies: { react: '^18.2.0' }, devDependencies: { vitest: '^2.0.0' } };
const npmLock = (deps) => ({ lockfileVersion: 3, packages: { '': { name: 'app', ...deps }, 'node_modules/react': { version: '18.2.0' } } });

test('npm: coincide, dependencia nueva sin lock, rango distinto y sobrante; workspaces (C30)', () => {
  assert.equal(checkLock(dirWith({ 'package.json': pkg, 'package-lock.json': npmLock({ dependencies: { react: '^18.2.0' }, devDependencies: { vitest: '^2.0.0' } }) }), { rev: null }).ok, true);
  const r = checkLock(dirWith({ 'package.json': { ...pkg, dependencies: { react: '^19.0.0', zod: '^3' } }, 'package-lock.json': npmLock({ dependencies: { react: '^18.2.0', lodash: '^4' }, devDependencies: { vitest: '^2.0.0' } }) }), { rev: null });
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, ['react: ^19.0.0 en package.json, ^18.2.0 en el lock', 'zod falta en el lock', 'lodash sigue en el lock y ya no está en package.json']);
  assert.match(r.message, /^package-lock\.json no coincide con package\.json \(react: .*\): corre `npm install` y súbelo\.$/);
  const ws = checkLock(dirWith({ 'package.json': { name: 'r', workspaces: ['packages/*'] }, 'packages/a/package.json': { name: 'a', dependencies: { zod: '^3' } }, 'package-lock.json': { lockfileVersion: 3, packages: { '': { name: 'r', workspaces: ['packages/*'] }, 'packages/a': { name: 'a', dependencies: { zod: '^2' } } } } }), { rev: null });
  assert.deepEqual(ws.problems, ['packages/a: zod: ^3 en package.json, ^2 en el lock']);
  assert.equal(checkLock(dirWith({ 'package.json': pkg }), { rev: null }).ok, true); // sin lock: nada que comparar
});

test('pnpm (v6+ importers y v5 specifiers) y yarn (classic y berry) (C30)', () => {
  const pnpm9 = `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      react:\n        specifier: ^18.2.0\n        version: 18.2.0\n    devDependencies:\n      vitest:\n        specifier: ^2.0.0\n        version: 2.0.0\n\npackages:\n`;
  assert.equal(checkLock(dirWith({ 'package.json': pkg, 'pnpm-lock.yaml': pnpm9 }), { rev: null }).ok, true);
  const bad = checkLock(dirWith({ 'package.json': { ...pkg, dependencies: { react: '^18.2.0', zod: '^3' } }, 'pnpm-lock.yaml': pnpm9 }), { rev: null });
  assert.deepEqual([bad.ok, bad.problems, bad.fix], [false, ['zod falta en el lock'], 'pnpm install']);
  const pnpm5 = `lockfileVersion: 5.4\n\nspecifiers:\n  react: ^18.2.0\n  vitest: ^2.0.0\n\ndependencies:\n  react: 18.2.0\n`;
  assert.equal(checkLock(dirWith({ 'package.json': pkg, 'pnpm-lock.yaml': pnpm5 }), { rev: null }).ok, true);
  const yarn1 = `# yarn lockfile v1\n\n\nreact@^18.2.0:\n  version "18.2.0"\n\n"vitest@^2.0.0", vitest@^2.0.1:\n  version "2.0.1"\n`;
  assert.equal(checkLock(dirWith({ 'package.json': pkg, 'yarn.lock': yarn1 }), { rev: null }).ok, true);
  const berry = `__metadata:\n  version: 8\n\n"react@npm:^18.2.0":\n  version: 18.2.0\n\n"vitest@npm:^2.0.0":\n  version: 2.0.0\n`;
  assert.equal(checkLock(dirWith({ 'package.json': pkg, 'yarn.lock': berry }), { rev: null }).ok, true);
  assert.deepEqual(checkLock(dirWith({ 'package.json': { ...pkg, dependencies: { react: '^19' } }, 'yarn.lock': yarn1 }), { rev: null }).problems, ['react@^19 falta en el lock']);
});

const commit = (s, files, msg = 'deps') => {
  for (const [f, v] of Object.entries(files)) writeFileSync(join(s.repo, f), JSON.stringify(v));
  spawnSync('git', ['add', '-A'], { cwd: s.repo });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg], { cwd: s.repo });
};

test('check-lock mira HEAD (lo que se sube); evidence se niega; next da el paso; init instala el pre-push sin pisar uno ajeno (C30)', () => {
  const s = setup({ issues: { 5: issue(5, 'Salud') } });
  commit(s, { 'package.json': { ...pkg, dependencies: { react: '^18.2.0', zod: '^3' } }, 'package-lock.json': npmLock({ dependencies: { react: '^18.2.0' }, devDependencies: { vitest: '^2.0.0' } }) });
  const r = s.run('check-lock');
  assert.equal(r.code, 1);
  assert.match(r.out, /package-lock\.json no coincide con package\.json \(zod falta en el lock\): corre `npm install` y súbelo\./);
  writeFileSync(join(s.repo, 'evidencia.md'), VALID_EVIDENCE);
  const ev = s.run('evidence', '5', '--file', 'evidencia.md');
  assert.equal(ev.code, 1);
  assert.match(ev.err, /package-lock\.json no coincide/);
  assert.match(s.run('ready').err, /Aviso: package-lock\.json no coincide/);
  // Arreglado en el disco pero sin commit: HEAD todavía no coincide.
  writeFileSync(join(s.repo, 'package-lock.json'), JSON.stringify(npmLock({ dependencies: { react: '^18.2.0', zod: '^3' }, devDependencies: { vitest: '^2.0.0' } })));
  assert.equal(s.run('check-lock').code, 1);
  commit(s, {}, 'lock');
  assert.equal(s.run('check-lock').code, 0);
  // init: pre-push con la marca; uno ajeno no se pisa.
  const hooks = join(s.repo, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  const plan = JSON.parse(s.run('init', '--dry-run', '--json').out);
  assert.ok(plan.some((p) => p.action === 'write' && p.path === '.git/hooks/pre-push'));
  writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\necho mio\n');
  chmodSync(join(hooks, 'pre-push'), 0o755);
  const plan2 = JSON.parse(s.run('init', '--dry-run', '--json').out);
  assert.match(plan2.find((p) => p.path === '.git/hooks/pre-push').name, /ya hay un pre-push propio: agrégale «ghosty-dev check-lock»/);
});

test('el hook pre-push de init bloquea un push con el lock desfasado y deja pasar sin ghosty-dev en el PATH (C30)', () => {
  const s = setup({});
  commit(s, { 'package.json': { ...pkg, dependencies: { zod: '^3' } }, 'package-lock.json': npmLock({ dependencies: { react: '^18.2.0' } }) });
  const hook = join(s.root, 'pre-push');
  writeFileSync(hook, PRE_PUSH, { mode: 0o755 });
  const shim = join(s.root, 'bin');
  mkdirSync(shim);
  writeFileSync(join(shim, 'ghosty-dev'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, { mode: 0o755 });
  const run = (path) => spawnSync('/bin/sh', [hook], { cwd: s.repo, encoding: 'utf8', env: { ...process.env, PATH: path } });
  const blocked = run(`${shim}:/usr/bin:/bin`);
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.match(blocked.stdout, /corre `npm install` y súbelo/);
  assert.equal(run('/usr/bin:/bin').status, 0);
});

test('next pone primero el pedido automático de gs en el PR, antes del lock y del conflicto (C30)', () => {
  const bot = { login: 'ghosty-studio[bot]', type: 'Bot' };
  const s = setup({ issues: { 5: issue(5, 'Salud') }, prs: [{ number: 76, title: 'x', url: 'https://github.com/acme/demo/pull/76', headRefName: 'fix/x', headRefOid: SHA, body: 'Closes #5', mergeable: false, mergeableState: 'dirty', comments: [{ author: bot, body: `<!-- ghosty-dev:pedido -->\nLa vista previa del commit ${SHA.slice(0, 7)} no arma: npm ci falló.` }] }] });
  spawnSync('git', ['checkout', '-q', '-b', 'fix/x'], { cwd: s.repo });
  const n = JSON.parse(s.run('next', '--json').out);
  assert.deepEqual([n.step, n.command], ['pedido', 'ghosty-dev asks 5']);
  assert.match(s.run('asks', '5').out, /La vista previa del commit .* no arma/);
  assert.equal(JSON.parse(s.run('next', '--json').out).step, 'conflicto');
});
