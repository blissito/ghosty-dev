// Compartir la vista previa del PR con alguien sin cuenta y decidir las solicitudes de acceso (SPEC §5d, C27).
// La liga pública sólo sale en `preview share`; nunca en unshare, requests, errores ni stderr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPreview } from '../testkit/with-pr.mjs';

const PV = /pvt_SECRETO/;

test('preview share imprime la liga (idempotente); unshare la revoca sin imprimirla (C27)', () =>
  withPreview([], async ({ gs, cli }) => {
    const r = await cli(['preview', 'share', '73']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^https:\/\/www\.ghosty\.studio\/pv\/pvt_SECRETO1\n {2}Cualquiera con esta liga ve la vista previa del PR #73 sin cuenta\. Revócala: ghosty-dev preview unshare 73/);
    assert.doesNotMatch(r.err, PV);
    const again = JSON.parse((await cli(['preview', 'share', '--json'])).out);
    assert.equal(again.url, 'https://www.ghosty.studio/pv/pvt_SECRETO1');
    assert.equal(again.pr, 73);
    const u = await cli(['preview', 'unshare', '73', '--json']);
    assert.equal(u.code, 0, u.err);
    assert.doesNotMatch(u.out + u.err, PV);
    assert.equal(JSON.parse(u.out).shared, false);
    assert.deepEqual(gs.shareCalls.map((c) => c.method), ['POST', 'POST', 'DELETE']);
  }));

test('preview share de un PR cerrado: error claro, sin liga (C27)', () =>
  withPreview([], async ({ gs, cli }) => {
    gs.share.closed = true;
    const r = await cli(['preview', 'share', '73']);
    assert.equal(r.code, 1);
    assert.match(r.err, /cerrado/);
    assert.doesNotMatch(r.out + r.err, PV);
  }));

test('preview requests lista limpia; accept/reject por id con --pr; id inválido no llama (C27)', () =>
  withPreview([], async ({ gs, cli }) => {
    const r = await cli(['preview', 'requests', '73']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /ar_1 {2}Clienta <clienta@ejemplo\.com> {2}pending · 2026-11-22 18:30\nDecide: ghosty-dev preview accept <id> --pr 73/);
    assert.doesNotMatch(r.out, /\x1b/);
    assert.equal(gs.shareCalls[0].query, '?status=pending');
    const a = await cli(['preview', 'accept', 'ar_1', '--pr', '73']);
    assert.equal(a.code, 0, a.err);
    assert.match(a.out, /Aceptada la solicitud ar_1 de clienta@ejemplo\.com \(PR #73\)/);
    assert.deepEqual(gs.shareCalls[1].body, { id: 'ar_1', decision: 'accept' });
    assert.match((await cli(['preview', 'requests', '--status', 'pending'])).out, /sin solicitudes de acceso \(pending\)/);
    assert.equal((await cli(['preview', 'reject', 'nope', '--pr', '73'])).code, 1);
    const bad = await cli(['preview', 'reject', 'a b', '--pr', '73']);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /Uso: ghosty-dev preview reject <id>/);
    assert.equal((await cli(['preview', 'requests', '--status', 'raro'])).code, 1);
    assert.equal(gs.shareCalls.length, 4);
  }));
