// Verificación de la persona: criterios `- [~] … — verificación de la persona: …` (sign-off de QA).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvidence, formatEvidence, pendingVerification, manualCriteria, formatConfirmation, parseChecklist, formatRevision } from '../src/evidence.mjs';
import { evaluatePullRequest } from '../src/gate.mjs';
import { VALID_EVIDENCE, SHA, revisionMd, setup, issue } from '../testkit/helpers.mjs';

const ISSUE = '## Objetivo\nAdmin\n\n## Criterios de aceptación\n- [ ] /health responde 200\n- [ ] /admin muestra el panel con sesión de administrador\n';
const CRIT = '/admin muestra el panel con sesión de administrador';
const CHECK = 'Entra a /admin con tu cuenta de administrador y mira que cargue el panel';
const withManual = (check = CHECK) =>
  VALID_EVIDENCE.replace('- [x] /health responde 200\n', `- [x] /health responde 200\n- [~] ${CRIT} — verificación de la persona: ${check}\n`);
const confirmation = (extra = {}) => ({ body: formatConfirmation(3, { sha: SHA, criterion: CRIT, index: 2, by: 'bliss', at: 'hoy', note: 'ok', check: CHECK }), user: { login: 'bliss' }, ...extra });

test('un [~] con «qué comprobar» pasa la puerta y se declara como pendiente de la persona', () => {
  const r = validateEvidence(withManual(), ISSUE);
  assert.equal(r.ok, true, r.errors.join());
  assert.deepEqual(r.manual, [{ criterion: CRIT, check: CHECK }]);
  assert.deepEqual(parseChecklist('- [~] algo — verificación de la persona: x'), [{ done: false, text: 'algo — verificación de la persona: x', pending: true }]);
});

test('un [~] sin texto de qué comprobar (o de menos de 15 caracteres) se rechaza', () => {
  assert.match(validateEvidence(withManual('ver'), ISSUE).errors.join(), /sin «qué comprobar»/);
  const bare = VALID_EVIDENCE.replace('- [x] /health responde 200\n', `- [x] /health responde 200\n- [~] ${CRIT}\n`);
  assert.match(validateEvidence(bare, ISSUE).errors.join(), /sin «qué comprobar»/);
});

test('sin [~] el resultado es idéntico al de siempre; el rechazo por criterio sin cumplir ofrece la salida [~]', () => {
  assert.deepEqual(validateEvidence(VALID_EVIDENCE, '## Criterios de aceptación\n- [ ] /health responde 200\n'), { ok: true, errors: [] });
  const r = validateEvidence(VALID_EVIDENCE, ISSUE);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /Criterio sin cumplir en la evidencia: «\/admin/);
  assert.match(r.errors[0], /\[~\].*verificación de la persona/);
});

test('pendingVerification: falta hasta que una persona de confianza confirma; vale para commits nuevos', () => {
  const ev = { body: formatEvidence(3, withManual()) };
  assert.equal(pendingVerification([ev], ISSUE).missing.length, 1);
  const done = pendingVerification([ev, confirmation()], ISSUE);
  assert.deepEqual([done.missing.length, done.confirmed[0].by], [0, 'bliss']);
  // Quien no tiene permiso de escritura (author_association) no cuenta.
  assert.equal(pendingVerification([ev, confirmation({ author_association: 'NONE' })], ISSUE).missing.length, 1);
  // La app de Ghosty Studio confirma en nombre de la persona (NONE para GitHub): sí cuenta (Formmy #90, 26-nov).
  assert.equal(pendingVerification([ev, confirmation({ author_association: 'NONE', user: { login: 'ghosty-studio[bot]', type: 'Bot' } })], ISSUE).missing.length, 0);
  // Evidencia nueva SIN [~] (la cumplió de verdad): ya no hay nada pendiente.
  const clean = { body: formatEvidence(3, VALID_EVIDENCE.replace('- [x] /health responde 200\n', `- [x] /health responde 200\n- [x] ${CRIT}\n`)) };
  assert.equal(pendingVerification([ev, confirmation(), clean], ISSUE).manual.length, 0);
  assert.equal(manualCriteria(withManual()).length, 1);
});

test('la puerta no marca fallo: reporta «Falta tu verificación» en `awaiting` y queda lista al confirmar', () => {
  const ev = { body: formatEvidence(3, withManual()) };
  const rev = { body: formatRevision(3, SHA, revisionMd()) };
  const head = { sha: SHA };
  const waiting = evaluatePullRequest({ body: 'Closes #3', head }, () => ({ body: ISSUE, comments: [rev, ev] }));
  assert.equal(waiting.ok, true);
  assert.deepEqual(waiting.awaiting, [CRIT]);
  assert.ok(waiting.lines.some((l) => /Falta tu verificación: \/admin/.test(l)));
  const done = evaluatePullRequest({ body: 'Closes #3', head }, () => ({ body: ISSUE, comments: [rev, ev, confirmation()] }));
  assert.deepEqual([done.ok, done.awaiting], [true, []]);
  assert.ok(done.lines.some((l) => /confirmada por @bliss/.test(l)));
});

test('ghosty-dev confirm: publica el rastro, exige un [~] declarado y rechaza índices inválidos', () => {
  const s = setup({ issues: { 5: issue(5, 'Admin', { body: ISSUE, labels: ['ghosty-dev:en-curso'] }) }, prs: [{ number: 9, headRefName: 'ghosty-dev/5-x' }], runs: [{ databaseId: 77 }] });
  // Sin evidencia vigente no hay nada que confirmar.
  assert.match(s.run('confirm', '5', '--criterion', '2').err, /no tiene evidencia válida/);
  const pub = s.run('evidence', '5', '--file', s.write('e.md', withManual()));
  assert.equal(pub.code, 0, pub.err);
  assert.match(pub.out, /Falta tu verificación: \/admin/);
  // El criterio 1 no se declaró [~].
  assert.match(s.run('confirm', '5', '--criterion', '1').err, /no está declarado como «- \[~\]»/);
  assert.notEqual(s.run('confirm', '5', '--criterion', '9').code, 0);
  const r = s.run('confirm', '5', '--criterion', '2', '--note', 'lo vi con mi cuenta', '--json');
  assert.equal(r.code, 0, r.err);
  const last = s.read().issues[5].comments.at(-1).body;
  for (const part of ['ghosty-dev:confirmacion v0.1', 'agente-a', 'lo vi con mi cuenta', '/admin muestra el panel']) assert.ok(last.includes(part), part);
  assert.equal(JSON.parse(r.out).rerun, 77);
});
