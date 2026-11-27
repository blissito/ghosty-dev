// claim deja el worktree listo para trabajar (feedback del 26-nov).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, lstatSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installerFor, needsTypegen, prepareWorktree } from '../src/worktree-deps.mjs';

const dir = (files = {}) => {
  const d = mkdtempSync(join(tmpdir(), 'gd-wt-'));
  for (const [f, c] of Object.entries(files)) writeFileSync(join(d, f), c);
  return d;
};

test('installerFor elige el gestor por lockfile', () => {
  assert.deepEqual(installerFor(dir({ 'package.json': '{}', 'package-lock.json': '{}' })).tool, 'npm');
  assert.equal(installerFor(dir({ 'package.json': '{}', 'pnpm-lock.yaml': '' })).tool, 'pnpm');
  assert.equal(installerFor(dir({ 'package.json': '{}', 'bun.lock': '' })).tool, 'bun');
  assert.equal(installerFor(dir({ 'README.md': 'x' })), null);
});

test('needsTypegen con @react-router/dev', () => {
  assert.equal(needsTypegen(dir({ 'package.json': JSON.stringify({ devDependencies: { '@react-router/dev': '7' } }) })), true);
  assert.equal(needsTypegen(dir({ 'package.json': '{}' })), false);
});

test('--fast enlaza el node_modules del clon principal; --no-install no toca nada', () => {
  const main = dir({ 'package.json': '{}', 'package-lock.json': '{}' });
  mkdirSync(join(main, 'node_modules'));
  const wt = dir({ 'package.json': '{}', 'package-lock.json': '{}' });
  assert.equal(prepareWorktree(wt, main, { mode: 'skip' }).how, 'skip');
  assert.equal(existsSync(join(wt, 'node_modules')), false);
  const r = prepareWorktree(wt, main, { mode: 'link' });
  assert.equal(r.done, true);
  assert.ok(lstatSync(join(wt, 'node_modules')).isSymbolicLink());
});

test('sin node_modules que enlazar avisa con el comando, sin tumbar el claim', () => {
  const r = prepareWorktree(dir({ 'package.json': '{}', 'package-lock.json': '{}' }), dir(), { mode: 'link' });
  assert.equal(r.done, false);
  assert.match(r.warning, /npm ci/);
});
