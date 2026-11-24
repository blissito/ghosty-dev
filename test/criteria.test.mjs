// `criteria`: enmendar un criterio incumplible editando SÓLO su renglón y dejando comentario de rastro.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, issue } from '../testkit/helpers.mjs';

const BODY = '## Objetivo\nAlgo\n\n## Criterios de aceptación\n- [ ] /health responde 200\n- [x] vitest termina con 0 fallos\n- [ ] README actualizado\n\n## Notas\n- [ ] vitest termina con 0 fallos\n';

test('sin --set lista los criterios numerados', () => {
  const s = setup({ issues: { 5: issue(5, 'Health', { body: BODY }) } });
  const r = s.run('criteria', '5', '--json');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out).criteria.map((c) => c.text), ['/health responde 200', 'vitest termina con 0 fallos', 'README actualizado']);
});

test('--set cambia sólo ese renglón (conserva casilla) y comenta quién, cuándo, antes, ahora y motivo', () => {
  const s = setup({ issues: { 5: issue(5, 'Health', { body: BODY }) } });
  const r = s.run('criteria', '5', '--set', '2', 'vitest no agrega fallos nuevos', '--reason', 'main ya traía 3 fallos');
  assert.equal(r.code, 0, r.err);
  const db = s.read();
  assert.equal(db.issues[5].body, BODY.replace('- [x] vitest termina con 0 fallos\n- [ ] README', '- [x] vitest no agrega fallos nuevos\n- [ ] README'));
  const c = db.issues[5].comments.at(-1).body;
  for (const part of ['agente-a', 'vitest termina con 0 fallos', 'vitest no agrega fallos nuevos', 'main ya traía 3 fallos', 'Cuándo: 20']) assert.ok(c.includes(part), part);
});

test('--set sin motivo, índice fuera de rango o texto igual no tocan nada', () => {
  const s = setup({ issues: { 5: issue(5, 'Health', { body: BODY }) } });
  assert.notEqual(s.run('criteria', '5', '--set', '2', 'nuevo').code, 0);
  assert.notEqual(s.run('criteria', '5', '--set', '9', 'nuevo', '--reason', 'x').code, 0);
  assert.notEqual(s.run('criteria', '5', '--set', '1', '/health responde 200', '--reason', 'x').code, 0);
  const db = s.read();
  assert.equal(db.issues[5].body, BODY);
  assert.equal(db.issues[5].comments.length, 0);
});
