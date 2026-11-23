import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvidence, formatEvidence, findValidEvidence, acceptanceCriteria, validateRevision, formatRevision, findRevisionFor, previewPrRefs, crossPreviewProblems } from '../src/evidence.mjs';
import { annotation, closingRefs, evaluatePullRequest, unlinkedPolicy, reviewCheckConfig, externalReview, DEFAULT_REVIEW_CHECK } from '../src/gate.mjs';
import { VALID_EVIDENCE, SHA, revisionMd } from '../testkit/helpers.mjs';

const ISSUE = '## Objetivo\nSalud\n\n## Criterios de aceptación\n- [ ] /health responde 200\n';

test('evidencia completa pasa', () => {
  assert.deepEqual(validateEvidence(VALID_EVIDENCE, ISSUE), { ok: true, errors: [] });
});

test('lee los criterios del pendiente', () => {
  assert.deepEqual(acceptanceCriteria(ISSUE), [{ done: false, text: '/health responde 200' }]);
});

test('sin «Qué se hizo», «Verificación» ni flujo principal falla', () => {
  const r = validateEvidence('## CI\n✅ passed\n');
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 3);
});

test('flujo principal probado con sesión: obligatorio, con captura o salida (Formmy, filas 44 y 46)', () => {
  const without = VALID_EVIDENCE.replace(/## Flujo principal[\s\S]*?(?=## Criterios)/, '');
  assert.match(validateEvidence(without, ISSUE).errors.join(), /Flujo principal probado con sesión/);
  // Sólo texto: falta la prueba.
  const bare = VALID_EVIDENCE.replace(/## Flujo principal[\s\S]*?(?=## Criterios)/, '## Flujo principal probado con sesión\nEntré y mandé un mensaje en el chat.\n\n');
  assert.match(validateEvidence(bare, ISSUE).errors.join(), /necesita la prueba/);
  // Renglón suelto con captura.
  const shot = VALID_EVIDENCE.replace(/## Flujo principal[\s\S]*?(?=## Criterios)/, '').replace('## Preview\nno aplica\n', '## Preview\nFlujo principal probado con sesión: entré con X-Ghosty-Identity y mandé un mensaje en Crear ![chat](https://github.com/user-attachments/assets/abc)\n');
  assert.deepEqual(validateEvidence(shot, ISSUE), { ok: true, errors: [] });
  // «no aplica» sólo con motivo.
  const na = (why) => VALID_EVIDENCE.replace(/## Flujo principal[\s\S]*?(?=## Criterios)/, `## Flujo principal probado con sesión\n${why}\n\n`);
  assert.match(validateEvidence(na('no aplica'), ISSUE).errors.join(), /necesita el motivo/);
  assert.equal(validateEvidence(na('No aplica: es una biblioteca sin interfaz ni login'), ISSUE).ok, true);
  // Un comentario HTML de la plantilla no cuenta como contenido.
  assert.match(validateEvidence(na('<!-- qué y cómo -->'), ISSUE).errors.join(), /Falta «Flujo principal/);
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
  // Una anotación ::error por causa (gs las lee del check); sólo las fallas, no las líneas en verde.
  assert.deepEqual(r.failures, ['#4: sin comentario de evidencia válido (ghosty-dev evidence 4 --file evidencia.md).']);
  assert.equal(annotation(r.failures[0]), '::error title=evidencia::#4: sin comentario de evidencia válido (ghosty-dev evidence 4 --file evidencia.md).');
  assert.equal(annotation('50% a\nb'), '::error title=evidencia::50%25 a%0Ab');
  const none = evaluatePullRequest({ body: 'Closes #5', head }, () => ({ body: ISSUE, comments: [] }));
  assert.deepEqual(none.failures, [`#5: falta la revisión del commit ${SHA.slice(0, 7)} (ghosty-dev review 5).`, '#5: sin comentario de evidencia válido (ghosty-dev evidence 5 --file evidencia.md).']);
  assert.equal(evaluatePullRequest({ body: 'Closes #3', head }, (n) => issues[n]).ok, true);
});

test('un PR que no cierra ningún pendiente bloquea con el comando que lo liga; con unlinked: warn, pasa con aviso (C9)', () => {
  const r = evaluatePullRequest({ number: 76, body: 'arreglos varios' }, () => null);
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /no cierra ningún pendiente: ghosty-dev claim --pr 76 --issue <n> \(o agrega «Closes #n» a la descripción\)/);
  assert.equal(unlinkedPolicy('{}'), 'block');
  assert.equal(unlinkedPolicy('no es json'), 'block');
  const warn = evaluatePullRequest({ number: 76, body: 'arreglos varios' }, () => null, null, { unlinked: unlinkedPolicy('{"unlinked":"warn"}') });
  assert.equal(warn.ok, true);
  assert.equal(warn.informative, true);
});

test('rama fuera del patrón: línea informativa, el veredicto lo da el pendiente (C9)', () => {
  const r = evaluatePullRequest({ number: 76, body: 'Closes #5', head: { ref: 'fix/puerta', sha: 'abc1234' } }, () => ({ body: '', comments: [] }));
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /^Informativo: la rama fix\/puerta no sigue el patrón/);
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

test('«probado en la preview del PR #N» sólo vale si #N contiene el mismo commit (Formmy, fila 40)', () => {
  assert.deepEqual(previewPrRefs('Probado en la preview del PR #73 y en la vista previa de #80; preview #73'), [73, 80]);
  const sha = 'abc1234def5678';
  const commits = { 73: ['abc1234def5678', 'fff'], 80: ['999'] };
  assert.deepEqual(crossPreviewProblems('probado en la preview del PR #73', { pr: 81, sha }, (n) => commits[n]), []);
  const bad = crossPreviewProblems('lo haré en la preview del #80', { pr: 81, sha }, (n) => commits[n]);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /#80 no contiene el commit abc1234/);
  assert.deepEqual(crossPreviewProblems('en la preview del PR #81', { pr: 81, sha }, () => null), []); // la propia
  assert.match(crossPreviewProblems('preview del PR #5', { pr: 81, sha }, () => null)[0], /no pude leer/);
  // La puerta: evidencia válida que cita otra preview sin el commit → falla con la causa.
  const ev = { body: `${VALID_EVIDENCE}\nProbado en la preview del PR #80.` };
  const r = evaluatePullRequest({ number: 81, body: 'Closes #3', head: { sha: SHA } }, () => ({ body: ISSUE, comments: [{ body: formatRevision(3, SHA, revisionMd()) }, { body: formatEvidence(3, ev.body) }] }), null, { prCommits: () => ['otro'] });
  assert.equal(r.ok, false);
  assert.match(r.failures.join('\n'), /#3: La evidencia cita la preview del PR #80/);
  const ok = evaluatePullRequest({ number: 81, body: 'Closes #3', head: { sha: SHA } }, () => ({ body: ISSUE, comments: [{ body: formatRevision(3, SHA, revisionMd()) }, { body: formatEvidence(3, ev.body) }] }), null, { prCommits: () => [SHA] });
  assert.equal(ok.ok, true, ok.failures.join('; '));
});

test('revisor por defecto: sin config.json acepta «Ghosty Review» de ghosty-studio y nada más (PR de preparación, #116)', () => {
  assert.deepEqual({ ...DEFAULT_REVIEW_CHECK }, { name: 'Ghosty Review', app: 'ghosty-studio' });
  const check = (over) => ({ name: 'Ghosty Review', app: { slug: 'ghosty-studio' }, head_sha: SHA, status: 'completed', conclusion: 'success', completed_at: '2026-11-23T10:00:00Z', ...over });
  const evid = { body: formatEvidence(3, VALID_EVIDENCE) };
  const pr = { body: 'Closes #3', head: { sha: SHA } };
  const gate = (runs) => evaluatePullRequest(pr, () => ({ body: ISSUE, comments: [evid] }), externalReview({ ...DEFAULT_REVIEW_CHECK }, runs, SHA));
  assert.equal(gate([check()]).ok, true);
  // Una app ajena con el mismo nombre no vale: sin revisión por comentario, falla.
  assert.equal(gate([check({ app: { slug: 'otra-app' } })]).ok, false);
  assert.equal(gate([]).ok, false);
});
