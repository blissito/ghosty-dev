import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, issue } from '../testkit/helpers.mjs';
import { mergeReadiness } from '../src/merge.mjs';

const ok = (name) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' });
const pr = (extra = {}) => ({ number: 81, title: 'Chat', url: 'https://github.com/acme/demo/pull/81', headRefName: 'ghosty-dev/5-chat', headRefOid: 'abc1234def', body: 'Closes #5', comments: [], statusCheckRollup: [ok('test'), ok('Ghosty Review'), ok('ghosty-dev/evidencia')], ...extra });
const withPr = (p, more = {}) => {
  const s = setup({ issues: { 5: issue(5, 'Chat', { labels: ['ghosty-dev:esperando-ci'] }) }, prs: [p], ...more });
  return s;
};

test('mergeReadiness: smoke en curso, borrador, rojo y puerta faltante no dejan mezclar (fila 41)', () => {
  const runs = [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }, { id: 2, name: 'Ghosty · Smoke', status: 'in_progress', conclusion: null }];
  let r = mergeReadiness({ pr: { number: 81 }, runs, gateExpected: false });
  assert.equal(r.ready, false);
  assert.deepEqual(r.pending, ['Ghosty · Smoke']);
  r = mergeReadiness({ pr: { number: 81, draft: true }, runs: [runs[0]] });
  assert.match(r.blockers.join(), /borrador/);
  r = mergeReadiness({ pr: { number: 81 }, runs: [runs[0], { id: 3, name: 'Ghosty · Preview', status: 'completed', conclusion: 'failure' }] });
  assert.deepEqual(r.failing, [{ name: 'Ghosty · Preview', conclusion: 'failure' }]);
  r = mergeReadiness({ pr: { number: 81 }, runs: [runs[0]], gateExpected: true });
  assert.match(r.pending.join(), /ghosty-dev\/evidencia/);
  // Neutral y saltado cuentan como resueltos; manda la pasada más reciente del mismo nombre.
  r = mergeReadiness({ pr: { number: 81 }, runs: [runs[0], { id: 4, name: 'redisparo', status: 'completed', conclusion: 'skipped' }, { id: 5, name: 'lint', status: 'completed', conclusion: 'failure' }, { id: 6, name: 'lint', status: 'completed', conclusion: 'neutral' }] });
  assert.equal(r.ready, true);
  // Un status clásico en curso también cuenta.
  r = mergeReadiness({ pr: { number: 81 }, runs: [runs[0]], statuses: [{ context: 'vercel', state: 'pending' }] });
  assert.deepEqual(r.pending, ['vercel']);
});

test('merge con el smoke en curso no mezcla: dice qué falta y ofrece --wait (sale 75)', () => {
  const s = withPr(pr({ statusCheckRollup: [ok('test'), { name: 'Ghosty · Smoke', status: 'IN_PROGRESS' }] }));
  const r = s.run('merge', '81');
  assert.equal(r.code, 75, r.err);
  assert.match(r.out, /No hago el merge del PR #81/);
  assert.match(r.out, /en curso: Ghosty · Smoke/);
  assert.match(r.out, /ghosty-dev merge 81 --wait/);
  assert.ok(!s.read().calls.some((c) => c.includes('repos/{owner}/{repo}/pulls/81/merge')));
});

test('merge --wait espera a que resuelva y mezcla; quita las etiquetas del pendiente; sin deploy lo dice', () => {
  const s = withPr(pr({ statusCheckRollup: [ok('test'), { name: 'Ghosty · Smoke', status: 'IN_PROGRESS' }, ok('ghosty-dev/evidencia')] }), { ciResult: 'SUCCESS', repoInfo: { allow_squash_merge: true } });
  const r = s.run('merge', '81', '--wait');
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /Merge del PR #81 hecho \(squash, merge-8/);
  assert.match(r.out, /no tiene workflow de deploy/);
  const db = s.read();
  assert.deepEqual(db.prs[0].mergedWith, { sha: 'abc1234def', merge_method: 'squash' });
  assert.deepEqual(db.issues[5].labels, []);
});

test('merge en rojo o borrador sale 1 sin --wait que valga', () => {
  let s = withPr(pr({ statusCheckRollup: [ok('test'), { name: 'ghosty-dev/evidencia', status: 'COMPLETED', conclusion: 'FAILURE' }] }));
  let r = s.run('merge', '81', '--wait');
  assert.equal(r.code, 1);
  assert.match(r.out, /ghosty-dev\/evidencia: failure/);
  s = withPr(pr({ draft: true }));
  r = s.run('merge', '81');
  assert.equal(r.code, 1);
  assert.match(r.out, /es borrador/);
});

test('merge espera el deploy de producción del commit del merge y dice cómo salió', () => {
  const s = withPr(pr(), { mergeSha: 'm0rg3', pushRuns: [{ id: 9, path: '.github/workflows/deploy.yml', name: 'Deploy', head_sha: 'm0rg3', status: 'in_progress', conclusion: null, html_url: 'https://github.com/acme/demo/actions/runs/9', then: { status: 'completed', conclusion: 'failure' } }] });
  mkdirSync(join(s.repo, '.github/workflows'), { recursive: true });
  writeFileSync(join(s.repo, '.github/workflows/deploy.yml'), 'name: Deploy\non:\n  push:\n    branches: [main]\njobs: {}\n');
  writeFileSync(join(s.repo, '.github/workflows/ci.yml'), 'name: CI\non: [push, pull_request]\njobs: {}\n');
  const r = s.run('merge', '81');
  assert.equal(r.code, 1, r.err + r.out);
  assert.match(r.out, /Merge del PR #81 hecho/);
  assert.match(r.out, /deploy Deploy: ROJO \(failure\)/);
  assert.match(r.out, /gh run view 9 --log-failed/);
});

test('PR cerrado sin merge: merge, wait --pr, show y next dicen quién y ofrecen reabrir (fila 42)', () => {
  const closed = pr({ state: 'closed', closedAt: '2026-11-22T03:33:00Z', events: [{ event: 'closed', actor: { login: 'bliss' }, created_at: '2026-11-22T03:33:00Z' }], comments: [{ body: 'Lo cierro: el chat no funciona', author: { login: 'bliss' }, createdAt: '2026-11-22T03:32:00Z' }] });
  const s = withPr(closed);
  let r = s.run('merge', '81');
  assert.equal(r.code, 1);
  assert.match(r.err, /PR #81 cerrado sin merge por @bliss el 2026-11-22 03:33 UTC \(motivo: «Lo cierro: el chat no funciona»\): ¿reabrir\? gh pr reopen 81/);
  r = s.run('wait', '--pr', '81', '--minutes', '0');
  assert.equal(r.code, 1);
  assert.match(r.out, /cerrado sin merge por @bliss/);
  r = s.run('show', '5');
  assert.match(r.out, /PR: PR #81 cerrado sin merge por @bliss/);
  r = s.run('wait', '5');
  assert.match(r.out, /primero esto: PR #81 cerrado sin merge/);
});

test('block --reason: etiqueta bloqueado + comentario con marca; vacío no; next en borrador pide motivo (fila 45)', () => {
  const s = withPr(pr({ draft: true }));
  let r = s.run('block', '5', '--reason', '   ');
  assert.equal(r.code, 1);
  assert.match(r.err, /--reason va con el motivo/);
  r = s.run('block', '5', '--reason', 'el chat de Crear responde «Falta la credencial de Ghosty»');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /#5 bloqueado: el chat de Crear .*\(también en el PR #81\)/);
  const db = s.read();
  assert.deepEqual(db.issues[5].labels, ['ghosty-dev:bloqueado']);
  assert.match(db.issues[5].comments.at(-1).body, /^<!-- ghosty-dev:bloqueo -->\n\*\*Bloqueado:\*\* el chat de Crear/);
});

test('evidencia sin flujo principal: dice qué falta y ofrece block --reason', () => {
  const s = withPr(pr());
  const f = s.write('e.md', '## Qué se hizo\nx\n\n## Verificación\n```\n$ npm test\nok\n```\n\n## CI\n✅ passed\n');
  const r = s.run('evidence', '5', '--file', f);
  assert.equal(r.code, 1);
  assert.match(r.err, /Falta «Flujo principal probado con sesión/);
  assert.match(r.err, /ghosty-dev block 5 --reason/);
});

test('block --reason --person y unblock: marca «te necesita», luego la etiqueta sale y queda la marca de desbloqueo', () => {
  const s = withPr(pr({ draft: true }));
  let r = s.run('block', '5', '--reason', 'falta la credencial de Ghosty en la preview', '--person');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /«Te necesita»/);
  assert.match(s.read().issues[5].comments.at(-1).body, /^<!-- ghosty-dev:bloqueo -->\n\*\*Bloqueado \(te necesita\):\*\* falta la credencial/);
  r = s.run('unblock', '5');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /#5 desbloqueado \(también en el PR #81\)/);
  const db = s.read();
  assert.ok(!db.issues[5].labels.includes('ghosty-dev:bloqueado'));
  assert.match(db.issues[5].comments.at(-1).body, /^<!-- ghosty-dev:desbloqueo -->/);
});

test('build roto en la vista previa: la puerta falla y merge lo explica; neutral no bloquea (fila 52)', async () => {
  const { previewBuild, evaluatePullRequest } = await import('../src/gate.mjs');
  const sha = 'a'.repeat(40);
  const red = [{ id: 2, name: 'Ghosty · Preview', head_sha: sha, status: 'completed', conclusion: 'failure', output: { title: 'El build o el arranque falla: el build falla' } }, { id: 1, name: 'Ghosty · Preview', head_sha: sha, status: 'completed', conclusion: 'success' }];
  assert.equal(previewBuild(red, sha).state, 'failed');
  assert.equal(previewBuild([{ id: 1, name: 'Ghosty · Preview', head_sha: sha, status: 'completed', conclusion: 'neutral' }], sha).state, 'ok');
  assert.equal(previewBuild([], sha).state, 'missing');
  const r = evaluatePullRequest({ number: 9, body: 'Closes #1', head: { sha, ref: 'ghosty-dev/1-x' } }, () => ({ body: '', comments: [] }), null, { preview: previewBuild(red, sha) });
  assert.equal(r.ok, false);
  assert.match(r.failures[0], /no compila o no arranca \(El build o el arranque falla: el build falla\)/);
  const { mergeReadiness, readinessText } = await import('../src/merge.mjs');
  const m = mergeReadiness({ pr: { number: 9 }, runs: red.map((x) => ({ ...x })) });
  assert.equal(m.ready, false);
  assert.match(readinessText(9, m), /Ghosty · Preview: failure \(el build o el arranque de la vista previa falla/);
});
