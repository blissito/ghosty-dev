// `wait` en vivo: el aviso SSE de Ghosty Studio despierta la espera antes del sondeo (Formmy, 22-nov).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

test('openLive: un aviso del repo despierta el sleep; uno de otro repo no', async () => {
  let push;
  const srv = createServer((req, res) => {
    assert.equal(req.url, '/api/v2/me/dev-runs/live');
    assert.equal(req.headers.authorization, 'Bearer tok-de-prueba');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: hello\ndata: {}\n\n');
    push = (repo, extra = {}) => res.write(`event: repo\ndata: ${JSON.stringify({ repo, ...extra })}\n\n`);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.GHOSTY_DEV_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
  process.env.GHOSTY_DEV_TOKEN = 'tok-de-prueba';
  const { openLive } = await import('../src/live.mjs');
  const live = await openLive(() => 'Blissito/Formmy_rrv7');
  assert.equal(live.live, true);
  for (let i = 0; !push && i < 50; i++) await new Promise((r) => setTimeout(r, 10));
  const t0 = Date.now();
  setTimeout(() => push('otro/repo'), 30);
  setTimeout(() => push('blissito/formmy_rrv7'), 80);
  const woke = await live.sleep(5_000);
  assert.equal(woke, true);
  assert.ok(Date.now() - t0 < 3_000, 'despertó antes del tope');
  assert.equal(live.takeFactory(), null);
  // La persona pausó la fábrica: el aviso despierta y `wait` lo lee una vez.
  setTimeout(() => push('blissito/formmy_rrv7', { event: 'factory', action: 'pause' }), 20);
  assert.equal(await live.sleep(5_000), true);
  assert.equal(live.takeFactory(), 'pause');
  assert.equal(live.takeFactory(), null);
  live.close();
  srv.closeAllConnections?.();
  srv.close();
  delete process.env.GHOSTY_DEV_BASE_URL;
  delete process.env.GHOSTY_DEV_TOKEN;
});

test('openLive sin sesión: espera normal', async () => {
  process.env.GHOSTY_DEV_NO_LIVE = '1';
  const { openLive } = await import('../src/live.mjs');
  const live = await openLive('a/b');
  assert.equal(live.live, false);
  assert.equal(await live.sleep(5), false);
  delete process.env.GHOSTY_DEV_NO_LIVE;
});
