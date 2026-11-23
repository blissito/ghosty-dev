import test from 'node:test';
import assert from 'node:assert/strict';
import { boardNext, nextLine } from '../src/commands.mjs';

const run = (name) => ({ name, status: 'in_progress', conclusion: null });
const ok = (name) => ({ name, status: 'completed', conclusion: 'success' });
const bad = (name) => ({ name, status: 'completed', conclusion: 'failure' });

test('boardNext: la evidencia en rojo espera a la vista previa (no es rojo); luego al agente; luego merge a ti', () => {
  const n = boardNext([run('Ghosty · Preview'), run('Ghosty · Smoke'), bad('ghosty-dev/evidencia')]);
  assert.deepEqual(n, { step: 'preview', owner: 'ghosty', waitingOn: null, failed: false });
  assert.equal(nextLine(n), 'Siguiente: Vista previa · le toca a Ghosty');
  const ev = boardNext([ok('Ghosty · Preview'), ok('Ghosty · Smoke'), ok('Ghosty Review'), bad('ghosty-dev/evidencia')]);
  assert.equal(nextLine(ev), 'Siguiente: Probar el flujo principal y publicar la evidencia · le toca al agente');
  assert.equal(nextLine(boardNext([ok('Ghosty · Preview'), ok('ghosty-dev/evidencia')])), 'Siguiente: Merge · te toca a ti');
});

test('boardNext: fallas reales en rojo', () => {
  assert.equal(boardNext([ok('Ghosty · Preview'), bad('build')]).failed, true);
  assert.equal(boardNext([], { conflict: true }).step, 'conflict');
});
