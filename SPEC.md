# ghosty-dev · SPEC v0.1

La bitácora es una forma de trabajar con agentes de código **sin fábrica**: sin roles fijos que se pasan la
estafeta. El trabajo vive en GitHub Issues, un solo agente escribe cada pendiente y nada se cierra sin
evidencia. Este documento es la especificación; el CLI `ghosty-dev` es una implementación de referencia.

## 1. Las tres leyes

> **BORRADOR — pendiente de aprobar por bliss.** Texto tomado literal de la ficha de leyes del taller.

1. **Ley de la bitácora. El trabajo vive en la bitácora, no en la sesión.** Una sesión de agente se puede tirar en
   cualquier momento sin perder nada: lo pendiente, lo decidido y lo descubierto quedan escritos donde el
   siguiente (agente o persona) lo encuentra. *Consecuencia:* no hacen falta relevos entre roles; cualquiera retoma.
2. **Ley de la evidencia. Se revisa la evidencia, no el código.** Ningún trabajo se da por hecho con un «ya quedó»:
   se cierra con pruebas que otro puede comprobar sin leer el diff (tests y su salida, CI, preview, recorrido).
   El código se lee sólo donde la evidencia falla o el riesgo es alto. *Consecuencia:* no hace falta una
   estación de revisión que lo lea todo; hace falta un oráculo y un humano (el Clerk) que decide el corte.
3. **Ley del evento. Se espera por evento, no se sondea.** Ningún agente se queda vigilando algo que todavía no
   pasa (CI, preview, una respuesta): termina, y el evento lo despierta. *Consecuencia:* esperar no cuesta tokens.

**Corolario (lo que se quita):** con las tres leyes, la línea de ensamble —roles fijos que se pasan la estafeta—
sobra. Lo que queda es un solo escritor por pendiente y paralelo sólo entre pendientes independientes.

### Por qué (una fuente por ley)
- **Ley 1.** «an agent is not a session… Sessions are ephemeral; they are the "cattle"» — Steve Yegge,
  [Welcome to Gas Town](https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04) (2026-01-01).
- **Ley 2.** El agente entrega «proof of work» (CI, review, video de recorrido) antes de *Merging* — OpenAI,
  [Symphony](https://openai.com/index/open-source-codex-orchestration-symphony/) (2026-04-27).
- **Ley 3.** Un *gate* bloquea el paso «so agents never need to poll or spin» — Beads,
  [gates.md](https://github.com/gastownhall/beads/blob/main/docs/workflows/gates.md).

**Roles humanos:** el **Clerk** (como el *Clerk of the Works* de una obra) lee la evidencia y decide el corte:
mergea, pide otra vuelta o abre un pendiente nuevo. No lee todo el código; lo lee donde la evidencia falla.

## 2. Qué copiamos y de quién

Las piezas son de otros y se citan. Nuestro aporte es la síntesis: las tres leyes. Nada entra al repo si no se
traza a una ley o a una fuente de esta tabla.

| mecanismo | de quién | fuente | en el repo |
|---|---|---|---|
| El trabajo vive en un libro mayor fuera de la sesión; «la sesión es ganado» | Steve Yegge — Beads / Gas Town | [Welcome to Gas Town](https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04), [gastownhall/beads](https://github.com/gastownhall/beads) | el pendiente = issue de GitHub |
| `ready` / `claim`: el agente toma el siguiente trabajo sin bloqueo | Steve Yegge — Beads (`bd ready --claim`) | [gastownhall/beads](https://github.com/gastownhall/beads) | `ghosty-dev ready [--claim]`, `claim`, `show`, `close`, `init` escribe `AGENTS.md` |
| El ticket como unidad de trabajo y «proof of work» antes del merge | OpenAI — Symphony | [post, 2026-04-27](https://openai.com/index/open-source-codex-orchestration-symphony/) | comentario de evidencia, `evidence`, Action `ghosty-dev/evidencia` |
| Un solo escritor; el revisor no comparte contexto con el que escribió | Cognition (Walden Yan) | [Multi-Agents: What's Actually Working](https://cognition.com/blog/multi-agents-working) | un asignado por pendiente, un worktree por pendiente; el subagente `ghosty-dev-revisor` sólo lee pendiente + diff (§4b) |
| El autor se califica de más: el evaluador va separado | Prithvi Rajasekaran — Anthropic | [Harness design for long-running apps](https://www.anthropic.com/engineering/harness-design-long-running-apps) | el agente no se aprueba: revisión de otra sesión atada al commit (`ghosty-dev review`), la puerta la exige y decide el Clerk |
| Un verificador casi perfecto vale más que un orquestador | Nicholas Carlini — Anthropic | [Building a C compiler](https://www.anthropic.com/engineering/building-c-compiler) | «Verificación» exige comandos con su salida; CI rojo no cierra |
| Dependencias entre tareas sin herramienta nueva | GitHub — «blocked by» y sub-issues | [Creating issue dependencies](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies), [REST](https://docs.github.com/en/rest/issues/issue-dependencies), [`gh --blocked-by` (≥2.94)](https://github.blog/changelog/2026-06-10-manage-sub-issues-types-and-dependencies-from-github-cli/) | `ghosty-dev block` (API nativa; respaldo: lista en el cuerpo) |
| El conocimiento en un solo papel se pierde (imagen, no mecanismo) | Karel Čapek — *R.U.R.* (1920) | [Gutenberg 59112](https://gutenberg.org/cache/epub/59112/pg59112-images.html) | — |

`wait` y el estado `esperando` salen de la **Ley 3**.

## 3. El pendiente

Un **pendiente** es un issue abierto de GitHub con exactamente una etiqueta de estado:

| etiqueta | significa |
|---|---|
| `ghosty-dev:por-hacer` | se puede tomar (si no tiene bloqueos abiertos) |
| `ghosty-dev:en-curso` | tiene escritor (el asignado); nadie más lo toca |
| `ghosty-dev:esperando-ci` | su escritor espera un evento (CI); la sesión ya terminó |
| `ghosty-dev:bloqueado` | depende de otro pendiente abierto |

**Cuerpo** (plantilla `.github/ISSUE_TEMPLATE/pendiente.md`):

```markdown
## Objetivo
Qué debe quedar cierto cuando esto se cierre (una meta, no pasos).

## Criterios de aceptación
- [ ] criterio verificable 1
- [ ] criterio verificable 2

## Contexto
Ligas, archivos, decisiones previas.

## Bloqueado por        ← sólo si el repo no tiene dependencias nativas
- #12
```

**Bloqueos:** un pendiente está bloqueado mientras alguno de sus bloqueos («blocked by» nativo de GitHub o la lista
`## Bloqueado por`) siga abierto. Cuando todos cierran, `ready` lo ofrece como `desbloqueado`.

## 4. El comentario de evidencia

Un comentario del issue es **evidencia válida** si:

1. contiene la marca `<!-- ghosty-dev:evidencia v0.1 -->` (la pone `ghosty-dev evidence`);
2. tiene **Qué se hizo** no vacío;
3. tiene **Verificación** con al menos un bloque de código con comandos `$ …` **y** su salida;
4. tiene **CI** con el resultado declarado (✅ / verde / passed) y no en rojo (❌ / rojo / failed);
5. si el pendiente tiene criterios de aceptación, **Criterios de aceptación** los repite con el mismo texto y
   todos marcados `[x]`;
6. **Preview** es opcional (liga, video del recorrido o «no aplica»).

```markdown
<!-- ghosty-dev:evidencia v0.1 -->
## Evidencia del pendiente #12

## Qué se hizo
Agregué el endpoint /health.

## Verificación
    $ npm test
    ok 3 - health responde 200

## CI
✅ passed — https://github.com/<org>/<repo>/actions/runs/<id>

## Preview
no aplica

## Criterios de aceptación
- [x] /health responde 200
```

(En el comentario real, la verificación va en un bloque con tres comillas invertidas.)

## 4b. La revisión (contexto limpio, atada al commit)

Quien escribe se califica de más (Anthropic, *Harness design*); el revisor no comparte contexto con quien escribió
(Cognition, *Multi-Agents: What's Actually Working*). Por eso, antes de la evidencia, **otro agente** revisa el PR:
lee sólo el pendiente y el diff, escribe pruebas que intentan romper el cambio y no arregla código.

Lo publica con `ghosty-dev review <n> --file revision.md`, que lo valida y lo ata al commit exacto del PR:

```markdown
<!-- ghosty-dev:revision v0.1 sha=<head del PR> -->
## Revisión
(bloque con «$ comando» y su salida)
- [x] ataque que el código aguantó
- [ ] ataque que lo rompió — qué pasa (archivo:línea)
Hallazgos abiertos: <número de renglones con [ ]>
```

La puerta exige, por cada `Closes #n`, **una revisión del commit actual con 0 hallazgos abiertos** además de la
evidencia. Un push nuevo invalida la revisión anterior. Con hallazgos, quien escribe agrega al PR las pruebas del
revisor, arregla y pide otra revisión (tope: 3 rondas; luego decide la persona).

**Lo que la puerta NO puede probar.** En local, quien escribe y quien revisa usan la misma cuenta de GitHub: la
puerta no distingue quién publicó la revisión. Sí prueba que existe, que tiene pruebas con su salida, que sus
cuentas cuadran y que es del commit exacto que se va a mergear. Lo demás es disciplina del protocolo: el revisor
es una sesión aparte (el subagente `ghosty-dev-revisor` en Claude Code; en otros agentes, `ghosty-dev review <n>`
pegado en otra sesión), y es mejor si es **otro modelo**.

**Revisor con otra identidad (opcional).** Si el repo tiene `.github/ghosty-dev/config.json` en la rama base con
`{ "reviewCheck": { "name": "…", "app": "…" } }`, la puerta acepta como revisión el check con ese nombre,
publicado por esa GitHub App sobre el commit exacto del PR: `success` pasa; cualquier otra conclusión son
hallazgos abiertos; si sigue corriendo, la puerta espera. Se exigen los dos campos: sin `app`, cualquiera con
permiso de checks podría publicar uno con ese nombre. Mientras ese check no exista, la revisión por comentario
sigue valiendo. Esto sí prueba que quien revisó no es quien escribió.

**Validar sin publicar.** `ghosty-dev evidence --check --file e.md [--issue-file pendiente.md]` y
`ghosty-dev review --check --file r.md` validan el formato sin `gh` ni red, para entornos sin credenciales.

## 5. Protocolo

```
ready → claim → work → PR (Closes #n) → wait ──evento CI──→ ready → evidence → Clerk mergea → cerrado
                  └── descubre trabajo → pendiente nuevo (+ block si lo frena)
```

1. **ready.** El agente pide `ghosty-dev ready --json`: pendientes `listo`/`bloqueado` sin bloqueos abiertos, y los
   `esperando` suyos cuyo CI ya resolvió (`ci-verde`, `ci-rojo`, `sin-pr`).
2. **claim.** `ghosty-dev claim <n>` asigna al agente, pone `tomado` y crea la rama `ghosty-dev/<n>-<slug>` en su propio
   worktree `../<repo>-<n>`. Si ya tiene otro asignado, falla. Si dos se asignan a la vez, el que ve a otro se retira.
3. **work.** Un pendiente por worktree. Lo que descubra va a un pendiente nuevo, no a una nota.
4. **PR.** La descripción lleva `Closes #<n>`.
5. **wait.** `ghosty-dev wait <n> --watch` pone `esperando-ci` y espera al CI con una sola llamada bloqueante (no gasta tokens; tope 5 min). Si el CI tarda más, el agente toma otro pendiente o **termina su sesión**. Nunca sondea.
6. **evidence.** Al volver a salir en `ready`, el agente escribe la evidencia y la publica con
   `ghosty-dev evidence <n> --file evidencia.md`, que la valida antes de publicarla y re-ejecuta la puerta del PR.
7. **close.** El Clerk lee la evidencia y mergea; `Closes #n` cierra el pendiente. Sin PR: `ghosty-dev close <n>`,
   que se niega si no hay evidencia válida.
8. **block.** `ghosty-dev block <n> --by <m>` usa la dependencia nativa de GitHub y, si el repo no la tiene, escribe
   `## Bloqueado por` en el cuerpo. El pendiente queda `bloqueado`.

**La puerta** (`.github/workflows/evidence-gate.yml`, check `ghosty-dev/evidencia`): falla si el PR no cierra ningún
pendiente o si alguno de los que cierra no tiene evidencia válida. Su script se lee de la rama base, para que un PR
no pueda aflojar su propia puerta. Se vuelve obligatoria con *branch protection*.

## 6. Pruebas de conformidad

Una implementación cumple v0.1 si pasa esto (en este repo: `node --test`, con un `gh` falso y sin red):

| # | prueba | test |
|---|---|---|
| C1 | `ready` no ofrece un pendiente con bloqueo abierto, y lo ofrece cuando el bloqueo cierra | `ready ofrece los listos…` |
| C2 | `block` sin API nativa escribe `## Bloqueado por` y el bloqueo se respeta | `block sin API de dependencias…` |
| C3 | `claim` asigna, pone `tomado` y crea rama + worktree | `claim asigna…` |
| C4 | un solo escritor: no se toma lo asignado a otro; en una carrera, uno se retira | `un solo escritor…`, `si dos se asignan…` |
| C5 | `esperando` no se ofrece mientras el CI corre; sí cuando resolvió (sin contar la propia puerta) | `wait deja el pendiente esperando…` |
| C6 | `evidence` rechaza lo inválido sin publicar y publica lo válido con la marca | `evidence rechaza lo inválido…` |
| C7 | `close` se niega sin evidencia válida | `close sin evidencia se niega…` |
| C8 | la evidencia exige comandos con salida, CI en verde y todos los criterios marcados | `evidence.test.mjs` |
| C9 | la puerta falla sin `Closes #n` o con un pendiente sin evidencia | `la puerta encuentra…`, `un PR que no cierra…` |
| C11 | con `reviewCheck`, la puerta acepta el check de esa app sobre el commit exacto y nada más | `revisión por check externo…` |
| C12 | `--check` valida evidencia y revisión sin `gh` y no publica | `evidence --check y review --check…` |
| C10 | `init` instala etiquetas, plantilla, Action, skill y `AGENTS.md` sin pisar lo que existe | `init instala…` |

## 7. Fuera de v0.1

Lo que no está porque no se traza a una ley ni a una fuente de la tabla: roles fijos, máquina de estados con
transiciones obligatorias, prioridades, épicas, memoria del proyecto, enjambres. Lo que en tu compu no se puede
(correr sin la laptop prendida, preview que bloquea el merge, CI aislado, varios agentes a la vez) es la nube de
Ghosty, no este repo.
