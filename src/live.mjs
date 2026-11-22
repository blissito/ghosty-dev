// Despertador en vivo para `wait`: escucha `/api/v2/me/dev-runs/live` de Ghosty Studio (SSE, el mismo aviso que mueve
// el tablero web) y corta la espera en cuanto GitHub cuenta algo del repo (merge, push, checks, preview, revisión).
// Sin sesión o sin red, `sleep` es una espera normal: el sondeo con backoff sigue siendo el respaldo (Ley 3).
// Formmy, 22-nov: el agente decía «me bloquea la preview y el CI» con Preview, Smoke y Review ya en verde.
import { baseUrl, existingSession, request } from './auth.mjs';

const plainSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `repo` = «dueño/nombre» o una función que lo da (se llama sólo con sesión: es una llamada a GitHub).
 * Regresa `{ sleep(ms) → Promise<boolean> (true = lo despertó un aviso), close(), live }`.
 */
export async function openLive(repo) {
  const off = { live: false, sleep: async (ms) => (await plainSleep(ms), false), close() {} };
  if (process.env.GHOSTY_DEV_NO_LIVE === '1') return off;
  const session = await existingSession().catch(() => null);
  if (!session) return off;
  let want = '';
  try {
    want = String((typeof repo === 'function' ? repo() : repo) ?? '').toLowerCase();
  } catch {}
  if (!want) return off;
  const token = await tokenOf().catch(() => null);
  if (!token) return off;
  const ctl = new AbortController();
  let res;
  try {
    res = await fetch(`${baseUrl()}/api/v2/me/dev-runs/live`, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }, signal: ctl.signal });
  } catch {
    return off;
  }
  if (!res.ok || !res.body) {
    ctl.abort();
    return off;
  }
  let pending = false; // llegó un aviso mientras nadie dormía: la siguiente espera regresa de inmediato
  let wake = null;
  const poke = () => (wake ? (wake(), (wake = null)) : (pending = true));
  void (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (!/^event: repo$/m.test(block)) continue;
          const data = /^data: (.*)$/m.exec(block)?.[1];
          try {
            if (JSON.parse(data ?? '{}').repo === want) poke();
          } catch {}
        }
      }
    } catch {}
  })();
  return {
    live: true,
    sleep(ms) {
      if (pending) {
        pending = false;
        // Un respiro: GitHub cuenta el cambio en su webhook unos segundos antes de servirlo en la API.
        return plainSleep(Math.min(ms, 2_000)).then(() => true);
      }
      return new Promise((resolve) => {
        const t = setTimeout(() => ((wake = null), resolve(false)), ms);
        wake = () => {
          clearTimeout(t);
          setTimeout(() => resolve(true), Math.min(ms, 2_000));
        };
      });
    },
    close() {
      ctl.abort();
    },
  };
}

// El token vigente (refresca si hace falta) a través de una petición barata: `request` ya sabe renovarlo.
async function tokenOf() {
  if (process.env.GHOSTY_DEV_TOKEN) return process.env.GHOSTY_DEV_TOKEN;
  await request('GET', '/api/v2/me', undefined, { scope: 'profile' }).catch(() => null);
  const { readFileSync } = await import('node:fs');
  const { authPath } = await import('./auth.mjs');
  return JSON.parse(readFileSync(authPath(), 'utf8')).accessToken ?? null;
}
