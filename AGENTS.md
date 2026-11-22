<!-- ghosty-dev:agents -->
## Bitácora (ghosty-dev)

**El flujo en 5 renglones** (relee esto al retomar o tras compactar):

1. `ghosty-dev next` — el siguiente paso exacto según el repo (empieza aquí siempre, también tras compactar).
2. Trabajo nuevo: `ghosty-dev claim <n>`. Trabajo que ya existe (PR a mano, rama propia): `ghosty-dev claim --pr <m> --issue <n>`.
3. Push → `ghosty-dev preview --wait --json` → prueba la app; si falla: `ghosty-dev box logs` / `box exec -- <cmd>` → arregla → push.
4. CI verde → revisión de otra sesión: `ghosty-dev review <n> --pr <m>` (subagente ghosty-dev-revisor), 0 hallazgos abiertos.
5. `ghosty-dev evidence <n> --pr <m> --file evidencia.md` (re-dispara la puerta) → la persona mezcla. Nunca `gh issue comment` a mano.

Este repo usa **ghosty-dev**: las tareas son issues de GitHub con etiqueta `ghosty-dev:*` y se cierran con
evidencia. No uses listas TODO en markdown para llevar el trabajo.

1. **El trabajo vive en la bitácora, no en la sesión.** Empieza con `ghosty-dev ready --json`, toma uno con
   `ghosty-dev claim <n>` y trabaja sólo en su worktree (`../<repo>-<n>`, rama `ghosty-dev/<n>-…`).
2. **Se revisa la evidencia, no el código.** Con el CI en verde, otro agente con contexto limpio revisa el PR
   (subagente `ghosty-dev-revisor`, o `ghosty-dev review <n>` en otra sesión); tú no te calificas. Con la revisión
   en 0 hallazgos abiertos: `ghosty-dev evidence <n> --file evidencia.md`
   (secciones «Qué se hizo», «Verificación» con comandos `$ …` y su salida real, «CI» con resultado y liga,
   «Preview», «Criterios de aceptación» marcados). Un smoke que sólo abre `/login` no prueba nada: la evidencia dice qué acción real ejerciste con sesión (qué
   mensaje, qué respuesta); `evidence --check` avisa si no la encuentra. El PR lleva `Closes #<n>`; sin revisión del commit actual y sin
   evidencia, el check `ghosty-dev/evidencia` no deja mergear. Nunca cierres un issue sin evidencia.
3. **Se espera por evento, no se sondea.** Con el PR abierto: `ghosty-dev wait <n> --watch` espera al CI en una sola llamada (tope 5 min); si tarda más, toma otro pendiente o termina. Si el repo está conectado a Ghosty Studio, `wait --watch` también avisa cuando la vista previa y la revisión de Ghosty terminan, y `ghosty-dev show <n>` da la ficha y los servicios del PR (vista previa con su liga, revisión, smoke, CI): no hace falta otro CLI.
   Para probar la app: push → `ghosty-dev preview --wait --json` → prueba la app en `url` → evidencia (0 lista, 75 armándose, 1 falló; sin pendiente: `show --pr <m>`);
   si falla: `ghosty-dev box logs` / `ghosty-dev box exec -- <comando>` → arregla → push (la caja la administras tú; `wait --pr <m> --until ci|review` espera sin pendiente).
   La liga lleva la llave de la vista previa: nunca la pegues en la evidencia, el issue ni el PR.
   `ghosty-dev ready` te lo vuelve a ofrecer cuando el CI resuelva.

La nube (`claim <n> --cloud`) y las variables de la vista previa (secretos) van con `ghosty-dev login --no-wait` → la persona aprueba la liga →
`ghosty-dev login --wait` (sólo si `whoami` no encuentra sesión, y preguntando antes) y `ghosty-dev env ls | push <archivo>`
(sesión propia de Ghosty Studio; GitHub sigue siendo `gh`). El archivo lo nombra la persona y ningún valor se imprime.

**OAuth en previews** (entrar con Google/GitHub en la vista previa):
- Si existe `GS_PREVIEW_OAUTH_REDIRECT_URI`, úsalo como `redirect_uri` al pedir el código **y al canjearlo** (si no, `redirect_uri_mismatch`).
- Arma el `state` con `previewOAuthState(state, '/ruta/del/callback')` (snippet de 10 líneas: docs de Ghosty Studio, fabrica/oauth-en-previews; usa `GS_PREVIEW_OAUTH_STATE_KEY`).
- Una sola vez, el dueño registra `https://www.ghosty.studio/preview-oauth/callback` en el proveedor (GitHub: un OAuth App aparte para previews).
- `ghosty-dev doctor` dice qué falta (llaves, callback, registro) y los pasos.

**Login en previews sin OAuth** (identidad de Ghosty, como Cloudflare Access): quien abre la vista previa desde Ghosty
(dueño, miembro o invitado aceptado) llega con el header `X-Ghosty-Identity` (JWT EdDSA de 12 h, atado al host de la
preview). La app lo verifica con el JWKS de Ghosty y crea su sesión; súbelo a main una vez y cualquier PR prueba logueado:
```js
// app/preview-identity.server.js — sólo en vistas previas de Ghosty (en producción la variable no existe)
import { createRemoteJWKSet, jwtVerify } from "jose";
const JWKS_URL = process.env.GS_PREVIEW_IDENTITY_JWKS_URL;
const jwks = JWKS_URL ? createRemoteJWKSet(new URL(JWKS_URL)) : null;
export async function previewIdentity(request) {
  const token = request.headers.get("x-ghosty-identity");
  if (!jwks || !token) return null;
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: process.env.GS_PREVIEW_IDENTITY_ISSUER, audience: process.env.PREVIEW_HOST, algorithms: ["EdDSA"] });
    return { id: payload.sub, email: payload.email, name: payload.name ?? null, role: payload.role };
  } catch {
    return null;
  }
}
```
En el loader de sesión: sin sesión y con `previewIdentity(request)` → busca o crea al usuario por `email` y crea la
sesión. `ghosty-dev doctor` sugiere adoptarlo si la app tiene login. «Probado en la preview del PR #N» sólo vale en la
evidencia si #N contiene el mismo commit (`evidence` y la puerta lo verifican).

Un solo escritor por pendiente. Lo que la persona pida y lo que descubras va a un pendiente nuevo
(`ghosty-dev add "título" --goal … --criteria …`), y si te bloquea: `ghosty-dev block <n> --by <m>`. La persona (el Clerk) lee la evidencia y
decide el merge. Los identificadores van siempre en inglés (variables, funciones, llaves, archivos); en
español sólo comentarios, mensajes y nombres de pruebas. Especificación: `SPEC.md` del paquete ghosty-dev.
<!-- /ghosty-dev:agents -->
