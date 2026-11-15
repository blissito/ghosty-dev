#!/usr/bin/env node
// gh falso para los tests: guarda issues, PRs y etiquetas en el JSON de FAKE_GH_STATE. Sin red.
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.env.FAKE_GH_STATE;
const db = JSON.parse(readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
db.calls.push(args);
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
  const path = args.find((a, idx) => idx > 0 && !a.startsWith('-') && args[idx - 1] !== '-X' && args[idx - 1] !== '-F');
  let m;
  if (path === 'user') out({ login: db.me });
  else if (path.includes('/contents/.github/ghosty-dev/gate.mjs')) {
    if (db.gateOnBase === false) fail('HTTP 404: Not Found');
    out({ name: 'gate.mjs' });
  }
  else if ((m = path.match(/branches\/([^/]+)\/protection(\/required_status_checks(\/contexts)?)?$/))) {
    if (db.noAdmin) fail('HTTP 403: Must have admin rights to Repository.');
    const body = method === 'GET' ? null : JSON.parse(stdin());
    if (method === 'GET') {
      if (!db.protection) fail('HTTP 404: Branch not protected');
    } else if (method === 'PUT') db.protection = body;
    else if (method === 'PATCH') db.protection.required_status_checks = body;
    else if (method === 'POST') db.protection.required_status_checks.contexts.push(...body.contexts);
    out(db.protection);
  }
  else if ((m = path.match(/issues\/(\d+)\/dependencies\/blocked_by$/))) {
    if (!db.depsApi) fail('HTTP 404: Not Found');
    const i = issue(m[1]);
    if (method === 'POST') {
      const id = Number(flag('-F').split('=')[1]);
      const blocker = Object.values(db.issues).find((x) => x.id === id);
      i.blockedBy.push(blocker.number);
      out({});
    } else {
      out(i.blockedBy.map((n) => ({ number: n, state: db.issues[n].state })));
    }
  } else if ((m = path.match(/issues\/(\d+)$/))) {
    const i = issue(m[1]);
    out({ id: i.id, number: i.number, state: i.state });
  } else fail(`fake gh: api ${path} no soportado`);
} else if (group === 'browse') {
  out('');
} else if (group === 'repo' && verb === 'view') {
  out({ nameWithOwner: db.repo, defaultBranchRef: { name: 'main' }, url: `https://github.com/${db.repo}` });
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
