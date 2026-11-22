// «Depende de #N» en la descripción del PR (C23): ghosty-dev la escribe sola si el PR va apilado sobre otro PR
// abierto o trae su commit, sin duplicar lo que ya dice el cuerpo, y la quita cuando ese PR ya entró.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEPS_MARK, dependsOn, syncDepsLines } from '../src/deps.mjs';
import { setup } from '../testkit/helpers.mjs';

test('dependsOn reconoce las mismas formas que Ghosty Studio (C23)', () => {
  assert.deepEqual(dependsOn('Depende de #76\nstacked on #80\nafter #3 · depends on: #76', 99), [76, 80, 3]);
  assert.deepEqual(dependsOn('depende de #9', 9), []);
});

test('syncDepsLines agrega sin duplicar, respeta lo que escribió una persona y quita sólo lo suyo (C23)', () => {
  const a = syncDepsLines('Closes #5', [12]);
  assert.equal(a.body, `Closes #5\n\nDepende de #12 ${DEPS_MARK}\n`);
  assert.equal(syncDepsLines(a.body, [12]).changed, false);
  assert.equal(syncDepsLines('Closes #5\nstacked on #12', [12]).changed, false);
  const gone = syncDepsLines(`${a.body}después de #4\n`, []);
  assert.deepEqual(gone.removed, [12]);
  assert.equal(gone.body, 'Closes #5\n\ndespués de #4\n');
});

test('ghosty-dev deps: apilado sobre la rama de otro PR → «Depende de #N»; al entrar ese PR, se quita (C23)', () => {
  const s = setup({
    prs: [
      { number: 10, url: 'https://github.com/acme/demo/pull/10', headRefName: 'feat/base', headRefOid: 'aaa111', baseRefName: 'main' },
      { number: 11, url: 'https://github.com/acme/demo/pull/11', headRefName: 'feat/encima', headRefOid: 'bbb222', baseRefName: 'feat/base', body: 'Closes #5' },
      { number: 12, url: 'https://github.com/acme/demo/pull/12', headRefName: 'feat/sobre-commit', headRefOid: 'ccc333', baseRefName: 'main', body: '' },
    ],
    ancestors: ['aaa111...ccc333'],
  });
  const r = s.run('deps', '11', '--json');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out).added, [10]);
  assert.equal(s.read().prs[1].body, `Closes #5\n\nDepende de #10 ${DEPS_MARK}\n`);
  // Otra vez: no se duplica ni se vuelve a escribir.
  s.run('deps', '11');
  assert.equal(s.read().prs[1].bodyEdits, 1);
  // Armado sobre el commit de #10 aunque su base sea main.
  assert.match(s.run('deps', '12').out, /PR #12: depende de #10\.\n {2}agregué: Depende de #10/);
  // #10 entra: la línea se quita.
  const db = s.read();
  db.prs[0].state = 'closed';
  db.prs[1].baseRefName = 'main';
  writeFileSync(join(s.root, 'gh.json'), JSON.stringify(db));
  const after = s.run('deps', '11', '--json');
  assert.deepEqual(JSON.parse(after.out).removed, [10]);
  assert.equal(s.read().prs[1].body, 'Closes #5\n');
});
