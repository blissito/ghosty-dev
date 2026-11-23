// Ghosty Studio falso en 127.0.0.1: metadata RFC 8414, device flow, token (código + PKCE, device, refresh con
// rotación), revocación, /api/v2/me, la API de variables del repo y la de pendientes en la nube (/api/v2/me/dev-runs). Anota todo en `calls` para las pruebas.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

// Opciones de la nube: `devScope: false` responde 403 insufficient_scope; `runFail` es el mensaje de un 400;
// `redirectRunsTo` manda un 302 a otro origen; `echoToken` mete el Bearer recibido en el mensaje de error.
// `previews`: lo que responde la vista previa de un PR, una respuesta por lectura (la última se repite).
export async function fakeGs({ deviceReplies = ['ok'], saved = ['OLD_KEY', 'API_KEY'], canWrite = true, devScope = true, runFail = null, redirectRunsTo = null, echoToken = false, runs = [], previews = [], box = undefined, capacity = null, boardPrs = [], factory = null } = {}) {
  const s = {
    calls: [],
    polls: [],
    valid: new Set(), // access tokens vigentes
    refresh: null, // el refresh vigente (rota en cada uso)
    challenge: null, // lo que «el navegador» vio en la URL de autorización
    codes: new Map(), // code → redirect_uri
    deviceReplies: [...deviceReplies],
    saved,
    canWrite,
    posted: [],
    revoked: [],
    n: 0,
    runs: [...runs],
    devCalls: [],
    // La fábrica del repo (gs «Pausar la fábrica»); null = gs viejo que no la conoce (404).
    factory: factory ? { repo: 'acme/demo', active: true, mode: 'on', until: null, reason: null, line: 'Fábrica encendida', queued: 0, ...factory } : null,
    factoryCalls: [],
    previews: [...previews],
    previewCalls: [],
    loginCalls: [],
    // Vista previa combinada (fila 63): fases que va contestando y, si se pone, el conflicto.
    combined: { phases: ['building', 'ready'], conflict: null },
    combinedCalls: [],
    // La prueba de login de la vista previa (GET …/preview/login): lo que contesta gs.
    loginProbe: { verdict: 'session', path: '/dashboard', message: 'con identidad /dashboard responde 200; sin ella, 302 → /', withIdentity: { status: 200, location: null }, withoutIdentity: { status: 302, location: '/' } },
    // La caja de la vista previa: null = el PR no tiene caja (404); { seat: false } = sin asiento (403).
    box: box === undefined ? { log: 'npm run build\nlisto en :3000\n', execText: null, execCode: 0, seat: true } : box,
    boxCalls: [],
    shareCalls: [],
    share: { shared: false, url: null, n: 0, closed: false, requests: [{ id: 'ar_1', email: 'clienta@ejemplo.com', name: 'Clienta\x1b[31m', status: 'pending', createdAt: '2026-11-22T18:30:00.000Z', resolvedAt: null }] },
  };
  const issue = () => {
    s.n += 1;
    const access = `at_${s.n}`;
    s.refresh = `rt_${s.n}`;
    s.valid.add(access);
    return { access_token: access, refresh_token: s.refresh, expires_in: 3600, token_type: 'Bearer', scope: devScope ? 'profile repo:env dev' : 'profile repo:env' };
  };
  s.grant = issue; // una sesión ya aprobada, para las pruebas que no prueban el login
  const run = (over) => ({ id: `run${s.runs.length + 1}`, repo: 'acme/demo', issue: 5, title: 'Salud', phase: 'working', estado: 'trabajando', pr: null, prUrl: null, issueUrl: 'https://github.com/acme/demo/issues/5', branch: 'ghosty-dev/5-salud', ...over });
  const send = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const url = new URL(req.url, 'http://127.0.0.1');
    const formBody = req.headers['content-type']?.startsWith('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(raw)) : null;
    s.calls.push({ method: req.method, path: url.pathname, form: formBody, ua: req.headers['user-agent'], auth: req.headers.authorization ?? null });
    const base = `http://127.0.0.1:${server.address().port}`;
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      // Sin device_authorization_endpoint, como gs hoy: el cliente cae a ${base}/oauth2/device.
      return send(res, 200, { issuer: base, authorization_endpoint: `${base}/oauth2/authorize`, token_endpoint: `${base}/oauth2/token`, revocation_endpoint: `${base}/oauth2/revoke` });
    }
    if (url.pathname === '/oauth2/device') {
      if (formBody?.client_id !== 'ghosty-dev') return send(res, 401, { error: 'invalid_client' });
      return send(res, 200, { device_code: 'dc_1', user_code: 'ABCD-EFGH', verification_uri: `${base}/device`, verification_uri_complete: `${base}/device?code=ABCD-EFGH`, interval: 1, expires_in: 600 });
    }
    if (url.pathname === '/oauth2/token') {
      const f = formBody ?? {};
      if (f.client_id !== 'ghosty-dev') return send(res, 401, { error: 'invalid_client' });
      if (f.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        s.polls.push(Date.now());
        const next = s.deviceReplies.shift() ?? 'ok';
        return next === 'ok' ? send(res, 200, issue()) : send(res, 400, { error: next });
      }
      if (f.grant_type === 'authorization_code') {
        const pkce = createHash('sha256').update(f.code_verifier ?? '').digest('base64url');
        if (s.codes.get(f.code) !== f.redirect_uri || pkce !== s.challenge) return send(res, 400, { error: 'invalid_grant' });
        s.codes.delete(f.code);
        return send(res, 200, issue());
      }
      if (f.grant_type === 'refresh_token') {
        if (!f.refresh_token || f.refresh_token !== s.refresh) return send(res, 400, { error: 'invalid_grant' });
        return send(res, 200, issue());
      }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/oauth2/revoke') {
      s.revoked.push(formBody);
      if (formBody?.token === s.refresh) s.refresh = null;
      return res.writeHead(200).end();
    }
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!s.valid.has(token)) return send(res, 401, { error: 'invalid_token' });
    if (url.pathname === '/api/v2/me') return send(res, 200, { id: 'u1', email: 'persona@ejemplo.com', scopes: ['profile', 'repo:env'], client: 'ghosty-dev' });
    if (url.pathname === '/api/v2/me/repos/acme/demo/env') {
      if (req.method === 'GET') return send(res, 200, { repo: 'acme/demo', workspace: 'acme', rooms: ['dev'], saved: s.saved, missing: ['FALTA_KEY'], risks: [], blocked: [], canWrite: s.canWrite });
      const body = JSON.parse(raw || '{}');
      s.posted.push(body);
      const keys = body.dotenv.split('\n').filter((l) => /^\s*(export\s+)?\w+=/.test(l)).map((l) => l.replace(/^\s*export\s+/, '').split('=')[0]);
      return send(res, 200, { repo: 'acme/demo', workspace: 'acme', keys, sent: keys, kept: body.replace ? [] : s.saved.filter((k) => !keys.includes(k)), dropped: [], risks: [] });
    }
    if (url.pathname === '/api/v2/me/repos/acme/demo/factory') {
      if (!s.factory) return send(res, 404, { error: 'not_found' });
      const body = req.method === 'POST' ? JSON.parse(raw || '{}') : null;
      s.factoryCalls.push({ method: req.method, query: url.search, body });
      if (body?.action === 'pause') Object.assign(s.factory, { active: false, mode: body.until ? s.factory.mode : 'paused', until: body.until ?? null, line: `Fábrica en pausa${body.until ? ' hasta las 8:00' : ''}${body.reason ? ` (${body.reason})` : ''}` });
      if (body?.action === 'resume') Object.assign(s.factory, { active: true, mode: 'on', until: null, line: 'Fábrica encendida' });
      if (body?.action === 'schedule') Object.assign(s.factory, { mode: 'scheduled', schedule: body.preset ?? body.schedule, timezone: 'America/Mexico_City' });
      return send(res, 200, { ...s.factory, repo: url.search.includes('all=1') || body?.all ? '*' : 'acme/demo' });
    }
    let pm;
    if ((pm = url.pathname.match(/^\/api\/v2\/me\/repos\/([^/]+)\/([^/]+)\/prs\/(\d+)\/preview$/))) {
      s.previewCalls.push({ repo: `${pm[1]}/${pm[2]}`, pr: Number(pm[3]) });
      if (!devScope) return send(res, 403, { error: 'insufficient_scope', message: 'Falta el permiso dev' });
      const next = s.previews.length > 1 ? s.previews.shift() : s.previews[0] ?? { phase: 'none' };
      const page = `https://www.ghosty.studio/c/dev/pr/${pm[1]}/${pm[2]}/${pm[3]}/preview`;
      return send(res, 200, { repo: `${pm[1]}/${pm[2]}`, pr: Number(pm[3]), sha: null, url: null, error: null, page, ...next });
    }
    if ((pm = url.pathname.match(/^\/api\/v2\/me\/repos\/([^/]+)\/([^/]+)\/prs\/(\d+)\/preview\/combined$/))) {
      const body = raw ? JSON.parse(raw) : null;
      s.combinedCalls.push({ method: req.method, pr: Number(pm[3]), query: url.search, body });
      if (!devScope) return send(res, 403, { error: 'insufficient_scope', message: 'Falta el permiso dev' });
      const pr = Number(pm[3]);
      const others = body?.with ?? (url.searchParams.get('with') ?? '').split(',').map(Number);
      const prs = [pr, ...others];
      if (req.method === 'DELETE') return send(res, 200, { repo: `${pm[1]}/${pm[2]}`, prs, removed: 1 });
      const c = s.combined;
      if (req.method === 'POST' && c.conflict) return send(res, 409, { error: 'conflict', pr: c.conflict.pr, files: c.conflict.files, message: `#${c.conflict.pr} choca con #${pr} en ${c.conflict.files.join(', ')}: resuélvelo en uno de los PR (rebase) y vuelve a pedirla.` });
      const phase = c.phases.length > 1 ? c.phases.shift() : c.phases[0];
      return send(res, req.method === 'POST' ? 202 : 200, {
        repo: `${pm[1]}/${pm[2]}`, prs, phase, sha: 'c0ffee0000000000000000000000000000000000',
        heads: prs.map((n, i) => ({ pr: n, sha: String(i + 1).repeat(40) })), base: { ref: 'main', sha: 'b'.repeat(40) },
        expiresAt: '2026-11-22T22:00:00.000Z', url: phase === 'ready' ? 'https://www.ghosty.studio/preview/s/pvs_SECRETO0123456789' : null, error: null,
      });
    }
    if ((pm = url.pathname.match(/^\/api\/v2\/me\/repos\/([^/]+)\/([^/]+)\/prs\/(\d+)\/preview\/login$/))) {
      s.loginCalls.push({ method: req.method, pr: Number(pm[3]), query: url.search, body: raw ? JSON.parse(raw) : null });
      if (!devScope) return send(res, 403, { error: 'insufficient_scope', message: 'Falta el permiso dev' });
      const identity = { email: 'smoke@ghosty.studio', name: 'Ghosty Smoke' };
      if (req.method === 'POST') {
        const body = raw ? JSON.parse(raw) : {};
        return send(res, 200, { repo: `${pm[1]}/${pm[2]}`, pr: Number(pm[3]), identity, url: 'https://www.ghosty.studio/preview/login/nonce_SECRETO0123456789abcdef', path: body.path ?? '/', expiresIn: 600, oneTime: true });
      }
      return send(res, 200, { repo: `${pm[1]}/${pm[2]}`, pr: Number(pm[3]), identity, ...s.loginProbe, path: url.searchParams.get('path') ?? s.loginProbe.path });
    }
    if ((pm = url.pathname.match(/^\/api\/v2\/me\/repos\/([^/]+)\/([^/]+)\/prs\/(\d+)\/(share|access-requests)$/))) {
      const body = raw ? JSON.parse(raw) : null;
      s.shareCalls.push({ method: req.method, what: pm[4], pr: Number(pm[3]), query: url.search, body });
      if (!devScope) return send(res, 403, { error: 'insufficient_scope', message: 'Falta el permiso dev' });
      const repo = `${pm[1]}/${pm[2]}`;
      const pr = Number(pm[3]);
      const sh = s.share;
      if (pm[4] === 'share') {
        if (req.method === 'POST') {
          if (sh.closed) return send(res, 409, { error: 'conflict', message: 'El PR está cerrado: no se comparte.' });
          if (!sh.shared) Object.assign(sh, { shared: true, url: sh.url ?? `https://www.ghosty.studio/pv/pvt_SECRETO${++sh.n}`, createdAt: '2026-11-22T18:00:00.000Z' });
        }
        if (req.method === 'DELETE') Object.assign(sh, { shared: false, url: null });
        return send(res, 200, { repo, pr, shared: sh.shared, url: sh.shared ? sh.url : null, createdAt: sh.shared ? sh.createdAt : null, lastUsedAt: null });
      }
      if (req.method === 'GET') {
        const st = url.searchParams.get('status') ?? 'pending';
        return send(res, 200, { repo, pr, requests: sh.requests.filter((q) => st === 'all' || q.status === st) });
      }
      const q = sh.requests.find((x) => x.id === body?.id);
      if (!q) return send(res, 404, { error: 'not_found', message: 'No existe esa solicitud.' });
      if (body.decision !== 'accept' && body.decision !== 'reject') return send(res, 400, { error: 'bad_request', message: 'decision: accept | reject' });
      Object.assign(q, { status: body.decision === 'accept' ? 'accepted' : 'rejected', resolvedAt: '2026-11-22T19:00:00.000Z' });
      return send(res, 200, { repo, pr, request: q });
    }
    if ((pm = url.pathname.match(/^\/api\/v2\/me\/repos\/([^/]+)\/([^/]+)\/prs\/(\d+)\/box$/))) {
      const body = raw ? JSON.parse(raw) : null;
      s.boxCalls.push({ method: req.method, pr: Number(pm[3]), query: url.search, body });
      if (!devScope) return send(res, 403, { error: 'insufficient_scope', message: 'Falta el permiso dev' });
      if (!s.box) return send(res, 404, { error: 'not_found', message: 'Este PR no tiene caja de preview: se arma sola con el siguiente push (PR no borrador).' });
      // Caja colgada (sin memoria): gs contesta 503 box_unresponsive con la causa.
      if (s.box.hung) return send(res, 503, { error: 'box_unresponsive', message: s.box.hung });
      if (req.method !== 'GET' && s.box.seat === false) return send(res, 403, { error: 'forbidden', message: 'sólo el dueño o un miembro del espacio opera la caja' });
      const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
      if (req.method === 'GET') return send(res, 200, { phase: 'failed', sha, text: s.box.log, exitCode: 0, ...(s.box.memory ? { memory: s.box.memory } : {}) });
      if (body?.op === 'exec') return send(res, 200, { phase: 'ready', sha, text: s.box.execText ?? `$ ${body.cmd}\n200`, exitCode: s.box.execCode });
      if (body?.op === 'restart') return send(res, 200, { phase: 'ready', sha, text: 'reiniciada\n', exitCode: 0 });
      if (body?.op === 'rebuild') return send(res, 200, { phase: 'building', sha });
      return send(res, 400, { error: 'bad_request', message: 'op: exec | restart | rebuild' });
    }
    if (url.pathname.startsWith('/api/v2/me/dev-runs')) {
      const body = raw ? JSON.parse(raw) : null;
      s.devCalls.push({ method: req.method, path: url.pathname, query: url.search, body });
      if (redirectRunsTo) return res.writeHead(302, { location: `${redirectRunsTo}${url.pathname}${url.search}` }).end();
      if (!devScope) return send(res, 403, { error: 'insufficient_scope', message: 'Falta el permiso dev' });
      if (echoToken) return send(res, 400, { error: 'bad_request', message: `token recibido: ${req.headers.authorization}` });
      if (runFail) return send(res, 400, { error: 'bad_request', message: runFail });
      if (url.pathname === '/api/v2/me/dev-runs' && req.method === 'POST') {
        // Con pr y sin writer "cloud": servicios del PR, sin pendiente y SIN id.
        if (body.pr && !body.issue && body.writer !== 'cloud') return send(res, 200, { repo: body.repo, pr: body.pr, prUrl: `https://github.com/${body.repo}/pull/${body.pr}`, services: 'on', nota: 'tu terminal sigue escribiendo' });
        const prev = s.runs.find((r) => r.issue === body.issue && r.phase !== 'stopped');
        if (prev) return send(res, 200, { ...prev, yaEstaba: true });
        s.runs.push(run({ issue: body.issue }));
        return send(res, 200, s.runs.at(-1));
      }
      if (url.pathname === '/api/v2/me/dev-runs/capacity' && req.method === 'GET') return !capacity ? send(res, 404, { error: 'not_found' }) : capacity.status ? send(res, capacity.status, capacity.body) : send(res, 200, capacity);
      if (url.pathname === '/api/v2/me/dev-runs' && req.method === 'GET') return send(res, 200, { prs: boardPrs, runs: s.runs.filter((r) => !url.searchParams.get('repo') || r.repo === url.searchParams.get('repo')) });
      const id = decodeURIComponent(url.pathname.split('/')[5] ?? '');
      const r = s.runs.find((x) => x.id === id);
      if (!r) return send(res, 404, { error: 'not_found', message: 'No existe ese pendiente' });
      if (req.method === 'GET') return send(res, 200, { ...r, events: [] });
      if (body?.op === 'stop') Object.assign(r, { phase: 'stopped', estado: 'detenido' });
      return send(res, 200, r);
    }
    return send(res, 404, { error: 'not_found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  s.base = `http://127.0.0.1:${server.address().port}`;
  // Lo que hace el navegador de la persona: ve la URL de autorización y gs la regresa a la redirect_uri.
  s.authorize = (authUrl, { code = 'code_1', state } = {}) => {
    const u = new URL(authUrl);
    s.challenge = u.searchParams.get('code_challenge');
    s.codes.set(code, u.searchParams.get('redirect_uri'));
    const back = new URL(u.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', state ?? u.searchParams.get('state'));
    return fetch(back);
  };
  s.close = () => new Promise((r) => {
    server.close(r);
    server.closeAllConnections();
  });
  return s;
}
