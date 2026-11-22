// Un repo en la rama feat/x con el PR #73 abierto (su HEAD = el HEAD local), un gs falso y una sesión aprobada.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup } from './helpers.mjs';
import { fakeGs } from './fake-gs.mjs';

export async function withPreview(previews, fn, { gsOpts = {}, prs } = {}) {
  const gs = await fakeGs({ previews, ...gsOpts });
  const s = setup();
  const git = (...a) => execFileSync('git', a, { cwd: s.repo, encoding: 'utf8' }).trim();
  git('checkout', '-q', '-b', 'feat/x');
  const head = git('rev-parse', 'HEAD');
  const db = s.read();
  db.prs = prs ?? [{ number: 73, title: 'Login con Google', url: 'https://github.com/acme/demo/pull/73', headRefName: 'feat/x', headRefOid: head, body: 'Closes #5', comments: [], statusCheckRollup: [] }];
  writeFileSync(join(s.root, 'gh.json'), JSON.stringify(db));
  const tok = gs.grant();
  mkdirSync(join(s.config, 'ghosty-dev'), { recursive: true, mode: 0o700 });
  writeFileSync(join(s.config, 'ghosty-dev', 'auth.json'), JSON.stringify({ baseUrl: gs.base, accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: Date.now() + 3_600_000, scope: tok.scope }), { mode: 0o600 });
  const cli = (args, extra = {}) => s.runAsync(args, { extra: { GHOSTY_DEV_BASE_URL: gs.base, CI: '1', GHOSTY_DEV_PREVIEW_POLL_MS: '1', ...extra } });
  try {
    await fn({ gs, s, cli, head });
  } finally {
    await gs.close();
  }
}

