import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseRef, hasRepo, findCheckout, suspectRepo, repoOfRemote, refText } from '../src/ref.mjs';
import { setup, issue } from '../testkit/helpers.mjs';

const clone = (dir, remote) => {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
};

test('parseRef acepta n, #n, owner/repo#n y la URL', () => {
  assert.deepEqual(parseRef('94'), { repo: null, n: 94 });
  assert.deepEqual(parseRef('#94'), { repo: null, n: 94 });
  assert.deepEqual(parseRef('blissito/ghosty-studio#94'), { repo: 'blissito/ghosty-studio', n: 94 });
  assert.deepEqual(parseRef('https://github.com/blissito/formmy/issues/7'), { repo: 'blissito/formmy', n: 7 });
  assert.deepEqual(parseRef('https://github.com/blissito/formmy/pull/8'), { repo: 'blissito/formmy', n: 8 });
  for (const bad of ['', 'x', '0', '#', 'a/b', 'a/b#', '1.5']) assert.throws(() => parseRef(bad), /Falta el número/);
  assert.equal(hasRepo('a/b#1'), true);
  assert.equal(hasRepo('#1'), false);
  assert.equal(refText({ repo: 'a/b', n: 3 }, 'a/b'), '#3');
  assert.equal(refText({ repo: 'a/b', n: 3 }, 'c/d'), 'a/b#3');
  assert.equal(repoOfRemote('git@github.com:blissito/formmy.git'), 'blissito/formmy');
});

test('suspectRepo: prefijo de repo en el título o mención del mismo dueño en el cuerpo', () => {
  assert.equal(suspectRepo({ title: 'gs: pages/publish para partners' }, 'blissito/formmy'), 'blissito/ghosty-studio');
  assert.equal(suspectRepo({ title: 'gs: algo' }, 'blissito/ghosty-studio'), null);
  assert.equal(suspectRepo({ title: 'fix: algo' }, 'blissito/formmy'), null);
  assert.equal(suspectRepo({ title: 'x', body: 'el trabajo va en blissito/ghosty-studio' }, 'blissito/formmy'), 'blissito/ghosty-studio');
  assert.equal(suspectRepo({ title: 'x', body: 'ver src/lib/a.ts y blissito/formmy' }, 'blissito/formmy'), null);
});

test('findCheckout ubica el clon por su remoto, no por el nombre de la carpeta', () => {
  const root = mkdtempSync(join(tmpdir(), 'refs-'));
  clone(join(root, 'proyectos', 'cosa-rara'), 'git@github.com:blissito/ghosty-studio.git');
  clone(join(root, 'otro'), 'https://github.com/blissito/formmy.git');
  assert.equal(findCheckout('blissito/ghosty-studio', { cwd: root, roots: [root] }), join(root, 'proyectos', 'cosa-rara'));
  assert.equal(findCheckout('Blissito/Formmy', { cwd: root, roots: [root] }), join(root, 'otro'));
  assert.equal(findCheckout('blissito/nada', { cwd: root, roots: [root] }), null);
});

const withRemote = (s, remote) => execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: s.repo });

test('show owner/repo#n de otro repo corre allá (GH_REPO) y imprime el número completo', () => {
  const s = setup({ issues: { 3: issue(3, 'Cosa') } });
  withRemote(s, 'git@github.com:acme/demo.git');
  const r = s.run('show', 'acme/otro#3');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^acme\/otro#3 Cosa/);
  assert.match(r.err, /Repo: acme\/otro · sin clon local/);
  const db = s.read();
  assert.ok(db.callRepos.some((x) => x === 'acme/otro'));
  assert.ok(db.callRepos.every((x) => x === 'acme/otro'), 'ninguna llamada quedó en el repo del directorio');
});

test('con el repo propio, owner/repo#n es lo mismo que n y no cambia nada', () => {
  const s = setup({ issues: { 3: issue(3, 'Cosa') } });
  withRemote(s, 'git@github.com:acme/demo.git');
  const r = s.run('show', 'acme/demo#3');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^#3 Cosa/);
  assert.ok(s.read().callRepos.every((x) => x === null));
});

test('claim de otro repo sin clon local no toca nada y dice cómo clonarlo', () => {
  const s = setup({ issues: { 94: issue(94, 'gs: pages/publish') } });
  withRemote(s, 'git@github.com:acme/demo.git');
  const r = s.run('claim', 'acme/ghosty-studio#94');
  assert.equal(r.code, 1);
  assert.match(r.err, /gh repo clone acme\/ghosty-studio ~\/ghosty-studio/);
  assert.match(r.err, /ghosty-dev claim acme\/ghosty-studio#94/);
  assert.equal(s.read().issues[94].assignees.length, 0);
  assert.ok(s.read().calls.every((c) => c[0] === 'api' && c[2] === 'GET'));
});

test('claim owner/repo#n entra al clon de ese repo y crea allí la rama y el worktree', async () => {
  const s = setup({ issues: { 94: issue(94, 'Publicar para partners') } });
  withRemote(s, 'git@github.com:acme/demo.git');
  const roots = realpathSync(mkdtempSync(join(tmpdir(), 'roots-')));
  const gsDir = join(roots, 'gs');
  clone(gsDir, 'git@github.com:acme/ghosty-studio.git');
  const r = await s.runAsync(['claim', 'acme/ghosty-studio#94', '--json', '--base', 'main'], { extra: { GHOSTY_DEV_REPOS: roots } });
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  assert.equal(out.repo, 'acme/ghosty-studio');
  assert.equal(out.worktree, join(roots, 'gs-94'));
  assert.ok(existsSync(join(roots, 'gs-94')));
  assert.equal(existsSync(join(s.root, 'demo-94')), false, 'nada en el repo del directorio');
  assert.ok(s.read().callRepos.every((x) => x === 'acme/ghosty-studio'));
});

test('claim avisa (sin bloquear) cuando el título trae el prefijo de otro repo', () => {
  const s = setup({ issues: { 94: issue(94, 'gs: pages/publish para partners con dominio base propio') } });
  withRemote(s, 'git@github.com:blissito/formmy.git');
  const r = s.run('claim', '94', '--no-worktree');
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /este pendiente parece de blissito\/ghosty-studio; usa `ghosty-dev claim blissito\/ghosty-studio#N`.*add --repo blissito\/ghosty-studio/);
  assert.deepEqual(s.read().issues[94].assignees, ['agente-a']);
});

test('add --repo abre el pendiente en otro repo con enlace cruzado y etiquetas allí', () => {
  const s = setup({ issues: { 7: issue(7, 'Origen') } });
  const r = s.run('add', 'Publicar para partners', '--repo', 'acme/ghosty-studio', '--from', '7', '--goal', 'g', '--criteria', 'c', '--json');
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  assert.equal(out.ref, 'acme/ghosty-studio#8');
  const db = s.read();
  assert.match(db.issues[8].body, /Descubierto en acme\/demo#7\./);
  const at = (pred) => db.calls.map((c, i) => [c, db.callRepos[i]]).filter(([c]) => pred(c));
  assert.ok(at((c) => c.some((a) => /issues$/.test(a)) && c.includes('POST')).every(([, repo]) => repo === 'acme/ghosty-studio'));
  assert.ok(at((c) => c.some((a) => /labels$/.test(a))).some(([, repo]) => repo === 'acme/ghosty-studio'));
  const comment = at((c) => c.some((a) => /issues\/7\/comments$/.test(a)));
  assert.equal(comment.length, 1);
  assert.equal(comment[0][1], 'acme/demo');
  assert.match(db.issues[7].comments.at(-1)?.body ?? '', /acme\/ghosty-studio#8/);
});

test('block --by owner/repo#m guarda la referencia completa', () => {
  const s = setup({ issues: { 2: issue(2, 'Uno'), 5: issue(5, 'Otro repo') }, depsApi: false });
  const r = s.run('block', '2', '--by', 'acme/otro#5');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /bloqueado por acme\/otro#5/);
  assert.match(s.read().issues[2].body, /## Bloqueado por\n- acme\/otro#5\n/);
});
