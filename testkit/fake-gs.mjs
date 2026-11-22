// Ghosty Studio falso en 127.0.0.1: metadata RFC 8414, device flow, token (código + PKCE, device, refresh con
// rotación), revocación, /api/v2/me, la API de variables del repo y la de pendientes en la nube (/api/v2/me/dev-runs). Anota todo en `calls` para las pruebas.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

// Opciones de la nube: `devScope: false` responde 403 insufficient_scope; `runFail` es el mensaje de un 400;
// `redirectRunsTo` manda un 302 a otro origen; `echoToken` mete el Bearer recibido en el mensaje de error.
// `previews`: lo que responde la vista previa de un PR, una respuesta por lectura (la última se repite).
export async function fakeGs({ deviceReplies = ['ok'], saved = ['OLD_KEY', 'API_KEY'], canWrite = true, devScope = true, runFail = null, redirectRunsTo = null, echoToken = false, runs = [], previews = [] } = {}) {
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
    previews: [...previews],
    previewCalls: [],
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
    let pm;
    if ((pm = url.pathname.match(/^\/api\/v2\/me\/repos\/([^/]+)\/([^/]+)\/prs\/(\d+)\/preview$/))) {
      s.previewCalls.push({ repo: `${pm[1]}/${pm[2]}`, pr: Number(pm[3]) });
      if (!devScope) return send(res, 403, { error: 'insufficient_scope', message: 'Falta el permiso dev' });
      const next = s.previews.length > 1 ? s.previews.shift() : s.previews[0] ?? { phase: 'none' };
      const page = `https://www.ghosty.studio/c/dev/pr/${pm[1]}/${pm[2]}/${pm[3]}/preview`;
      return send(res, 200, { repo: `${pm[1]}/${pm[2]}`, pr: Number(pm[3]), sha: null, url: null, error: null, page, ...next });
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
      if (url.pathname === '/api/v2/me/dev-runs' && req.method === 'GET') return send(res, 200, { runs: s.runs.filter((r) => !url.searchParams.get('repo') || r.repo === url.searchParams.get('repo')) });
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
