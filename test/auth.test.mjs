// Sesión propia de ghosty-dev en Ghosty Studio y variables de la vista previa (SPEC §8), contra un gs falso.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup } from '../testkit/helpers.mjs';
import { fakeGs } from '../testkit/fake-gs.mjs';

const SECRET = 'sk_live_NO_SE_IMPRIME_123';
// Sin navegador por defecto (como CI): login usa el device flow. Las pruebas de loopback lo cambian.
const NO_BROWSER = { CI: '1' };
const WITH_BROWSER = { CI: undefined, SSH_CONNECTION: undefined, SSH_TTY: undefined, DISPLAY: ':0' };

let currentBase = null; // la base del gs falso de la prueba en curso: la sesión guardada es de ese servidor
async function withGs(opts, fn) {
  const gs = await fakeGs(opts);
  currentBase = gs.base;
  const s = setup();
  const extra = { GHOSTY_DEV_BASE_URL: gs.base, GHOSTY_DEV_POLL_UNIT_MS: '1', ...NO_BROWSER };
  const cli = (args, more = {}) => s.runAsync(args, { ...more, extra: { ...extra, ...(more.extra ?? {}) } });
  try {
    await fn({ gs, s, cli, authFile: join(s.config, 'ghosty-dev', 'auth.json') });
  } finally {
    await gs.close();
  }
}

// Una sesión guardada como la dejaría login, con el access y el vencimiento que pida la prueba.
function saveSession(file, { accessToken, refreshToken, expiresAt }) {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ baseUrl: currentBase, accessToken, refreshToken, expiresAt, scope: 'profile repo:env dev files', email: null }), { mode: 0o600 });
}

test('login sin navegador usa el device flow: pending → ok, y guarda la sesión con 0600 en un dir 0700', () =>
  withGs({ deviceReplies: ['authorization_pending', 'authorization_pending', 'ok'] }, async ({ gs, cli, authFile }) => {
    const r = await cli(['login', '--json']);
    assert.equal(r.code, 0, r.err);
    const [event, ...rest] = r.out.trim().split('\n');
    assert.deepEqual(JSON.parse(event), { event: 'login_url', method: 'device', url: `${gs.base}/device?code=ABCD-EFGH`, verificationUri: `${gs.base}/device`, code: 'ABCD-EFGH' });
    const out = JSON.parse(rest.join('\n'));
    assert.equal(out.method, 'device');
    assert.equal(out.email, 'persona@ejemplo.com');
    assert.equal(gs.polls.length, 3);
    // El device endpoint sale del respaldo ${base}/oauth2/device (la metadata no lo trae), con client y scope.
    const dev = gs.calls.find((c) => c.path === '/oauth2/device');
    assert.deepEqual(dev.form, { client_id: 'ghosty-dev', scope: 'profile repo:env dev files' });
    assert.match(dev.ua, /^ghosty-dev\/\d+\.\d+\.\d+$/);
    const saved = JSON.parse(readFileSync(authFile, 'utf8'));
    assert.equal(saved.accessToken, 'at_1');
    assert.equal(saved.refreshToken, 'rt_1');
    assert.equal(statSync(authFile).mode & 0o777, 0o600);
    assert.equal(statSync(join(authFile, '..')).mode & 0o777, 0o700);
    // Ningún token en la salida.
    assert.doesNotMatch(r.out + r.err, /at_1|rt_1|dc_1/);
  }));

test('device flow: slow_down suma 5 intervalos; expired_token y access_denied fallan con su mensaje', async () => {
  await withGs({ deviceReplies: ['slow_down', 'ok'] }, async ({ gs, cli }) => {
    const r = await cli(['login', '--device'], { extra: { GHOSTY_DEV_POLL_UNIT_MS: '20' } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out.split('\n')[0], /confirma el código ABCD-EFGH/);
    assert.equal(gs.polls.length, 2);
    // Intervalo 1 → 6 unidades de 20 ms tras slow_down.
    assert.ok(gs.polls[1] - gs.polls[0] >= 110, `espera tras slow_down: ${gs.polls[1] - gs.polls[0]} ms`);
  });
  await withGs({ deviceReplies: ['authorization_pending', 'expired_token'] }, async ({ cli, authFile }) => {
    const r = await cli(['login', '--device']);
    assert.equal(r.code, 1);
    assert.match(r.err, /caducó/);
    assert.equal(existsSync(authFile), false);
  });
  await withGs({ deviceReplies: ['access_denied'] }, async ({ cli }) => {
    const r = await cli(['login', '--device']);
    assert.equal(r.code, 1);
    assert.match(r.err, /Se rechazó/);
  });
});

test('login con navegador (persona en la terminal): loopback 127.0.0.1/cb con PKCE S256; otro state se rechaza', () =>
  withGs({}, async ({ gs, cli, authFile }) => {
    let browser;
    const r = await cli(['login'], {
      extra: { ...WITH_BROWSER, GHOSTY_DEV_ASSUME_TTY: '1' },
      onLine: (line) => {
        const m = line.match(/Si no se abre: (\S+)/);
        if (!m) return;
        browser = (async () => {
          const u = new URL(m[1]);
          assert.equal(u.origin + u.pathname, `${gs.base}/oauth2/authorize`);
          assert.equal(u.searchParams.get('client_id'), 'ghosty-dev');
          assert.equal(u.searchParams.get('scope'), 'profile repo:env dev files');
          assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
          assert.match(u.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/cb$/);
          // Un tercero que regresa con otro state: 400 y el CLI sigue esperando.
          const bad = await gs.authorize(m[1], { code: 'robado', state: 'otro' });
          assert.equal(bad.status, 400);
          const ok = await gs.authorize(m[1]);
          assert.equal(ok.status, 200);
        })();
      },
    });
    await browser;
    assert.equal(r.code, 0, r.err);
    assert.ok(browser, 'no salió la liga del loopback');
    // Sólo se canjeó el código bueno, con su verifier (el server falso valida PKCE).
    const grants = gs.calls.filter((c) => c.form?.grant_type === 'authorization_code');
    assert.deepEqual(grants.map((c) => c.form.code), ['code_1']);
    assert.equal(gs.calls.some((c) => c.path === '/oauth2/device'), false);
    assert.equal(JSON.parse(readFileSync(authFile, 'utf8')).accessToken, 'at_1');
  }));

test('un agente (sin TTY) nunca abre el navegador: device flow con la liga en la PRIMERA línea', () =>
  withGs({ deviceReplies: ['authorization_pending', 'ok'] }, async ({ gs, cli }) => {
    const r = await cli(['login'], { extra: WITH_BROWSER });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.split('\n')[0], `Abre ${gs.base}/device?code=ABCD-EFGH y confirma el código ABCD-EFGH`);
    assert.equal(gs.calls.some((c) => c.form?.grant_type === 'authorization_code'), false);
  }));

test('login en dos pasos para agentes: --no-wait sale de inmediato con el pendiente 0600; --wait lo retoma', () =>
  withGs({ deviceReplies: ['authorization_pending', 'ok'] }, async ({ gs, cli, authFile }) => {
    const pendingFile = join(authFile, '..', 'pending-login.json');
    const a = await cli(['login', '--no-wait', '--json']);
    assert.equal(a.code, 0, a.err);
    const out = JSON.parse(a.out);
    assert.equal(out.status, 'pending');
    assert.equal(out.verification_uri_complete, `${gs.base}/device?code=ABCD-EFGH`);
    assert.equal(out.user_code, 'ABCD-EFGH');
    assert.equal(out.next, 'ghosty-dev login --wait');
    assert.ok(!Number.isNaN(Date.parse(out.expires_at)));
    assert.equal(gs.polls.length, 0); // no sondeó
    assert.equal(statSync(pendingFile).mode & 0o777, 0o600);
    assert.equal(existsSync(authFile), false);

    const b = await cli(['login', '--wait', '--json']);
    assert.equal(b.code, 0, b.err);
    assert.equal(JSON.parse(b.out).status, 'ok');
    assert.equal(gs.polls.length, 2);
    assert.equal(existsSync(pendingFile), false);
    assert.equal(JSON.parse(readFileSync(authFile, 'utf8')).accessToken, 'at_1');
    // Ningún --json suelta access_token, refresh_token ni device_code.
    for (const x of [a, b]) assert.doesNotMatch(x.out + x.err, /at_1|rt_1|dc_1|access_token|refresh_token|device_code/);
  }));

test('orden de credenciales: con GHOSTY_DEV_TOKEN o sesión vigente/renovable, login no inicia otro; whoami dice de dónde', () =>
  withGs({}, async ({ gs, cli, authFile }) => {
    const env = await cli(['login', '--no-wait', '--json'], { extra: { GHOSTY_DEV_TOKEN: 'at_ci' } });
    assert.equal(env.code, 0, env.err);
    assert.deepEqual(JSON.parse(env.out), { status: 'ok', already: true, source: 'env' });

    gs.refresh = 'rt_viejo';
    saveSession(authFile, { accessToken: 'at_vencido', refreshToken: 'rt_viejo', expiresAt: Date.now() + 10_000 });
    const file = await cli(['login', '--json']);
    assert.equal(file.code, 0, file.err);
    const out = JSON.parse(file.out);
    assert.deepEqual([out.already, out.source], [true, 'file']);
    assert.doesNotMatch(file.out, /at_1|rt_1/);
    assert.equal(gs.calls.some((c) => c.path === '/oauth2/device'), false);

    const who = await cli(['whoami', '--json']);
    assert.equal(JSON.parse(who.out).source, 'file');
    gs.valid.add('at_ci');
    const whoEnv = await cli(['whoami', '--json'], { extra: { GHOSTY_DEV_TOKEN: 'at_ci' } });
    assert.equal(JSON.parse(whoEnv.out).source, 'env');
    assert.doesNotMatch(whoEnv.out + who.out, /at_ci|at_1|rt_1/);
  }));

test('login --wait: pendiente al vencer --timeout sale con 75; negado o sin pendiente pide --no-wait otra vez', () =>
  withGs({ deviceReplies: Array(50).fill('authorization_pending') }, async ({ gs, cli, authFile }) => {
    const pendingFile = join(authFile, '..', 'pending-login.json');
    assert.equal((await cli(['login', '--no-wait'])).code, 0);
    const slow = { GHOSTY_DEV_POLL_UNIT_MS: '20' };
    const r = await cli(['login', '--wait', '--timeout', '0.1', '--json'], { extra: slow });
    assert.equal(r.code, 75, r.err);
    assert.deepEqual(
      (({ status, next }) => ({ status, next }))(JSON.parse(r.out)),
      { status: 'pending', next: 'ghosty-dev login --wait' },
    );
    assert.ok(gs.polls.length >= 1 && gs.polls.length <= 5, `sondeos: ${gs.polls.length}`);
    assert.ok(existsSync(pendingFile));

    gs.deviceReplies = ['access_denied'];
    const denied = await cli(['login', '--wait']);
    assert.equal(denied.code, 1);
    assert.match(denied.err, /Se rechazó.*ghosty-dev login --no-wait otra vez/);
    assert.equal(existsSync(pendingFile), false);

    const none = await cli(['login', '--wait']);
    assert.equal(none.code, 1);
    assert.match(none.err, /No hay un inicio de sesión pendiente\. Corre ghosty-dev login --no-wait otra vez/);
  }));

test('sin sesión, los comandos que la necesitan dan el siguiente paso exacto', () =>
  withGs({}, async ({ cli }) => {
    for (const args of [['env', 'ls'], ['whoami']]) {
      const r = await cli(args);
      assert.equal(r.code, 1);
      assert.match(r.err, /Siguiente paso: ghosty-dev login --no-wait/);
    }
  }));

test('refresh al vencer: con < 60 s se renueva antes de llamar y se guarda el refresh rotado', () =>
  withGs({}, async ({ gs, cli, authFile }) => {
    gs.refresh = 'rt_viejo';
    saveSession(authFile, { accessToken: 'at_vencido', refreshToken: 'rt_viejo', expiresAt: Date.now() + 10_000 });
    const r = await cli(['whoami', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).email, 'persona@ejemplo.com');
    const refreshes = gs.calls.filter((c) => c.form?.grant_type === 'refresh_token');
    assert.equal(refreshes.length, 1);
    // Nunca se llamó a la API con el token vencido.
    assert.equal(gs.calls.some((c) => c.auth === 'Bearer at_vencido'), false);
    const saved = JSON.parse(readFileSync(authFile, 'utf8'));
    assert.deepEqual([saved.accessToken, saved.refreshToken], ['at_1', 'rt_1']);
    assert.equal(statSync(authFile).mode & 0o777, 0o600);
  }));

test('reintento único tras 401: refresca y repite; GHOSTY_DEV_TOKEN manda y no refresca', async () => {
  await withGs({}, async ({ gs, cli, authFile }) => {
    gs.refresh = 'rt_viejo';
    saveSession(authFile, { accessToken: 'at_revocado', refreshToken: 'rt_viejo', expiresAt: Date.now() + 3_600_000 });
    const r = await cli(['env', 'ls', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out).saved, ['OLD_KEY', 'API_KEY']);
    const api = gs.calls.filter((c) => c.path.startsWith('/api/'));
    assert.deepEqual(api.map((c) => c.auth), ['Bearer at_revocado', 'Bearer at_1']);
  });
  await withGs({}, async ({ gs, cli }) => {
    const r = await cli(['env', 'ls'], { extra: { GHOSTY_DEV_TOKEN: 'at_de_ci' } });
    assert.equal(r.code, 1);
    assert.match(r.err, /ghosty-dev login/);
    assert.equal(gs.calls.filter((c) => c.path.startsWith('/api/')).length, 1);
    assert.equal(gs.calls.some((c) => c.form?.grant_type === 'refresh_token'), false);
  });
});

test('logout revoca el refresh en gs y borra el archivo', () =>
  withGs({}, async ({ gs, cli, authFile }) => {
    gs.refresh = 'rt_viejo';
    saveSession(authFile, { accessToken: 'at_x', refreshToken: 'rt_viejo', expiresAt: Date.now() + 3_600_000 });
    const r = await cli(['logout', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), { loggedOut: true, revoked: true, envToken: false });
    assert.deepEqual(gs.revoked, [{ client_id: 'ghosty-dev', token: 'rt_viejo', token_type_hint: 'refresh_token' }]);
    assert.equal(existsSync(authFile), false);
    const again = await cli(['whoami']);
    assert.equal(again.code, 1);
    assert.match(again.err, /ghosty-dev login/);
  }));

test('env push sin archivo falla y nunca lee un .env implícito', () =>
  withGs({}, async ({ gs, s, cli, authFile }) => {
    saveSession(authFile, { accessToken: 'at_1', refreshToken: 'rt_1', expiresAt: Date.now() + 3_600_000 });
    gs.valid.add('at_1');
    s.write('demo/.env', `API_KEY=${SECRET}\n`);
    const r = await cli(['env', 'push', '--yes']);
    assert.equal(r.code, 1);
    assert.match(r.err, /Falta el archivo: ghosty-dev env push <archivo>/);
    assert.equal(gs.calls.length, 0);
  }));

test('env push: ruta y nombres antes de guardar, nunca valores; fusiona y dice qué se queda; sin TTY pide --yes', () =>
  withGs({}, async ({ gs, s, cli, authFile }) => {
    saveSession(authFile, { accessToken: 'at_1', refreshToken: 'rt_1', expiresAt: Date.now() + 3_600_000 });
    gs.valid.add('at_1');
    const file = s.write('vars.env', `# comentario\nAPI_KEY=${SECRET}\nexport NEW_KEY="${SECRET}-2"\n`);

    // Sin terminal y sin --yes: no guarda y da el comando exacto.
    const no = await cli(['env', 'push', file]);
    assert.equal(no.code, 1);
    assert.match(no.err, new RegExp(`Sin terminal para confirmar\\. Si la persona ya lo aprobó: ghosty-dev env push ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --yes`));
    assert.equal(gs.posted.length, 0);

    const r = await cli(['env', 'push', file, '--yes']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`Lee: ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(r.out, /Variables para acme\/demo \(espacio acme\): API_KEY, NEW_KEY/);
    assert.match(r.out, /Se quedan como están \(ya guardadas\): OLD_KEY/);
    assert.match(r.out, /Guardadas en acme\/demo/);
    assert.deepEqual(gs.posted, [{ dotenv: readFileSync(file, 'utf8'), replace: false }]);

    const j = await cli(['env', 'push', file, '--replace', '--yes', '--json']);
    assert.equal(j.code, 0, j.err);
    assert.match(j.err, /Con --replace se borran: OLD_KEY/);
    assert.deepEqual(JSON.parse(j.out).keys, ['API_KEY', 'NEW_KEY']);
    assert.equal(gs.posted[1].replace, true);

    for (const x of [no, r, j]) assert.ok(!(x.out + x.err).includes(SECRET), 'se imprimió un valor');
  }));

test('env push lo rechaza antes de mandar si quien llama no es el dueño del espacio', () =>
  withGs({ canWrite: false }, async ({ gs, s, cli, authFile }) => {
    saveSession(authFile, { accessToken: 'at_1', refreshToken: 'rt_1', expiresAt: Date.now() + 3_600_000 });
    gs.valid.add('at_1');
    const file = s.write('vars.env', `API_KEY=${SECRET}\n`);
    const r = await cli(['env', 'push', file, '--yes']);
    assert.equal(r.code, 1);
    assert.match(r.err, /Sólo el dueño del espacio acme guarda variables/);
    assert.equal(gs.posted.length, 0);
    assert.ok(!(r.out + r.err).includes(SECRET));
  }));
