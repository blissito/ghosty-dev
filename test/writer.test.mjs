import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beat, whatOf } from '../src/writer.mjs';

test('whatOf: primera línea limpia, sin comentarios HTML ni controles, 80 máx', () => {
  assert.equal(whatOf('<!-- ghosty-dev:pedido -->\n\n  Arregla el login\nsegunda'), 'Arregla el login');
  assert.equal(whatOf('a\u0007b'), 'a b');
  assert.equal(whatOf('x'.repeat(200)).length, 80);
  assert.equal(whatOf(''), null);
});

test('beat: con el gh falso no sale nada a la red', async () => {
  process.env.GHOSTY_DEV_GH = '/no/existe';
  assert.equal(await beat(1, 'working', 'x'), false);
});
