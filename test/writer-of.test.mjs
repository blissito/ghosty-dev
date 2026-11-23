import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writerOf, evidenceCommitOf } from '../src/commands.mjs';

test('writerOf: un run vivo en la nube manda; sin él, la rama local; sin nada, nadie', () => {
  assert.equal(writerOf({ number: 5, cloudRun: { phase: 'working', state: 'Trabajando' }, localBranch: 'ghosty-dev/5-x' }).where, 'nube');
  assert.match(writerOf({ number: 5, cloudRun: { phase: 'working' } }).move, /teleport 5/);
  assert.equal(writerOf({ number: 5, cloudRun: { phase: 'stopped', state: 'Detenido' }, localBranch: 'ghosty-dev/5-x' }).where, 'tu compu');
  assert.match(writerOf({ number: 5, localBranch: 'ghosty-dev/5-x' }).move, /claim 5 --cloud/);
  const none = writerOf({ number: 5, cloudRun: { phase: 'stopped', state: 'Detenido' } });
  assert.equal(none.where, 'nadie');
  assert.match(none.detail, /Detenido/);
});

test('evidenceCommitOf: lee la línea «Commit:» de la evidencia', () => {
  assert.equal(evidenceCommitOf({ body: '## x\nPR: u\nCommit: cceb712a4b584a6ee5efa268de2a2389cf1bbe87\n' }), 'cceb712a4b584a6ee5efa268de2a2389cf1bbe87');
  assert.equal(evidenceCommitOf({ body: 'sin commit' }), null);
  assert.equal(evidenceCommitOf(null), null);
});
