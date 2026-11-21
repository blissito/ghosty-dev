#!/usr/bin/env node
// `ghosty` falso para probar la nube sin red: anota cada llamada y contesta lo que diga el estado.
import { readFileSync, writeFileSync } from 'node:fs';
const file = process.env.FAKE_GHOSTY_STATE;
const db = JSON.parse(readFileSync(file, 'utf8'));
const args = process.argv.slice(2).filter((a) => a !== '--json');
db.calls.push(args);
const run = (over) => ({ id: 'run1', repo: 'acme/demo', issue: 5, title: 'Salud', phase: 'working', estado: 'trabajando', pr: null, prUrl: null, issueUrl: 'https://github.com/acme/demo/issues/5', branch: 'ghosty-dev/5-salud', ...over });
let out;
if (db.fail) {
  process.stderr.write(db.fail + '\n');
  writeFileSync(file, JSON.stringify(db));
  process.exit(1);
}
if (args[0] === 'dev' && args[1] === 'run') {
  db.runs.push(run({ issue: Number(args[args.indexOf('--issue') + 1]) }));
  out = db.runs.at(-1);
} else if (args[0] === 'dev' && args[1] === 'ls') out = { runs: db.runs };
else if (args[0] === 'dev' && args[1] === 'stop') {
  const r = db.runs.find((x) => x.id === args[2]);
  r.phase = 'stopped';
  r.estado = 'detenido';
  out = r;
} else process.exit(2);
writeFileSync(file, JSON.stringify(db));
console.log(JSON.stringify(out));
