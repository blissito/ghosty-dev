import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isDepsFile, npmDeps, requirementsDeps, pyprojectDeps, addedDeps, levenshtein, typosquatOf, installScripts,
  severityLevel, newSevereVulns, isMigrationSql, migrationDialect, squawkVerdict, bundleVerdict, coverageCommand, humanBytes,
} from '../.github/ghosty-checks/lib.mjs';

test('detecta archivos de dependencias y deja fuera node_modules', () => {
  assert.ok(isDepsFile('package.json'));
  assert.ok(isDepsFile('apps/web/pnpm-lock.yaml'));
  assert.ok(isDepsFile('requirements-dev.txt'));
  assert.equal(isDepsFile('node_modules/x/package.json'), false);
  assert.equal(isDepsFile('src/app.ts'), false);
});

test('paquetes nuevos de package.json, con alias npm: y especificaciones fuera del registro', () => {
  const base = npmDeps(JSON.stringify({ dependencies: { react: '^19' } }));
  const head = npmDeps(JSON.stringify({
    dependencies: { react: '^19', 'left-padd-xyz-ghosty': '1.0.0', lp: 'npm:left-pad@1.3.0' },
    devDependencies: { mine: 'workspace:*', fork: 'github:me/fork', short: 'me/fork' },
  }));
  const added = addedDeps(base, head);
  assert.deepEqual(added.map((d) => d.name).sort(), ['fork', 'left-pad', 'left-padd-xyz-ghosty', 'mine', 'short']);
  assert.equal(added.find((d) => d.name === 'left-pad').registry, true);
  for (const n of ['mine', 'fork', 'short']) assert.equal(added.find((d) => d.name === n).registry, false, n);
});

test('requirements.txt y pyproject.toml', () => {
  assert.deepEqual(requirementsDeps('Django>=5\n# x\n-r base.txt\nrequests_oauthlib==1 # c\ngit+https://x/y\n').map((d) => d.name), ['django', 'requests-oauthlib']);
  const py = pyprojectDeps(`[project]
name = "x"
authors = ["Ana <a@b>"]
dependencies = [
  "fastapi>=0.1",
  "pydantic",
]
[project.optional-dependencies]
dev = ["pytest"]
[tool.poetry.dependencies]
python = "^3.12"
httpx = "^0.27"
`);
  assert.deepEqual(py.map((d) => d.name).sort(), ['fastapi', 'httpx', 'pydantic', 'pytest']);
});

test('typosquat por distancia de Levenshtein contra los populares', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(typosquatOf('expresss', 'npm'), 'express');
  assert.equal(typosquatOf('lodahs', 'npm'), 'lodash');
  assert.equal(typosquatOf('left_pad', 'npm'), 'left-pad');
  assert.equal(typosquatOf('reqeusts', 'pypi'), 'requests');
  assert.equal(typosquatOf('express', 'npm'), null);
  assert.equal(typosquatOf('fastify-plugin-xyz', 'npm'), null);
  // Nombres cortos: sólo a 1 letra (a 2 ya no cuenta).
  assert.equal(typosquatOf('vxtx', 'npm'), null);
  assert.equal(typosquatOf('vit', 'npm'), 'vite');
});

test('scripts al instalar', () => {
  assert.deepEqual(installScripts({ scripts: { postinstall: 'node x', test: 'x' } }), ['postinstall']);
  assert.deepEqual(installScripts({ gypfile: true }), ['install (node-gyp)']);
  assert.deepEqual(installScripts(undefined), []);
});

test('sólo las HIGH/CRITICAL nuevas cuentan', () => {
  const scan = (groups) => ({ results: [{ source: { path: 'package-lock.json' }, packages: [{ package: { name: 'minimist', version: '1.2.0' }, groups }] }] });
  const base = scan([{ ids: ['GHSA-old'], max_severity: '9.8' }]);
  const head = scan([{ ids: ['GHSA-old'], max_severity: '9.8' }, { ids: ['GHSA-new'], max_severity: '7.5' }, { ids: ['GHSA-low'], max_severity: '5.0' }]);
  assert.deepEqual(newSevereVulns(base, head).map((v) => v.ids[0]), ['GHSA-new']);
  assert.equal(severityLevel('9.8'), 'CRITICAL');
  assert.equal(severityLevel(''), 'UNKNOWN');
});

test('migraciones: carpeta, dialecto y veredicto de squawk', () => {
  assert.ok(isMigrationSql('prisma/migrations/20261121_x/migration.sql'));
  assert.ok(isMigrationSql('db/migrate/001.sql'));
  assert.equal(isMigrationSql('scripts/seed.sql'), false);
  const root = mkdtempSync(join(tmpdir(), 'gc-'));
  mkdirSync(join(root, 'prisma/migrations/1_x'), { recursive: true });
  writeFileSync(join(root, 'prisma/migrations/migration_lock.toml'), 'provider = "sqlite"\n');
  assert.equal(migrationDialect(root, 'prisma/migrations/1_x/migration.sql'), 'sqlite');
  writeFileSync(join(root, 'prisma/migrations/migration_lock.toml'), 'provider = "postgresql"\n');
  assert.equal(migrationDialect(root, 'prisma/migrations/1_x/migration.sql'), 'postgres');
  assert.equal(migrationDialect(root, 'migrations/001.sql'), 'postgres');
  const v = squawkVerdict([{ rule_name: 'adding-required-field' }, { rule_name: 'require-concurrent-index-creation' }]);
  assert.equal(v.blocking.length, 1);
  assert.equal(v.soft.length, 1);
});

test('bundle: aviso arriba de 20 %', () => {
  assert.deepEqual(bundleVerdict(100, 130), { delta: 30, pct: 0.3, warn: true });
  assert.equal(bundleVerdict(100, 110).warn, false);
  assert.equal(bundleVerdict(null, 110).delta, null);
  assert.equal(humanBytes(2048), '2.0 KB');
});

test('cobertura: sólo si el repo ya la genera', () => {
  assert.deepEqual(coverageCommand({ scripts: { 'test:coverage': 'vitest --coverage' } }), { kind: 'script', script: 'test:coverage' });
  assert.equal(coverageCommand({ devDependencies: { vitest: '3' } }, { vitestConfig: 'export default {}' }), null);
  assert.equal(coverageCommand({ devDependencies: { vitest: '3' } }, { vitestConfig: 'test: { coverage: { provider: "v8" } }' }).kind, 'vitest');
  assert.equal(coverageCommand({ devDependencies: { jest: '29' }, jest: { collectCoverage: true } }).kind, 'jest');
  assert.equal(coverageCommand({ scripts: { test: 'node --test' } }), null);
});
