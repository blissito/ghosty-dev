#!/usr/bin/env node
// gh falso para los tests: guarda issues, PRs y etiquetas en el JSON de FAKE_GH_STATE. Sin red.
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.env.FAKE_GH_STATE;
const db = JSON.parse(readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
db.calls.push(args);
// El repo al que apuntaba GH_REPO en cada llamada (paralelo a calls): las pruebas de owner/repo#n lo leen.
(db.callRepos ??= []).push(process.env.GH_REPO ?? null);
const save = () => writeFileSync(file, JSON.stringify(db, null, 2));
const out = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
const fail = (msg) => {
  save();
  process.stderr.write(msg + '\n');
  process.exit(1);
};
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const stdin = () => readFileSync(0, 'utf8');
const issue = (n) => db.issues[n] ?? fail(`issue ${n} not found`);
// Vista como la da gh --json: etiquetas y asignados como objetos, estado en mayúsculas.
const view = (i) => ({
  ...i,
  state: i.state.toUpperCase(),
  labels: i.labels.map((name) => ({ name })),
  assignees: i.assignees.map((login) => ({ login })),
  url: `https://github.com/${db.repo}/issues/${i.number}`,
});
const login = (who) => (who === '@me' ? db.me : who);

const [group, verb] = args;
if (group === 'label' && verb === 'create') {
  if (!db.labels.includes(args[2])) db.labels.push(args[2]);
} else if (group === 'issue' && verb === 'create') {
  const number = Math.max(0, ...Object.keys(db.issues).map(Number)) + 1;
  db.issues[number] = { number, id: 1000 + number, title: flag('--title'), labels: [flag('--label')], body: stdin(), assignees: [], state: 'open', comments: [], blockedBy: [] };
  out(`https://github.com/${db.repo}/issues/${number}\n`);
} else if (group === 'issue' && verb === 'list') {
  out(Object.values(db.issues).filter((i) => i.state === 'open').map(view));
} else if (group === 'issue' && verb === 'view') {
  out(view(issue(args[2])));
} else if (group === 'issue' && verb === 'edit') {
  const i = issue(args[2]);
  const add = flag('--add-label');
  const remove = flag('--remove-label');
  if (add) for (const l of add.split(',')) if (!i.labels.includes(l)) i.labels.push(l);
  if (remove) i.labels = i.labels.filter((l) => !remove.split(',').includes(l));
  if (flag('--add-assignee')) {
    const who = login(flag('--add-assignee'));
    if (!i.assignees.includes(who)) i.assignees.push(who);
    // Simula una carrera: otro agente se asigna en el mismo instante.
    if (db.raceWith && !i.assignees.includes(db.raceWith)) i.assignees.push(db.raceWith);
  }
  if (flag('--remove-assignee')) i.assignees = i.assignees.filter((a) => a !== login(flag('--remove-assignee')));
  if (flag('--body-file') === '-') i.body = stdin();
} else if (group === 'issue' && verb === 'comment') {
  issue(args[2]).comments.push({ author: { login: db.me }, body: stdin() });
} else if (group === 'issue' && verb === 'close') {
  issue(args[2]).state = 'closed';
} else if (group === 'api') {
  const method = flag('-X') ?? 'GET';
  const full = args.find((a, idx) => idx > 0 && !a.startsWith('-') && args[idx - 1] !== '-X' && args[idx - 1] !== '-F' && args[idx - 1] !== '--input');
  const [path, query = ''] = full.split('?');
  const q = new URLSearchParams(query);
  const body = args.includes('--input') ? JSON.parse(stdin() || 'null') : null;
  const page = (list) => (Number(q.get('page') ?? 1) > 1 ? [] : list);
  // Forma REST de un issue y de un PR.
  const rest = (i) => ({
    id: i.id, number: i.number, title: i.title, state: i.state, body: i.body,
    labels: i.labels.map((name) => ({ name })), assignees: i.assignees.map((l) => ({ login: l })),
    html_url: `https://github.com/${db.repo}/issues/${i.number}`,
  });
  const sha = (p) => p.headRefOid ?? `sha-${p.number}`;
  const prBySha = (x) => db.prs.find((p) => sha(p) === x);
  let m;
  if (path === 'user') out({ login: db.me });
  else if (path === 'repos/{owner}/{repo}') out({ full_name: db.repo, default_branch: 'main', html_url: `https://github.com/${db.repo}`, ...(db.repoInfo ?? {}) });
  else if ((m = path.match(/pulls\/(\d+)\/merge$/))) {
    const p = db.prs.find((x) => String(x.number) === m[1]) ?? fail('HTTP 404: Not Found');
    if (db.mergeFails) fail('HTTP 405: Required status check is expected');
    Object.assign(p, { state: 'closed', mergedAt: '2026-11-22T12:00:00Z', mergedWith: body });
    out({ merged: true, sha: db.mergeSha ?? `merge-${p.number}` });
  }
  else if (path.endsWith('/actions/runs')) out({ workflow_runs: (db.pushRuns ?? []).filter((r) => r.head_sha === q.get('head_sha')).map((r) => { const seen = { ...r }; if (r.then) { Object.assign(r, r.then); delete r.then; } return seen; }) });
  else if ((m = path.match(/issues\/(\d+)\/events$/))) out(page(db.prs.find((p) => String(p.number) === m[1])?.events ?? []));
  else if (path.includes('/contents/.github/ghosty-dev/gate.mjs')) {
    if (db.gateOnBase === false) fail('HTTP 404: Not Found');
    out({ name: 'gate.mjs' });
  }
  else if ((m = path.match(/branches\/([^/]+)\/protection(\/required_status_checks(\/contexts)?)?$/))) {
    if (db.noAdmin) fail('HTTP 403: Must have admin rights to Repository.');
    if (method === 'GET') {
      if (!db.protection) fail('HTTP 404: Branch not protected');
    } else if (method === 'PUT') db.protection = body;
    else if (method === 'PATCH') db.protection.required_status_checks = body;
    else if (method === 'POST') db.protection.required_status_checks.contexts.push(...body.contexts);
    out(db.protection);
  }
  else if ((m = path.match(/\/labels(?:\/(.+))?$/)) && !path.includes('/issues/')) {
    const name = m[1] ? decodeURIComponent(m[1]) : null;
    if (method === 'GET' && !name) out(page(db.labels.map((l) => ({ name: l }))));
    else if (method === 'POST') {
      if (db.labels.includes(body.name)) fail('HTTP 422: already_exists');
      db.labels.push(body.name);
    } else if (method === 'PATCH') {
      if (!db.labels.includes(name)) fail('HTTP 404: Not Found');
      if (body.new_name) db.labels = db.labels.map((l) => (l === name ? body.new_name : l));
    }
    if (method !== 'GET' || name) out({});
  }
  else if ((m = path.match(/issues\/(\d+)\/dependencies\/blocked_by\/(\d+)$/))) {
    // Quitar una dependencia nativa: el último segmento es el id del bloqueador, no su número.
    if (!db.depsApi || db.depsDeleteFails) fail('HTTP 403: Resource not accessible');
    const i = issue(m[1]);
    const blocker = Object.values(db.issues).find((x) => x.id === Number(m[2]));
    if (!blocker || !i.blockedBy.includes(blocker.number)) fail('HTTP 404: Not Found');
    i.blockedBy = i.blockedBy.filter((n) => n !== blocker.number);
    out(rest(i));
  }
  else if ((m = path.match(/issues\/(\d+)\/dependencies\/blocked_by$/))) {
    if (!db.depsApi) fail('HTTP 404: Not Found');
    const i = issue(m[1]);
    if (method === 'POST') {
      const blocker = Object.values(db.issues).find((x) => x.id === Number(body.issue_id));
      i.blockedBy.push(blocker.number);
      out({});
    } else {
      out(i.blockedBy.map((n) => ({ id: db.issues[n].id, number: n, state: db.issues[n].state })));
    }
  }
  else if ((m = path.match(/issues\/(\d+)\/labels(?:\/(.+))?$/))) {
    const i = issue(m[1]);
    if (method === 'POST') for (const l of body.labels) if (!i.labels.includes(l)) i.labels.push(l);
    if (method === 'DELETE') i.labels = i.labels.filter((l) => l !== decodeURIComponent(m[2]));
    out(i.labels.map((name) => ({ name })));
  }
  else if ((m = path.match(/issues\/(\d+)\/assignees$/))) {
    const i = issue(m[1]);
    if (method === 'POST') {
      for (const who of body.assignees) if (!i.assignees.includes(who)) i.assignees.push(who);
      // Simula una carrera: otro agente se asigna en el mismo instante.
      if (db.raceWith && !i.assignees.includes(db.raceWith)) i.assignees.push(db.raceWith);
    }
    if (method === 'DELETE') i.assignees = i.assignees.filter((a) => !body.assignees.includes(a));
    out(rest(i));
  }
  else if ((m = path.match(/issues\/(\d+)\/comments$/)) && !db.issues[m[1]] && db.prs.some((p) => String(p.number) === m[1])) {
    // Comentarios de la conversación de un PR (ahí también vive la ficha).
    out(page((db.prs.find((p) => String(p.number) === m[1]).comments ?? []).map((c) => ({ body: c.body, user: { login: c.author?.login, type: c.author?.type }, created_at: c.createdAt }))));
  }
  else if ((m = path.match(/pulls\/(\d+)\/comments$/))) out(page(db.prs.find((p) => String(p.number) === m[1])?.reviewComments ?? []));
  else if (path.endsWith('/deployments')) out((db.deployments ?? []).filter((d) => d.sha === q.get('sha')).map((d) => ({ id: d.id, sha: d.sha })));
  else if ((m = path.match(/deployments\/(\d+)\/statuses$/))) out((db.deployments ?? []).filter((d) => String(d.id) === m[1]).map((d) => ({ state: 'success', environment_url: d.url })));
  else if ((m = path.match(/issues\/(\d+)\/comments$/))) {
    const i = issue(m[1]);
    if (method === 'POST') {
      i.comments.push({ author: { login: db.me }, body: body.body });
      out({ html_url: `https://github.com/${db.repo}/issues/${i.number}#issuecomment-${i.comments.length}` });
    } else out(page(i.comments.map((c) => ({ body: c.body, user: { login: c.author?.login, type: c.author?.type }, created_at: c.createdAt }))));
  }
  else if ((m = path.match(/issues\/(\d+)$/)) && !db.issues[m[1]] && db.prs.some((p) => String(p.number) === m[1])) {
    // Como GitHub: el endpoint de issues también devuelve los PR, con `pull_request`.
    const p = db.prs.find((x) => String(x.number) === m[1]);
    out({ number: p.number, title: p.title ?? `PR ${p.number}`, state: p.state ?? 'open', body: p.body ?? '', labels: [], assignees: [], html_url: p.url, pull_request: { url: p.url } });
  }
  else if ((m = path.match(/issues\/(\d+)$/))) {
    const i = issue(m[1]);
    if (method === 'PATCH') Object.assign(i, body.body !== undefined ? { body: body.body } : {}, body.state ? { state: body.state } : {}, body.state_reason ? { stateReason: body.state_reason } : {});
    out(rest(i));
  }
  else if (path.endsWith('/issues')) {
    if (method === 'POST') {
      const number = Math.max(0, ...Object.keys(db.issues).map(Number)) + 1;
      db.issues[number] = { number, id: 1000 + number, title: body.title, labels: body.labels ?? [], body: body.body, assignees: [], state: 'open', comments: [], blockedBy: [] };
      out(rest(db.issues[number]));
    } else out(page(Object.values(db.issues).filter((i) => i.state === 'open').map(rest)));
  }
  else if ((m = path.match(/pulls\/(\d+)$/))) {
    const p = db.prs.find((x) => String(x.number) === m[1]) ?? fail('HTTP 404: Not Found');
    if (method === 'PATCH') {
      p.body = body.body;
      p.bodyEdits = (p.bodyEdits ?? 0) + 1;
    }
    // mergeable: `mergeableNull` lecturas en null (GitHub calculándolo) y luego `mergeable`/`mergeableState`.
    let mergeable = p.mergeable;
    if (p.mergeableNull > 0) {
      p.mergeableNull -= 1;
      p.mergeableReads = (p.mergeableReads ?? 0) + 1;
      mergeable = null;
    }
    out({ mergeable, mergeable_state: mergeable === null ? 'unknown' : p.mergeableState, base: { ref: p.baseRefName ?? 'main' }, number: p.number, title: p.title ?? `PR ${p.number}`, state: p.state ?? 'open', draft: Boolean(p.draft), merged_at: p.mergedAt ?? null, closed_at: p.closedAt ?? null, body: p.body ?? '', html_url: p.url, head: { ref: p.headRefName, sha: sha(p) } });
  }
  else if (path.endsWith('/pulls') && method === 'POST') {
    // Abrir un PR (ghosty-dev pr): queda abierto con el cuerpo que mandó el CLI.
    const number = Math.max(100, ...db.prs.map((p) => p.number)) + 1;
    const pr = { number, title: body.title, url: `https://github.com/${db.repo}/pull/${number}`, headRefName: body.head, headRefOid: 'f'.repeat(40), body: body.body, draft: Boolean(body.draft), baseRefName: body.base };
    db.prs.push(pr);
    out({ number, html_url: pr.url });
  }
  else if (path.endsWith('/pulls')) out(page(db.prs.filter((p) => (p.state ?? 'open') === (q.get('state') ?? 'open')).map((p) => ({ number: p.number, title: p.title ?? `PR ${p.number}`, state: p.state ?? 'open', draft: Boolean(p.draft), merged_at: p.mergedAt ?? null, closed_at: p.closedAt ?? null, html_url: p.url, body: p.body ?? '', base: { ref: p.baseRefName ?? 'main' }, head: { ref: p.headRefName, sha: sha(p) } }))));
  else if ((m = path.match(/compare\/([^.]+)\.\.\.(.+)$/))) out({ status: (db.ancestors ?? []).includes(`${m[1]}...${m[2]}`) ? 'ahead' : 'diverged' });
  else if ((m = path.match(/commits\/([^/]+)\/check-runs$/))) {
    const p = prBySha(m[1]);
    // Simula que el CI termina mientras se espera: la segunda lectura de un check corriendo ya lo ve terminado.
    const runs = (p?.statusCheckRollup || []).map((c) => {
      const seen = { id: c.id, head_sha: m[1], ...(c.app ? { app: { slug: c.app } } : {}), name: c.name, status: c.status === 'COMPLETED' ? 'completed' : 'in_progress', conclusion: c.conclusion ? c.conclusion.toLowerCase() : null, details_url: c.detailsUrl, output: c.title ? { title: c.title } : undefined };
      // `then` simula un servicio de la plataforma que termina con otra conclusión (y título) que el CI.
      if (c.status !== 'COMPLETED' && c.then) Object.assign(c, { status: 'COMPLETED', ...c.then });
      else if (c.status !== 'COMPLETED' && db.ciResult !== undefined) Object.assign(c, { status: 'COMPLETED', conclusion: db.ciResult });
      return seen;
    });
    out({ check_runs: page(runs) });
  }
  else if ((m = path.match(/commits\/([^/]+)\/status$/))) out({ statuses: prBySha(m[1])?.statuses ?? [] });
  else if (path.match(/actions\/workflows\/[^/]+\/runs$/)) out({ workflow_runs: (db.runs ?? []).filter((r) => !q.get('head_sha') || !r.headSha || r.headSha === q.get('head_sha')).map((r) => ({ id: r.databaseId, status: r.status ?? 'completed' })) });
  else if ((m = path.match(/actions\/runs\/(\d+)\/rerun$/))) {
    (db.reruns ??= []).push(Number(m[1]));
    out({});
  }
  else fail(`fake gh: api ${method} ${path} no soportado`);
} else if (group === 'browse') {
  out('');
} else if (group === 'repo' && verb === 'view') {
  out({ nameWithOwner: db.repo, defaultBranchRef: { name: 'main' }, url: `https://github.com/${db.repo}` });
} else if (group === 'pr' && verb === 'checks') {
  // Simula que el CI termina mientras se espera.
  for (const p of db.prs) for (const c of p.statusCheckRollup || []) if (c.status !== 'COMPLETED') Object.assign(c, { status: 'COMPLETED', conclusion: db.ciResult });
  out('');
} else if (group === 'pr' && verb === 'list') {
  out(db.prs);
} else if (group === 'run' && verb === 'list') {
  out(db.runs ?? []);
} else if (group === 'run' && verb === 'rerun') {
  out('');
} else {
  fail(`fake gh: ${args.join(' ')} no soportado`);
}
save();
