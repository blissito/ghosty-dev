// `pr`, `note` y la skill de usuario (0.11.0): lo que antes empujaba a gh/git a mano (Formmy #97) ya tiene comando,
// y la skill llega a cualquier sesión de Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, issue } from '../testkit/helpers.mjs';
import { installUserSkill, userSkillCheck } from '../src/user-skill.mjs';

// Un remoto bare para que `git push` funcione sin red.
function withOrigin(s) {
  const bare = mkdtempSync(join(tmpdir(), 'gd-origin-'));
  execFileSync('git', ['init', '-q', '--bare', bare]);
  const git = (...a) => execFileSync('git', a, { cwd: s.repo, stdio: 'pipe' });
  git('remote', 'add', 'origin', bare);
  git('push', '-q', 'origin', 'main');
  return git;
}

test('pr con una rama hecha a mano: la sube, abre el PR con «Closes #n» y toma el pendiente', () => {
  const s = setup({ issues: { 97: issue(97, 'Dominio de landings') } });
  const git = withOrigin(s);
  git('checkout', '-q', '-b', 'feat/landing-host');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'trabajo');
  const r = s.run('pr', '97', '--json');
  assert.equal(r.code, 0, r.err);
  const x = JSON.parse(r.out);
  assert.equal(x.created, true);
  assert.equal(x.branch, 'feat/landing-host');
  const pr = s.read().prs.find((p) => p.number === x.pr);
  assert.match(pr.body, /^Closes #97/);
  assert.equal(pr.title, 'Dominio de landings');
  assert.ok(s.read().issues[97].assignees.some((a) => (a.login ?? a) === 'agente-a'));
  assert.ok(git('ls-remote', 'origin', 'feat/landing-host').toString().includes('feat/landing-host'));
});

test('pr sin número toma #n de la rama ghosty-dev/<n>-…, y si ya hay PR lo liga en vez de duplicarlo', () => {
  const s = setup({ issues: { 5: issue(5, 'Salud') }, prs: [{ number: 40, title: 'Salud', url: 'https://github.com/acme/demo/pull/40', headRefName: 'ghosty-dev/5-salud', headRefOid: 'a'.repeat(40), body: 'sin liga' }] });
  const git = withOrigin(s);
  git('checkout', '-q', '-b', 'ghosty-dev/5-salud');
  const r = s.run('pr', '--json');
  assert.equal(r.code, 0, r.err);
  const x = JSON.parse(r.out);
  assert.equal(x.created, false);
  assert.equal(x.pr, 40);
  assert.equal(s.read().prs.length, 1);
  assert.match(s.read().prs[0].body, /Closes #5/);
});

test('pr en main se niega con qué hacer', () => {
  const s = setup({ issues: { 5: issue(5, 'Salud') } });
  withOrigin(s);
  const r = s.run('pr', '5');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /cambia a la rama del trabajo/);
});

test('note deja el avance sin código en la bitácora del pendiente', () => {
  const s = setup({ issues: { 97: issue(97, 'Dominio') } });
  const r = s.run('note', '97', 'DNS', 'delegado', '--json');
  assert.equal(r.code, 0, r.err);
  const c = s.read().issues[97].comments.at(-1).body;
  assert.match(c, /Nota/);
  assert.match(c, /DNS delegado/);
  assert.notEqual(s.run('note', '97').code, 0);
});

test('next sugiere ghosty-dev pr (ya no gh pr create) en una rama sin PR', () => {
  const s = setup({ issues: { 5: issue(5, 'Salud', { labels: ['ghosty-dev:tomado'] }) } });
  const git = withOrigin(s);
  git('checkout', '-q', '-b', 'ghosty-dev/5-salud');
  const r = s.run('next');
  assert.match(r.out + r.err, /ghosty-dev pr 5/);
  assert.doesNotMatch(r.out + r.err, /gh pr create/);
});

test('la skill de usuario se instala, se actualiza y doctor la revisa', () => {
  const home = mkdtempSync(join(tmpdir(), 'gd-claude-'));
  const path = join(home, 'skills', 'ghosty-dev', 'SKILL.md');
  const source = join(home, 'SKILL.md');
  writeFileSync(source, 'v1');
  assert.equal(userSkillCheck({ path, source }).ok, null);
  assert.equal(installUserSkill({ path, source }).action, 'installed');
  assert.equal(readFileSync(path, 'utf8'), 'v1');
  assert.equal(installUserSkill({ path, source }).action, 'same');
  assert.equal(userSkillCheck({ path, source }).ok, true);
  writeFileSync(source, 'v2');
  assert.equal(userSkillCheck({ path, source }).ok, null);
  assert.equal(installUserSkill({ path, source }).action, 'updated');
  assert.ok(existsSync(path));
});
