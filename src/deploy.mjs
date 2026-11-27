// `ghosty-dev deploy [<pr>]`: el deploy de un repo privado, sin GitHub Actions. Corre en el clon local el comando que
// declara el repo (`deploy:` de .ghosty/dev.md), espera a que `deploy_check:` dé 200 y deja el resultado en la bitácora
// con un marcador que Ghosty Studio lee (`<!-- ghosty-dev:deploy ok|fail sha=… -->`). `merge` lo llama solo.
import { spawn } from 'node:child_process';
import { api, git } from './gh.mjs';
import { UserError, note, repoTop } from './commands.mjs';
import { closingRefs } from './gate.mjs';
import { deployConfig, deployMarker, DEPLOY_HOWTO } from './deploy-config.mjs';

const REPO = 'repos/{owner}/{repo}';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runCommand(command, cwd, stream) {
  return new Promise((done) => {
    // La salida del deploy se ve en vivo; con --json va a stderr para no ensuciar el JSON.
    const child = spawn('sh', ['-c', command], { cwd, stdio: ['ignore', stream === 'stderr' ? 2 : 'inherit', 'inherit'], env: process.env });
    child.on('error', () => done(127));
    child.on('close', (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}

// Sondea la URL hasta que dé 200 (redirecciones incluidas) o se acabe el tiempo (~3 min por defecto).
async function waitHealthy(url, { onNote }) {
  const max = Number(process.env.GHOSTY_DEV_DEPLOY_CHECK_MS ?? 180_000);
  const every = Number(process.env.GHOSTY_DEV_DEPLOY_CHECK_EVERY_MS ?? 5_000);
  const until = Date.now() + max;
  let status = null;
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
      status = res.status;
      await res.body?.cancel().catch(() => {});
    } catch (e) {
      status = null;
    }
    if (status === 200) return { url, ok: true, status, tries: i + 1 };
    if (Date.now() + every > until) return { url, ok: false, status, tries: i + 1 };
    if (i === 0) onNote(`deploy_check: ${url} respondió ${status ?? 'sin conexión'}; reintento hasta ${Math.round(max / 1000)} s…`);
    await sleep(every);
  }
}

// El PR del commit (si no lo dieron): el que GitHub asocia al commit y ya tiene merge.
function prOfCommit(sha) {
  const list = api('GET', `${REPO}/commits/${sha}/pulls`, undefined, { allowFail: true });
  const p = Array.isArray(list) ? list.find((x) => x?.merged_at) : null;
  return p?.number ?? null;
}

export async function deploy(prArg, { onNote = () => {}, stream = 'stdout' } = {}) {
  const top = repoTop();
  if (!top) throw new UserError('deploy se corre dentro del clon del repo.');
  let cfg = deployConfig(top);
  if (!cfg.deploy) throw new UserError(`Este repo no declara su deploy: ${DEPLOY_HOWTO}.`);
  const info = api('GET', REPO, undefined, { allowFail: true }) ?? {};
  let pr = null;
  if (prArg !== undefined && prArg !== null) {
    pr = api('GET', `${REPO}/pulls/${prArg}`, undefined, { allowFail: true });
    if (!pr?.number) throw new UserError(`No encontré el PR #${prArg} en este repo.`);
    if (!pr.merged_at) throw new UserError(`El PR #${prArg} no tiene merge: el deploy sale de lo que ya entró (ghosty-dev merge ${prArg}).`);
  }
  const base = pr?.base?.ref ?? info.default_branch ?? 'main';
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: top, allowFail: true })?.trim();
  if (branch !== base) throw new UserError(`Estás en ${branch ?? '(sin rama)'}: el deploy sale de ${base}. git switch ${base} && ghosty-dev deploy${prArg ? ` ${prArg}` : ''}`);
  const dirty = (git(['status', '--porcelain'], { cwd: top, allowFail: true }) ?? '').trim();
  if (dirty) throw new UserError(`El árbol de trabajo tiene cambios sin commit; el deploy sale limpio de ${base}:\n${dirty.split('\n').slice(0, 10).map((l) => `  ${l}`).join('\n')}`);
  try {
    git(['pull', '--ff-only'], { cwd: top });
  } catch (e) {
    throw new UserError(`git pull --ff-only falló en ${base} (¿commits locales sin subir o sin remoto?): ${e.message.split('\n').pop()}`);
  }
  const sha = git(['rev-parse', 'HEAD'], { cwd: top }).trim();
  // Lo que declara la base ya actualizada (el pull pudo traer un deploy: nuevo).
  cfg = deployConfig(top).deploy ? deployConfig(top) : cfg;
  const prNumber = pr?.number ?? prOfCommit(sha);
  if (!pr && prNumber) pr = api('GET', `${REPO}/pulls/${prNumber}`, undefined, { allowFail: true });
  onNote(`Deploy de ${base} (${sha.slice(0, 7)}): ${cfg.deploy}`);
  const code = await runCommand(cfg.deploy, top, stream);
  const check = code === 0 && cfg.deployCheck ? await waitHealthy(cfg.deployCheck, { onNote }) : null;
  const ok = code === 0 && (check ? check.ok : true);
  // A la bitácora: el primer pendiente que el PR cierra (si no cierra ninguno, el PR). Sin PR, sólo se dice.
  const target = pr?.number ? closingRefs(pr.body ?? '').find((n) => n !== pr.number) ?? pr.number : null;
  let noted = null;
  if (target) {
    const text = [
      `🚀 **Deploy ${ok ? 'en producción' : 'FALLÓ'}** · commit ${sha.slice(0, 7)} en ${base}${pr?.number ? ` (PR #${pr.number})` : ''}`,
      '',
      `- comando: \`${cfg.deploy}\` → salió ${code}`,
      ...(cfg.deployCheck ? [`- deploy_check: ${cfg.deployCheck} → ${check ? (check.ok ? '200' : `${check.status ?? 'sin respuesta'} tras ${check.tries} intento(s)`) : 'no se probó (el comando falló)'}`] : []),
      '',
      deployMarker(ok, sha),
    ].join('\n');
    try {
      noted = note(target, text).url ?? null;
    } catch (e) {
      onNote(`No pude dejar la nota del deploy en #${target}: ${e.message}`);
    }
  }
  return { pr: pr?.number ?? null, issue: target, base, sha, command: cfg.deploy, code, check, ok, noted, exitCode: ok ? 0 : 1 };
}

export function deployText(x) {
  const lines = [`Deploy de ${x.base} (${x.sha.slice(0, 7)}${x.pr ? `, PR #${x.pr}` : ''}): ${x.ok ? 'en producción' : 'FALLÓ'}.`];
  lines.push(`  ${x.command} → salió ${x.code}`);
  if (x.check) lines.push(`  deploy_check ${x.check.url}: ${x.check.ok ? '200' : `${x.check.status ?? 'sin respuesta'} (no llegó a 200)`}`);
  lines.push(x.noted ? `  Anotado en la bitácora (#${x.issue}): ${x.noted}` : x.issue ? `  No se pudo anotar en #${x.issue}.` : '  Sin PR asociado: no se anotó en la bitácora (ghosty-dev deploy <pr> lo anota).');
  return lines.join('\n');
}
