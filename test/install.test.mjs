// Instalar en un repo de producción sin sorpresas (C24): init dice repo y rama antes de escribir y pide --yes fuera
// de la rama principal; las etiquetas se confirman; lista los workflows que dispara el push; protect --dry-run dice
// qué PR abiertos quedarían bloqueados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setup, issue, VALID_EVIDENCE, revisionMd, SHA } from '../testkit/helpers.mjs';
import { formatEvidence, formatRevision } from '../src/evidence.mjs';
import { triggersOnPush } from '../src/workflows.mjs';

test('init fuera de la rama principal no escribe nada sin --yes (C24)', () => {
  const s = setup();
  execFileSync('git', ['checkout', '-q', '-b', 'otra-sesion'], { cwd: s.repo });
  const r = s.run('init');
  assert.equal(r.code, 1);
  assert.match(r.out, /Repo: acme\/demo · rama actual: otra-sesion \(principal: main\)/);
  assert.match(r.err, /Estás en la rama otra-sesion, no en main.*git switch main.*init --yes/);
  assert.equal(existsSync(join(s.repo, '.github')), false);
  assert.deepEqual(s.read().labels, []);
  assert.equal(s.run('init', '--yes', '--no-protect').code, 0);
});

test('init sin terminal y sin --yes no crea las etiquetas y lo dice; con --yes las crea (C24)', () => {
  const s = setup({ labels: ['ghosty-dev:por-hacer'] });
  const r = s.run('init', '--no-protect', '--json');
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /No creé 3 etiqueta\(s\) en acme\/demo \(ghosty-dev:en-curso, ghosty-dev:esperando-ci, ghosty-dev:bloqueado\): confírmalo con ghosty-dev init --yes\./);
  assert.deepEqual(s.read().labels, ['ghosty-dev:por-hacer']);
  assert.ok(existsSync(join(s.repo, '.github/workflows/evidence-gate.yml')));
  const plan = JSON.parse(r.out);
  assert.equal(plan.filter((p) => p.action === 'label').length, 0);
  assert.equal(s.run('init', '--no-protect', '--yes').code, 0);
  assert.equal(s.read().labels.length, 4);
});

test('init lista los workflows que dispara un push a la rama principal (C24)', () => {
  const s = setup();
  mkdirSync(join(s.repo, '.github/workflows'), { recursive: true });
  writeFileSync(join(s.repo, '.github/workflows/deploy.yml'), 'name: Deploy prod\non:\n  push:\n    branches: [main]\njobs: {}\n');
  writeFileSync(join(s.repo, '.github/workflows/ci.yml'), 'name: CI\non: [push, pull_request]\njobs: {}\n');
  writeFileSync(join(s.repo, '.github/workflows/preview.yml'), "name: Preview\non:\n  pull_request:\n  push:\n    branches:\n      - 'feat/**'\njobs: {}\n");
  const r = s.run('init', '--dry-run', '--json');
  const push = JSON.parse(r.out).find((p) => p.action === 'push');
  assert.deepEqual(push.workflows.map((w) => w.file), ['.github/workflows/ci.yml', '.github/workflows/deploy.yml']);
  assert.match(push.name, /un push a main dispara: \.github\/workflows\/ci\.yml \(«CI»\), \.github\/workflows\/deploy\.yml \(«Deploy prod»\)/);
});

test('triggersOnPush: on: push, listas, bloque con branches/branches-ignore/tags/paths (C24)', () => {
  assert.equal(triggersOnPush('on: push\n', 'main').push, true);
  assert.equal(triggersOnPush('on: pull_request\n', 'main').push, false);
  assert.equal(triggersOnPush('on:\n  push:\n    branches-ignore: [main]\n', 'main').push, false);
  assert.equal(triggersOnPush('on:\n  push:\n    tags: [v*]\n', 'main').push, false);
  assert.equal(triggersOnPush('on:\n  push:\n    branches: ["**"]\n    paths: [src/**]\n', 'main').paths, true);
  assert.equal(triggersOnPush('on:\n  push:\n    branches:\n      - release/*\n      - main # prod\n', 'main').push, true);
  assert.equal(triggersOnPush('on:\n  workflow_dispatch:\n  push:\n', 'main').push, true);
});

test('protect --dry-run lista los PR abiertos que quedarían bloqueados y por qué, sin cambiar nada (C24)', () => {
  const s = setup({
    gateOnBase: true,
    issues: { 5: issue(5, 'Con evidencia'), 6: issue(6, 'Sin evidencia') },
    prs: [
      { number: 9, title: 'Listo', url: 'https://github.com/acme/demo/pull/9', headRefName: 'a', headRefOid: SHA, body: 'Closes #5' },
      { number: 10, title: 'Le falta', url: 'https://github.com/acme/demo/pull/10', headRefName: 'b', headRefOid: 'ccc', body: 'Closes #6' },
      { number: 11, title: 'Sin pendiente', url: 'https://github.com/acme/demo/pull/11', headRefName: 'c', headRefOid: 'ddd', body: '' },
      { number: 12, title: 'Borrador', url: 'https://github.com/acme/demo/pull/12', headRefName: 'd', headRefOid: 'eee', body: '', draft: true },
    ],
  });
  const db = s.read();
  db.issues[5].comments.push({ body: formatEvidence(5, VALID_EVIDENCE) });
  db.issues[5].comments.push({ body: formatRevision(5, SHA, revisionMd(0)) });
  writeFileSync(join(s.root, 'gh.json'), JSON.stringify(db));
  const r = s.run('protect', '--dry-run', '--json');
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  assert.deepEqual(out.blocked.map((b) => b.pr), [10, 11]);
  assert.match(out.blocked[1].reasons[0], /no cierra ningún pendiente/);
  assert.ok(out.blocked[0].reasons.some((l) => /#6: sin comentario de evidencia válido/.test(l)));
  assert.deepEqual(out.drafts.map((d) => d.pr), [12]);
  assert.equal(s.read().protection, undefined);
  assert.ok(s.read().calls.every((c) => c[0] === 'api' && c[2] === 'GET'));
  assert.match(s.run('protect', '--dry-run').out, /Quedarían bloqueados 2 PR abierto\(s\):\n {2}#10 Le falta\n {4}- #6: falta la revisión/);
});
