import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvidence, formatEvidence, findValidEvidence, acceptanceCriteria } from '../src/evidence.mjs';
import { closingRefs, evaluatePullRequest } from '../src/gate.mjs';
import { VALID_EVIDENCE } from '../testkit/helpers.mjs';

const ISSUE = '## Objetivo\nSalud\n\n## Criterios de aceptación\n- [ ] /health responde 200\n';

test('evidencia completa pasa', () => {
  assert.deepEqual(validateEvidence(VALID_EVIDENCE, ISSUE), { ok: true, errors: [] });
});

test('lee los criterios del pendiente', () => {
  assert.deepEqual(acceptanceCriteria(ISSUE), [{ done: false, text: '/health responde 200' }]);
});

test('sin «Qué se hizo» ni «Verificación» falla', () => {
  const r = validateEvidence('## CI\n✅ passed\n');
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 2);
});

test('comandos sin salida no cuentan como verificación', () => {
  const md = VALID_EVIDENCE.replace('ok 3 - health responde 200\n', '');
  assert.match(validateEvidence(md, ISSUE).errors.join(), /no su salida/);
});

test('CI en rojo no cierra', () => {
  const md = VALID_EVIDENCE.replace('✅ passed', '❌ failed');
  assert.match(validateEvidence(md, ISSUE).errors.join(), /rojo/);
});

test('CI sin resultado declarado falla', () => {
  const md = VALID_EVIDENCE.replace('✅ passed — ', '');
  assert.match(validateEvidence(md, ISSUE).errors.join(), /resultado/);
});

test('criterio sin marcar falla', () => {
  const md = VALID_EVIDENCE.replace('- [x] /health', '- [ ] /health');
  assert.match(validateEvidence(md, ISSUE).errors.join(), /Criterio sin cumplir/);
});

test('sólo cuenta un comentario con la marca de evidencia', () => {
  assert.equal(findValidEvidence([{ body: VALID_EVIDENCE }], ISSUE), null);
  const good = { body: formatEvidence(7, VALID_EVIDENCE) };
  assert.equal(findValidEvidence([good, { body: 'ya quedó' }], ISSUE), good);
});

test('la puerta encuentra «Closes #n» y exige evidencia por cada uno', () => {
  assert.deepEqual(closingRefs('Closes #3, fixes #4 y resolves #3'), [3, 4]);
  const issues = {
    3: { body: ISSUE, comments: [{ body: formatEvidence(3, VALID_EVIDENCE) }] },
    4: { body: ISSUE, comments: [{ body: 'listo, ya compila' }] },
  };
  const r = evaluatePullRequest({ body: 'Closes #3\nCloses #4' }, (n) => issues[n]);
  assert.equal(r.ok, false);
  assert.match(r.lines[1], /#4: sin comentario/);
  assert.equal(evaluatePullRequest({ body: 'Closes #3' }, (n) => issues[n]).ok, true);
});

test('un PR que no cierra ningún pendiente no pasa la puerta', () => {
  assert.equal(evaluatePullRequest({ body: 'arreglos varios' }, () => null).ok, false);
});
