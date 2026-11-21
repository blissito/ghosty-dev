import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvidence, formatEvidence, findValidEvidence, acceptanceCriteria, validateRevision, formatRevision, findRevisionFor } from '../src/evidence.mjs';
import { closingRefs, evaluatePullRequest, reviewCheckConfig, externalReview } from '../src/gate.mjs';
import { VALID_EVIDENCE, SHA, revisionMd } from '../testkit/helpers.mjs';

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
    3: { body: ISSUE, comments: [{ body: formatRevision(3, SHA, revisionMd()) }, { body: formatEvidence(3, VALID_EVIDENCE) }] },
    4: { body: ISSUE, comments: [{ body: formatRevision(4, SHA, revisionMd()) }, { body: 'listo, ya compila' }] },
  };
  const head = { sha: SHA };
  const r = evaluatePullRequest({ body: 'Closes #3\nCloses #4', head }, (n) => issues[n]);
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => /#4: sin comentario/.test(l)));
  assert.equal(evaluatePullRequest({ body: 'Closes #3', head }, (n) => issues[n]).ok, true);
});

test('un PR que no cierra ningún pendiente no pasa la puerta', () => {
  assert.equal(evaluatePullRequest({ body: 'arreglos varios' }, () => null).ok, false);
});

test('revisión válida: comandos con salida, ataques y hallazgos que cuadran', () => {
  assert.deepEqual(validateRevision(revisionMd(0)), { ok: true, errors: [], open: 0 });
  assert.equal(validateRevision(revisionMd(1)).open, 1);
  const lies = revisionMd(1).replace('Hallazgos abiertos: 1', 'Hallazgos abiertos: 0');
  assert.match(validateRevision(lies).errors.join(' '), /no cuadra/);
  assert.equal(validateRevision('## Revisión\nTodo bien.\n').ok, false);
});

test('la puerta exige revisión del commit actual y sin hallazgos abiertos', () => {
  const evid = { body: formatEvidence(3, VALID_EVIDENCE) };
  const pr = { body: 'Closes #3', head: { sha: SHA } };
  const run = (comments) => evaluatePullRequest(pr, () => ({ body: ISSUE, comments }));
  // Sin revisión: no pasa, aunque la evidencia sea válida.
  let r = run([evid]);
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /falta la revisión del commit a1b2c3d/);
  // Revisión de otro commit (hubo push después): no cuenta.
  r = run([{ body: formatRevision(3, 'ffffffffffffffffffffffffffffffffffffffff', revisionMd()) }, evid]);
  assert.match(r.lines[0], /falta la revisión/);
  // Revisión del commit actual con un hallazgo abierto: no pasa.
  r = run([{ body: formatRevision(3, SHA, revisionMd(1)) }, evid]);
  assert.match(r.lines[0], /1 hallazgo/);
  // Revisión limpia del commit actual + evidencia: pasa.
  assert.equal(run([{ body: formatRevision(3, SHA, revisionMd()) }, evid]).ok, true);
  assert.ok(findRevisionFor([{ body: formatRevision(3, SHA, revisionMd()) }], SHA.slice(0, 7)));
});

test('revisión por check externo: otra identidad, atada al commit exacto', () => {
  const config = reviewCheckConfig('{"reviewCheck":{"name":"Ghosty Review","app":"ghosty-studio"}}');
  assert.deepEqual(config, { name: 'Ghosty Review', app: 'ghosty-studio' });
  // Sin `app` no vale: cualquiera con permiso de checks podría publicar uno con ese nombre.
  assert.equal(reviewCheckConfig('{"reviewCheck":{"name":"Ghosty Review"}}'), null);
  assert.equal(reviewCheckConfig('no es json'), null);
  assert.equal(externalReview(null, [], SHA), null);

  const check = (over) => ({ name: 'Ghosty Review', app: { slug: 'ghosty-studio' }, head_sha: SHA, status: 'completed', conclusion: 'success', completed_at: '2026-11-21T10:00:00Z', ...over });
  const evid = { body: formatEvidence(3, VALID_EVIDENCE) };
  const pr = { body: 'Closes #3', head: { sha: SHA } };
  const gate = (runs, comments = [evid]) => evaluatePullRequest(pr, () => ({ body: ISSUE, comments }), externalReview(config, runs, SHA));

  // Check verde del commit: pasa sin comentario de revisión.
  let r = gate([check()]);
  assert.equal(r.ok, true);
  assert.match(r.lines[0], /por el check «Ghosty Review»/);
  // Con hallazgos (neutral), o corriendo: no pasa.
  assert.match(gate([check({ conclusion: 'neutral' })]).lines[0], /hallazgos abiertos/);
  assert.match(gate([check({ status: 'in_progress', conclusion: null })]).lines[0], /sigue corriendo/);
  // Un check de otro commit, de otra app o con otro nombre no cuenta: se cae a la revisión por comentario.
  for (const other of [{ head_sha: 'f'.repeat(40) }, { app: { slug: 'otra-app' } }, { name: 'Otra cosa' }]) {
    r = gate([check(other)]);
    assert.equal(r.ok, false);
    assert.match(r.lines[0], /falta la revisión del commit/);
  }
  // Un re-run más reciente sustituye al anterior.
  assert.equal(gate([check({ conclusion: 'neutral', completed_at: '2026-11-21T09:00:00Z' }), check()]).ok, true);
  // Sin check todavía, la revisión por comentario sigue valiendo (camino local).
  assert.equal(gate([], [{ body: formatRevision(3, SHA, revisionMd()) }, evid]).ok, true);
});
