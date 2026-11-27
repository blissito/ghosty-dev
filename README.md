# ghosty-dev

**No necesitas una fábrica: necesitas una bitácora que no se pierda y evidencia que no mienta.**


## Repos privados sin GitHub Actions (0.12.0)

En un repo **privado** ghosty-dev no usa GitHub Actions (si GitHub deja de arrancar jobs, nada se apaga):

- `init` no escribe `evidence-gate.yml` ni `ghosty-checks.yml` (sí `.ghosty/`, skill, AGENTS.md y config) y dice por qué; `doctor` avisa si un privado todavía los tiene.
- La puerta `ghosty-dev/evidencia` la evalúa y publica Ghosty Studio (mismo nombre: `protect` sigue exigiéndola). `evidence`, `review` y `confirm` se la piden a gs; `ghosty-dev gate [<pr>]` la evalúa a pedido.
- La CI corre en la caja de la vista previa con los comandos de `ci:` en `.ghosty/dev.md`.
- El deploy sale de `ghosty-dev deploy [<pr>]`: en la rama base limpia hace `git pull --ff-only`, corre `deploy:`, espera a que `deploy_check:` dé 200 (~3 min) y lo anota en el pendiente (`<!-- ghosty-dev:deploy ok|fail sha=… -->`, que gs lee). `merge` lo corre solo tras el merge (`--no-deploy` lo salta); `next` y `show --pr` lo sugieren si un merge no tiene deploy.

```yaml
# .ghosty/dev.md
---
deploy: ./scripts/deploy-fly.sh
deploy_check: https://formmy.app/
ci:
  - npm test
  - npm run typecheck
---
```

Los repos públicos siguen igual.

## Todo pasa por el CLI, aunque empieces fuera (0.11.0)

- `ghosty-dev pr [<n>]`: sube la rama actual y abre su PR con «Closes #n», o liga el que ya tenía, y te asigna el pendiente. Sirve también con una rama hecha a mano.
- `ghosty-dev note <n> "texto"`: avance sin código (infra, DNS, una decisión) en la bitácora del pendiente.
- `claim --pr` y `pr` mandan el latido a Ghosty Studio, así que el tablero ya muestra el trabajo como tuyo; `show` reconoce la rama del PR adoptado.
- La skill se instala también en `~/.claude/skills/ghosty-dev/`, así la ve cualquier sesión de Claude aunque esté abierta en otro repo; `doctor` revisa que esté al día.
- `next` sugiere `ghosty-dev pr`, ya no `gh pr create`.

## Cómo se usa (3 pasos)

1. **Le dices a tu agente qué hay que hacer.** Él lo apunta como pendientes (issues de GitHub).
2. **Le dices «toma el siguiente pendiente».** Lo hace, abre el PR, espera las pruebas, **otro agente con
   contexto limpio lo revisa** y deja la evidencia en el issue.
3. **Tú lees la evidencia y la revisión, y das merge.** Sin las dos, GitHub no te deja.

Sólo necesitas Claude Code (o Codex) y GitHub. Todo lo demás lo hace el agente.

## Las tres leyes

ghosty-dev es una forma de trabajar con agentes de código (Claude Code, Codex…) sobre GitHub Issues:

1. **El trabajo vive en la bitácora, no en la sesión.** Cada tarea es un *pendiente* (un issue). La sesión del
   agente se tira; el pendiente no.
2. **Se revisa la evidencia, no el código.** Un pendiente se cierra con un comentario de evidencia (qué se hizo,
   comandos y su salida, CI) y una revisión de otro agente que no vio cómo se escribió, atada al commit exacto.
   Sin las dos, el check `ghosty-dev/evidencia` no deja mergear.
3. **Se espera por evento, no se sondea.** El agente espera al CI con una sola llamada que no gasta tokens; si
   tarda, toma otro pendiente.

## Por qué no es una fábrica

Una fábrica pone agentes en línea con roles fijos (planea → construye → revisa) que se pasan la estafeta. Aquí no
hay línea: **un solo escritor por pendiente**, **un revisor con contexto limpio** que intenta romperlo (quien
escribe se califica de más), paralelo sólo entre pendientes independientes (cada uno en su worktree), y una
persona —el **Clerk**— que lee la evidencia y decide el corte. Las piezas son de Beads, Symphony,
Cognition y Anthropic, y están citadas en [SPEC.md](SPEC.md#2-qué-copiamos-y-de-quién).

## Instalar

No lo instalas tú: se lo pides a tu agente (Claude Code, Codex…) dentro de tu repo.

> Instala github.com/blissito/ghosty-dev aquí

El agente lee [INSTALL.md](INSTALL.md) y hace los pasos él solo. Te pregunta antes de hacer push.

**Si eres un agente:** sigue [INSTALL.md](INSTALL.md).

**Instalar y actualizar (una sola forma; no está en el registro de npm, `npm i -g ghosty-dev@latest` da 404):** `npm install -g github:blissito/ghosty-dev` la primera vez y `ghosty-dev update` después (dice versión vieja → nueva). `ghosty-dev doctor` avisa si hay una nueva.

A mano, con Node 20+ y [`gh`](https://cli.github.com) autenticado:

```sh
npm install -g github:blissito/ghosty-dev
cd ~/tu-repo && ghosty-dev init --dry-run   # repo, rama, etiquetas, archivos y los workflows que dispara el push
ghosty-dev init --yes                  # etiquetas, plantilla, Actions (puerta y revisiones), skill, AGENTS.md y .ghosty/factory.md
git add -A && git commit -m "ghosty-dev" && git push   # directo a main: la puerta corre desde ahí
ghosty-dev protect --dry-run           # qué PR abiertos quedarían bloqueados y por qué
ghosty-dev protect                     # ghosty-dev/evidencia obligatorio en main
```

Sin credenciales de GitHub (una caja de trabajo en la nube): `ghosty-dev init --force --files-only --no-checks` sólo escribe los archivos de la puerta (`--no-checks` omite `.github/workflows/ghosty-checks.yml`, CI extra que `init` marca como «NUEVO workflow» y no es de la puerta) (sin `gh`, etiquetas ni protección); se sube como PR y la persona corre después `init` y `protect`.

`protect` usa tu propio `gh`: hace falta ser admin del repo (en repos privados, GitHub lo pide con plan de pago).

## Demo en 1 minuto

```sh
ghosty-dev add "Agregar /health" --goal "GET /health responde 200" --criteria "hay un test"
ghosty-dev ready                         # #1  listo  Agregar /health
ghosty-dev claim 1                       # rama ghosty-dev/1-agregar-health en ../tu-repo-1
# … el agente trabaja en ../tu-repo-1, abre el PR con «Closes #1» …
ghosty-dev wait 1 --watch                # espera al CI en una sola llamada, sin sondear (tope 5 min)
ghosty-dev show 1                        # ficha y servicios del PR: vista previa, revisión, smoke y CI
ghosty-dev preview --wait --json         # la liga de la vista previa del PR de tu rama, cuando queda lista
ghosty-dev box logs                      # si falló: el log de su caja; box exec -- <cmd> corre ahí
# el subagente ghosty-dev-revisor (contexto limpio) intenta romperlo y publica:
ghosty-dev review 1 --file revision.md   # atada al commit del PR; con hallazgos, se arregla y se repite
ghosty-dev evidence 1 --file evidencia.md
# el check ghosty-dev/evidencia pasa; el Clerk lee la evidencia y mergea
```

Al agente se le dice una sola cosa: «toma el siguiente pendiente». La skill (`.claude/skills/ghosty-dev/`) y
`AGENTS.md` le explican el resto.

## Revisiones de Ghosty (workflow reutilizable)

`init` también deja `.github/workflows/ghosty-checks.yml`, que llama a
[`checks.yml`](.github/workflows/checks.yml) de este repo. Todo es OSS y gratis, y cada job dice «no aplica» si tu
repo no lo necesita:

| Job | Qué revisa | ¿Bloquea? |
|---|---|---|
| `deps` | Paquetes nuevos (npm/PyPI): que existan, edad, descargas, typosquat, scripts al instalar; y CVE nuevas con OSV-Scanner | Sí: paquete inexistente o CVE HIGH/CRITICAL nueva |
| `sast` | Semgrep CE `p/default`, sólo lo que introduce el PR (`--baseline-commit`) | Sí, en hallazgos ERROR |
| `migrations` | squawk sobre el SQL nuevo de migraciones (Postgres) | Sí |
| `api-contract` | oasdiff `breaking` entre el `openapi.*` de la base y el del PR | Sí |
| `bundle` | Build de base contra PR y tamaño de la carpeta de salida | No: aviso si crece más de 20 % |
| `coverage` | Cobertura de las líneas cambiadas con diff-cover (sólo si el repo ya genera lcov) | No |

```yaml
jobs:
  ghosty-checks:
    uses: blissito/ghosty-dev/.github/workflows/checks.yml@v1
    with:
      runs-on: '"ubuntu-latest"'   # privado con caja de CI de Ghosty: '["self-hosted","ws-<espacio>"]'
```

Las actions van fijadas por SHA y los binarios por versión con su sha256. Funciona igual desde repos privados.

## Comandos

`next` · `init [--yes]` · `protect [--dry-run]` · `claim --pr <m> --issue <n>` · `pr [<n>] [--draft]` · `note <n> "texto"` · `add "título" --goal … --criteria … [--repo owner/repo]` · `criteria <n> [--set <i> "texto" --reason "…"]` · `confirm <n> --criterion <i> [--note "…"] [--image a.png]` · `ready [--json] [--claim]` · `claim <n|owner/repo#n>` · `wait <n> [--watch]` · `review <n> [--file f.md]` · `evidence <n> --file f.md` · `board` · `block <n> --by <m>` ·
> La puerta del repo sólo bloquea `claim` si falta o es anterior a 0.9.38; si únicamente difiere de tu versión, `doctor` avisa (`init --force --no-checks --files-only`).

`show <n>` · `show --pr <m>` · `preview [<pr>] [--wait] [--open]` · `doctor [--pr <m>]` · `check-lock` · `preview share|unshare|requests [<pr>]` · `preview accept|reject <id> --pr <m>` · `box logs|exec|restart|rebuild [<pr>]` · `wait --pr <m> --until preview|ci|review|any` · `deps [<pr>]` · `close <n> [--duplicate-of <m>]` · `merge [<pr>] [--wait] [--no-deploy]` · `deploy [<pr>]` · `gate [<pr>]` · `unblock <n> [--by <m>]` · `login` · `whoami` · `logout` · `env ls [--pr <m>]` · `env push <archivo>` · `labels [--fix]`.

Con el repo conectado a [Ghosty Studio](https://www.ghosty.studio), todo PR no borrador recibe solo su vista previa,
la revisión de Ghosty Review, el smoke y la ficha, lo escriba quien lo escriba. `wait --watch` avisa cuando la vista
previa y la revisión terminan (el CI decide el verde) y `show <n>` imprime su estado en «Servicios del PR», con la liga
de la vista previa. Los checks de la plataforma que no cuentan como CI están en [SPEC.md §5c](SPEC.md).

Para un PR escrito desde la terminal no hace falta ningún run: push → `ghosty-dev preview --wait --json` → prueba la app en `url` → evidencia.
Si falla: `box logs` (el log del build y del servidor) y `box exec -- <comando>` en la caja, arregla y push; `wait --pr <m>` espera vista previa, CI o revisión sin pendiente.
`preview` sale 0 lista, 75 armándose y 1 si falló; `show --pr <m>` da estado, ficha, servicios y `preview: {phase, sha}`.
La liga lleva la llave de la vista previa: no la pegues en issues ni PRs ([SECURITY.md](SECURITY.md)).

En la nube (opcional, con una cuenta de [Ghosty Studio](https://www.ghosty.studio) y `ghosty-dev login`; no hace falta otro CLI): `claim <n> --cloud` · `claim --cloud --pr <m>` · `cloud` · `tell <n> "mensaje"` · `wake <n>` · `sleep <n>` · `stop <n>` · `teleport <n>`. `cloud` da el tablero del repo con el «Sigue: … · le toca a …» de cada pendiente (la misma línea que la tarjeta web) y, al final, la fila: qué puede tomar la fábrica y, si nada, por qué y el comando que lo destraba. `tell` sobre un pendiente dormido lo despierta primero. Para soltar un claim local que ya no vas a trabajar: `unclaim <n> [--reason "…"]` (`release` sólo reanuda un run de la nube que esperaba otro PR). Un agente construye el pendiente en una caja de trabajo con el mismo contrato y te avisa. Detalle en `ghosty-dev --help` y en [SPEC.md](SPEC.md).

### Sesión de Ghosty Studio y variables de la vista previa

La nube y los secretos de la vista previa (`DATABASE_URL`, llaves de API…) usan una sesión propia de Ghosty Studio,
separada de GitHub (GitHub sigue siendo `gh` y su token nunca sale de tu máquina). Pide `profile repo:env dev files` (`files`: las capturas de `confirm --image`); una
sesión vieja sin alguno se renueva con `ghosty-dev login --force`. Qué se guarda y dónde: [SECURITY.md](SECURITY.md).

```sh
ghosty-dev login                       # navegador (OAuth con PKCE); por SSH, sin terminal o con --device: liga + código
ghosty-dev login --no-wait             # para agentes: liga + código y sale; luego ghosty-dev login --wait (exit 75 = sigue pendiente)
ghosty-dev env ls                      # sólo nombres: guardadas, faltantes, riesgos
ghosty-dev env ls --pr 152             # las que le faltan a ese PR para probarse
ghosty-dev env push .env.preview       # el archivo siempre se nombra; muestra los nombres y pide confirmación
ghosty-dev whoami · ghosty-dev logout  # logout revoca la sesión en Ghosty
```

Si ya hay sesión (o `GHOSTY_DEV_TOKEN`), `login` no inicia otra; `whoami --json` dice de dónde salió (`source`).
Por defecto `env push` fusiona con lo guardado (`--replace` reemplaza todo). Ningún valor se imprime. En CI,
`GHOSTY_DEV_TOKEN` manda sobre la sesión guardada. Detalle normativo en [SPEC.md §8](SPEC.md).

## Tests

```sh
node --test      # sin red: usa un gh falso (testkit/fake-gh.mjs)
```

## Licencia

MIT © Ghosty Studio. En [ghosty.studio](https://ghosty.studio) la bitácora trabaja sin tu compu prendida.

**Entre repos (0.9.42).** Toda referencia acepta `n`, `#n` u `owner/repo#n`; con otro repo el comando corre en su clon local (nunca crea ramas ni worktrees en el repo del directorio), `add --repo owner/repo` abre el pendiente allá con enlace cruzado y `--from`/`--by` entienden `owner/repo#n`. Ver [SPEC.md](SPEC.md).
