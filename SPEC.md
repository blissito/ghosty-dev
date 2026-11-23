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

## Flujo principal probado con sesión
no aplica: es un endpoint de salud sin interfaz ni login

## Criterios de aceptación
- [x] /health responde 200
```

«Flujo principal probado con sesión» es obligatorio (Formmy, filas 44 y 46): qué función principal se usó logueado
en la vista previa y cómo, con una captura (imagen o video) o un bloque `$ …` con su salida; «no aplica: <motivo>»
sólo con motivo. Va también en la plantilla del pendiente y en la del PR (`init` la instala).

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

0. **next.** `ghosty-dev next` (o `status`) reconstruye desde la bitácora el siguiente paso correcto con su comando
   (ligar, tomar, esperar CI, revisión, evidencia, listo): el camino sobrevive a la compactación de la sesión.
1. **ready.** El agente pide `ghosty-dev ready --json`: pendientes `listo`/`bloqueado` sin bloqueos abiertos, y los
   `esperando` suyos cuyo CI ya resolvió (`ci-verde`, `ci-rojo`, `sin-pr`).
2. **claim.** `ghosty-dev claim <n>` asigna al agente, pone `tomado` y crea la rama `ghosty-dev/<n>-<slug>` en su propio
   worktree `../<repo>-<n>`. Si ya tiene otro asignado, falla. Si dos se asignan a la vez, el que ve a otro se retira.
3. **work.** Un pendiente por worktree. Lo que descubra va a un pendiente nuevo, no a una nota.
4. **PR.** La descripción lleva `Closes #<n>`. Si el PR va apilado (su base es la rama de otro PR abierto) o trae el
   commit de otro PR sin mezclar, ghosty-dev escribe solo `Depende de #N` (con la marca `<!-- ghosty-dev:depende -->`;
   `preview`, `wait` y `deps [<pr>]` lo hacen) sin duplicar lo que ya diga el cuerpo, y la quita cuando ese PR entra.
5. **wait.** `ghosty-dev wait <n> --watch` pone `esperando-ci` y espera al CI con una sola llamada bloqueante (no gasta tokens; tope 5 min). Si el CI tarda más, el agente toma otro pendiente o **termina su sesión**. Nunca sondea.
6. **evidence.** Al volver a salir en `ready`, el agente escribe la evidencia y la publica con
   `ghosty-dev evidence <n> --file evidencia.md`, que la valida antes de publicarla y re-ejecuta la puerta del PR.
7. **close.** El Clerk lee la evidencia y mergea (o le pide al agente `ghosty-dev merge <m>`: sólo con todos los
   checks del commit de cabeza resueltos en verde o neutral, la puerta en verde, sin borrador ni conflicto; luego
   espera el deploy de producción, el workflow que corre con push a la rama base); `Closes #n` cierra el pendiente. Sin PR: `ghosty-dev close <n>`,
   que se niega si no hay evidencia válida.
8. **pedidos.** Lo que la persona le pide al escritor vive en la bitácora: un comentario del issue o del PR que
   menciona a `@ghosty` o lleva la marca `<!-- ghosty-dev:pedido -->` (así publica Ghosty Studio lo que se escribe
   en su web, iOS o Teams). Es un evento (Ley 3): `ready` vuelve a ofrecer el pendiente a su escritor con
   `reason: pedido`, `wait --watch` despierta con él antes que con el CI, y `asks <n>` lo lee y lo marca leído
   (lo leído se guarda en el clon, `.git/ghosty-dev/`). La evidencia y la revisión nunca cuentan como pedido.
9. **block.** `ghosty-dev block <n> --by <m>` usa la dependencia nativa de GitHub y, si el repo no la tiene, escribe
   `## Bloqueado por` en el cuerpo. En los dos casos el pendiente queda con la etiqueta `bloqueado` (GitHub y el
   tablero dicen lo mismo). Para Ghosty Studio la fuente es la dependencia NATIVA (`GET …/dependencies/blocked_by`):
   «Bloqueado por #m · título» mientras #m siga abierto; al cerrarse, la etiqueta sola ya no bloquea.
   `block <n> --reason "…" [--person]` pone la etiqueta `ghosty-dev:bloqueado` y un comentario
   `<!-- ghosty-dev:bloqueo -->\n**Bloqueado[ (te necesita)]:** <motivo>` en el issue y su PR. Ghosty Studio lo lee del
   último comentario con marca: **bloqueado gana sobre «Escribiendo» y sobre el estado del PR** (la tarjeta se queda en
   su columna con el chip «Bloqueado: <motivo>» o «Bloqueado por #n»); si el motivo pide a la persona (`--person`, o
   credencial/acceso/decisión en el texto) dice «Te necesita» y le manda push una vez por motivo. Bloquear no es
   columna. `unblock <n>` quita la etiqueta (vuelve a `tomado` con PR o asignado; si no, a `listo`) y deja
   `<!-- ghosty-dev:desbloqueo -->`, que anula el bloqueo anterior.

**La puerta** (`.github/workflows/evidence-gate.yml`, check `ghosty-dev/evidencia`): falla si el PR no cierra ningún
pendiente o si alguno de los que cierra no tiene evidencia válida. Su script se lee de la rama base, para que un PR
no pueda aflojar su propia puerta. Se vuelve obligatoria con *branch protection*. **Validar al cerrar, no mientras se
itera:** en un PR borrador la puerta sale en verde con «Borrador: la evidencia se exige al marcarlo listo» y vuelve a
correr con `ready_for_review`. **Falla cerrada:** si la rama base todavía no trae el script (repo sin ghosty-dev
instalado), pasa con aviso (`::notice`); si el script existe pero no carga o truena, sale en **rojo** con el error
limpio y el remedio («arregla `.github/ghosty-dev/gate.mjs` en <base>; una persona puede mezclar a mano el PR que lo
arregla»). Una puerta rota nunca deja pasar.

**Lo que ya existe se adopta, no se rehace.** El PR de un pendiente es el de su rama `ghosty-dev/<n>-…` o cualquier PR
abierto que lo cierre (`Closes #n`). `claim --pr <m> --issue <n>` adopta un PR abierto a mano (asigna, pone `tomado`,
agrega `Closes #n` si falta; sin rama ni worktree nuevos); `review <n> --pr <m>` y `evidence <n> --pr <m>` lo nombran.
Un PR sin `Closes #n` (fuera de la bitácora) **bloquea** (falla cerrada) con el comando exacto que lo liga
(`ghosty-dev claim --pr <m> --issue <n>` o agregar «Closes #n»); `ready` y `show` también lo avisan. Sólo con
`"unlinked": "warn"` en `.github/ghosty-dev/config.json` de la base pasa con aviso (`::warning`). Una rama fuera del
patrón `ghosty-dev/<n>-…` que sí cierra un pendiente es sólo informativa: la puerta juzga el pendiente igual.

**Publicar evidencia re-dispara la puerta.** `evidence` (y `review --file`) re-corren el último run de la puerta del
commit HEAD del PR. Para lo que se publique por otro lado, el workflow escucha `issue_comment` (`created`, `edited`):
el job `ghosty-dev/redisparo` (otro nombre: no es la puerta) sólo actúa si el comentario lleva la marca de evidencia o
de revisión, busca los PR abiertos que cierran ese issue (o el PR mismo) y re-corre el run de la puerta de su commit
si ya terminó (si sigue corriendo, lee los comentarios en vivo). Un run de `issue_comment` no cuelga del commit del
PR: por eso re-corre el de `pull_request` en vez de juzgar él.

**Instalar sin sorpresas** (un repo de producción). `init` imprime el repo remoto y la rama antes de escribir y, fuera
de la rama principal, no escribe sin `--yes`. Las etiquetas se crean en GitHub en el acto: se confirman (o `--yes`);
sin terminal y sin `--yes` no se crean y se dice. El plan termina con los workflows que dispara un push a la rama
principal (`.github/workflows` que escuchan `push` a esa rama: suele ser el deploy). `protect --dry-run` lista los PR
abiertos que quedarían bloqueados al volver obligatorio el check, y por qué (los borradores, aparte), sin escribir.

## 5b. La nube (opcional)

El mismo pendiente lo puede construir un agente en una caja de trabajo en vez de tu compu. El contrato no cambia:
issue, rama `ghosty-dev/<n>-…`, PR con `Closes #n`, evidencia, revisión atada al commit y la misma puerta.

- **Antes de gastar:** `claim <n> --cloud` (y `--pr`) sin `--yes` dice qué va ya en la nube del repo y lo que pasaría
  al mandarlo ahora, sin hacerlo: `GET /api/v2/me/dev-runs/capacity?repo=o/r[&workspace=slug]` → `{repo, owner,
  slots, used, fits, evicts:[{repo, pr}], queued, estimate:{minutes, tokens, basedOn}|null, buyUrl}`. Lo imprime como
  «Ocupa 1 de N cajas · desaloja la preview del #M / queda en fila · suele tardar ~X min y ~T tokens» y, si no cabe,
  «Comprar más cajas: <buyUrl>». Con terminal pregunta; sin terminal sale con **75** y el comando exacto con
  `--yes`. Con el repo en varios espacios, gs responde 409 `choose_workspace` y el CLI pide `--workspace <slug>` con
  las opciones (el mismo `--workspace` va al mandarlo). Si la ruta no responde, lo dice sin inventar números.
- `claim <n> --cloud` entrega el pendiente a la nube; `cloud` lista los del repo; `stop <n>` lo detiene;
  `teleport <n>` lo detiene y trae su rama para seguir en tu compu (un solo escritor: nunca los dos a la vez).
- La nube trabaja sobre lo que está en GitHub, nunca sobre cambios locales sin subir.
- La caja no guarda credenciales de GitHub: lo que se sube sale con la cuenta de quien pidió.
- Cero checks no es verde: si el repo tiene CI, se espera a que corra sobre el commit exacto.
- La revisión la hace otra identidad (un check atado al commit, ver `reviewCheck` en §4b). Máximo 3 vueltas;
  después pregunta a la persona.
- Sólo se mezcla solo si la rama exige `ghosty-dev/evidencia`; si no, la persona mezcla.
- **La ficha del pendiente** (la mesa de trabajo): la plataforma la publica como UN comentario fijo en el PR y el
  issue, marcado `<!-- ghosty-dev:ficha -->` y editado en su lugar (estado, vista previa, CI, revisión, smoke,
  commit, rama, PR y pedidos abiertos). Es una proyección: no se edita a mano. La vista previa además sale como
  Deployment de GitHub del commit («View deployment»). `show <n>` la imprime, así un agente local ve lo mismo.

La implementación de referencia es Ghosty Studio. Este CLI habla directo con su API (`/api/v2/me/dev-runs`) con su
propia sesión (§8, permiso `dev`); **no requiere el CLI `ghosty`**. `claim --cloud --pr <m>` adopta un PR que escribe
tu terminal: gs responde los servicios del PR sin id (no crea pendiente). Todo dato del servidor se valida antes de
usarlo en una URL o en git (una rama con forma de opción se descarta) y se limpia antes de imprimirlo.

## 5c. Servicios del PR

Los servicios cuelgan del PR, no del agente que escribe: en un repo conectado a la plataforma, todo PR no borrador
recibe por webhook la vista previa, la revisión, el smoke y la ficha, lo abra un agente de la nube o uno en
terminal. Un agente de terminal se entera de todo con este CLI, sin otro. La plataforma publica, sobre el commit HEAD
del PR:

| Servicio | Dónde | Cuenta como CI |
|---|---|---|
| Vista previa | check run `Ghosty · Preview` + Deployment del commit (`environment_url` = la liga) | no |
| Revisión | check run `Ghosty Review`; los hallazgos, como comentarios en línea del PR | no |
| Smoke contra la vista previa | check run `Ghosty · Smoke` | **sí** |
| Revisiones del push | check run `Ghosty · Revisiones del push` | no |
| Ficha | comentario fijo `<!-- ghosty-dev:ficha -->` en el PR (y en el issue) | — |

**Lista normativa de checks que NO son CI** (`NOT_CI_CHECKS` en `src/commands.mjs`, la misma que usa la
plataforma): `Ghosty Review`, `ghosty-dev/evidencia`, `Ghosty · Preview`, `Ghosty · Revisiones del push`. Además,
nada que empiece con `ghosty-dev` cuenta. Todo lo demás (Actions, statuses, `Ghosty · Smoke`) es CI: cero checks
de CI no es verde, uno en curso es pendiente y uno fallido es rojo.

- `show <n>` imprime la ficha del PR (si no hay, la del issue) y una sección «Servicios del PR» con la vista previa
  (y la liga de su Deployment), la revisión (y cuántos comentarios en línea dejó un bot sobre ese commit), el smoke
  y el CI. Con varios checks del mismo nombre manda el más reciente.
- `wait <n> --watch` reporta en stderr cuando la vista previa o la revisión del commit actual terminan (lista,
  falló, neutral con su título, p. ej. los hallazgos), sin esperarlas: el veredicto verde/rojo es del CI. Al volver,
  `services` trae su estado. También el smoke y la puerta de evidencia (`ghosty-dev/evidencia`).
- **En vivo** (`wait --watch` y `wait --pr`): con sesión de Ghosty Studio escuchan `/api/v2/me/dev-runs/live` (el
  aviso del webhook de GitHub que mueve el tablero) y releen en segundos en vez de esperar al siguiente sondeo; sin
  sesión o con `GHOSTY_DEV_NO_LIVE=1`, sólo el sondeo. Cada renglón de `wait --pr` cierra con `falta: …` (vista
  previa, CI, revisión, smoke, evidencia en <sha>) o `no falta nada: listo para merge`.
- `show --pr <m>` hace lo mismo por número de PR, para un PR sin pendiente (escrito desde la terminal, en cualquier
  rama): estado, rama, `Closes #n`, ficha, servicios y CI. Nada de esto depende de un run de la nube.
- **`preview [<pr>] [--wait] [--open] [--json]`** pregunta a la plataforma por la vista previa del PR (sin número: el
  PR abierto de la rama actual, por REST) con `GET /api/v2/me/repos/:owner/:name/prs/:pr/preview` → `{repo, pr,
  phase, sha, url, page, error}`, `phase` ∈ `none|queued|building|ready|failed`. `url` sólo llega con `ready` y es
  una **liga firmada que lleva la llave de la vista previa**: es el resultado del comando y sólo sale por stdout;
  nunca en stderr, en errores ni en `show` (que da `preview: {phase, sha}`). `--wait` sondea con backoff (3 s → 30 s,
  tope ~10 min) hasta `ready` o `failed` **del commit HEAD del PR en GitHub**: una vista previa terminada de un
  commit viejo no cuenta. Si la vista previa es de otro commit, o el HEAD local no está empujado, lo avisa en stderr
  (`stale: true` en `--json`). Sale **0** lista, **75** todavía armándose (sin `--wait`, o al tope), **1** falló
  (con `error` limpio y recortado a 300).
- **`box logs|exec|restart|rebuild [<pr>]`** opera la caja de la vista previa del PR (sin número: el de tu rama)
  con `GET|POST /api/v2/me/repos/:owner/:name/prs/:pr/box`, sin un tercer agente: `logs [--lines N]` (cola del log
  del build y del servidor, 200 por defecto, tope 5000), `exec -- <comando…>` (en el checkout `/app/src`, 60 s; varios
  argumentos se unen en una línea de shell con comillas simples donde haga falta; **sale con el código del
  comando**), `restart` (la app, sin rearmar) y `rebuild` (rearma el último commit; se sigue con `preview --wait`).
  Devuelve `{phase, sha, text, exitCode}`. 404 = el PR todavía no tiene caja; 403 = sin asiento en el espacio (sólo
  dueño o miembro escribe). La salida de la caja llega sin secuencias de control, sin `?k=…` ni `Bearer …`.
- **`wait --pr <m> [--until preview|ci|review|any] [--minutes 10]`** espera por PR, sin pendiente ni run: sondea con
  backoff (3 s → 30 s) el commit HEAD del PR hasta que la vista previa (de la plataforma con sesión; sin sesión, de
  su check) quede lista o falle, el CI resuelva o la revisión termine; `any` (por defecto) regresa con el primer
  cambio. Un renglón por cambio (con `--json`, `{event:"state",…}` y al final `{event:"done", met, timedOut,
  exitCode}`), nunca la liga. Sale 0 cumplido, 1 vista previa fallida o CI rojo, 75 se acabó el tiempo.
- **Flujo del agente de terminal:** push → `ghosty-dev preview --wait --json` → prueba la app en `url` → evidencia; si falla: `ghosty-dev box logs` / `ghosty-dev box exec -- <comando>` → arregla → push. `preview` acepta la sesión con
  `dev` o `repo:env`; 403 `insufficient_scope` → `ghosty-dev login --force`.

## 5c-ter. Rama base, PR contra pendiente y avisos obsoletos (Formmy, filas 34–36)

- `claim <n> [--base <rama>]`: la rama `ghosty-dev/<n>-…` parte de `origin/<rama principal>` (tras `git fetch`) o de
  `--base`, nunca de la rama donde está el clon; si el clon está en otra, avisa antes por stderr.
- `show <m>` con m un PR (el endpoint de issues también los devuelve) lo muestra como PR, `kind: "pr"`, con el
  pendiente que cierra; con un issue, `kind: "issue"` y su PR ligado.
- Un aviso del **bot** (`user.type: Bot`) es obsoleto si nombra un commit que no es la cabeza del PR, un check que la
  cabeza ya no tiene, es anterior al commit de la cabeza, o su PR ya está cerrado. `asks` lo lista aparte como
  `stale` (con la razón) y lo marca leído; `next`, `ready` y `wait` nunca lo proponen. Un pedido de una persona
  nunca es obsoleto.

## 5c-quater. El lock antes de subir

Sin red ni instalar nada se comparan las dependencias de package.json con las del lock **en HEAD** (lo que se va a
subir): `package-lock.json` v2/v3 (`packages[""]` y cada workspace), `pnpm-lock.yaml` (`importers["."]…specifier` o
`specifiers` en v5) o `yarn.lock` (`nombre@rango` o `nombre@npm:rango`). Si no coincide: «<lock> no coincide con
package.json (…): corre `npm install` (o pnpm/yarn) y súbelo». Lo corren `check-lock` (el hook `pre-push` que instala
`init` en `.git/hooks` o `core.hooksPath`; sin ghosty-dev en el PATH no bloquea; `git push --no-verify` lo salta),
`evidence` (se niega), `ready` (avisa) y `next` (paso `lock`, después de los pedidos).

## 5e. OAuth en previews y `doctor`

gs inyecta en cada preview `GS_PREVIEW_OAUTH_REDIRECT_URI` y `GS_PREVIEW_OAUTH_STATE_KEY` (y `PREVIEW_URL`,
`PREVIEW_HOST`): implícitas, `env ls` no las lista y nadie las exige. El proveedor regresa a
`https://www.ghosty.studio/preview-oauth/callback` (lo registra el dueño una vez) y gs reenvía (302) a la ruta de la
app que va firmada en el `state` (`previewOAuthState(state, '/ruta')`, snippet de gs; Shopify: `previewOAuthUnwrap`).
Al canjear el code, el mismo `redirect_uri`.

`ghosty-dev doctor [--pr <m>] [--json]` no tiene catálogo propio: baja `GET /api/v2/preview-oauth/providers`
(público) y detecta igual que la caja. Por proveedor: llaves que le faltan a la preview; «Para entrar con <X> en tus
vistas previas falta un paso único: registrar esta URL en tu proyecto de <X>» con la URL sola en su renglón (para
copiar; `copy` en `--json`), la consola y los 3 pasos, y «o pídeselo a Ghosty con ghosty-browser»; y si el código no
usa `GS_PREVIEW_OAUTH_REDIRECT_URI`. Si el PR de la rama tiene preview, manda su `oauth` (`registered`: ya volvió un
login por el proxy). Sale 1 si algo está MAL (lock, llaves, callback); el registro pendiente sólo avisa.

## 5c-bis. Conflicto con la base

Un PR en conflicto no se mezcla aunque CI, revisión y evidencia estén verdes, así que es lo primero que se dice
(Formmy, fila 33). `next`/`status`, `show --pr` y `ready` leen `mergeable`/`mergeable_state` del PR (GitHub lo calcula
en segundo plano: si llega `null` se reintenta) y, si está en conflicto, dan el comando exacto
(`git fetch origin && git switch <rama> && git merge origin/<base>` → resolver, `git add`, `git commit`, `git push`) y
los archivos cuando ya están los dos commits en local (`git merge-tree`). La puerta, antes de cargar su script, hace
la misma pregunta y falla con esa causa y ese comando (en borrador sólo avisa).

**Anotaciones:** cada causa que falla (falta revisión, hallazgos abiertos, falta evidencia, PR sin pendiente,
conflicto, script que no carga) sale también como `::error title=evidencia::<causa con su comando>`, una por causa y
la principal primero; quien muestre la puerta (gs) las lee por `GET /check-runs/{id}/annotations`. El `output.title`
del check de un job de Actions lo pone GitHub y un paso no lo puede cambiar: la causa principal es la primera anotación.

## 5d. Compartir la vista previa con alguien sin cuenta

- **`preview share [<pr>]`** → `POST /api/v2/me/repos/:owner/:name/prs/:pr/share` (idempotente) → `{repo, pr, shared,
  url, createdAt, lastUsedAt}`. La liga pública (`https://www.ghosty.studio/pv/<token>`) sólo la imprime este
  comando, por stdout; 409 si el PR está cerrado.
- **`preview unshare [<pr>]`** → `DELETE …/share`: la liga vieja da 410 y quien la abra puede pedir acceso. No
  imprime ninguna liga.
- **`preview requests [<pr>] [--status pending|accepted|rejected|all]`** → `GET …/access-requests?status=` →
  `{requests:[{id, email, name, status, createdAt, resolvedAt}]}` (nombre y correo limpios de controles).
- **`preview accept|reject <id> [--pr <m>]`** → `POST …/access-requests` `{id, decision}`; un id que no tiene forma de
  id no llama al servidor. Sin número de PR: el de la rama actual. Sesión con `dev`; nunca un `gat_`.

## 6. Pruebas de conformidad

Una implementación cumple v0.1 si pasa esto (en este repo: `node --test`, con un `gh` falso y sin red):

| # | prueba | test |
|---|---|---|
| C1 | `ready` no ofrece un pendiente con bloqueo abierto, y lo ofrece cuando el bloqueo cierra | `ready ofrece los listos…` |
| C2 | `block` sin API nativa escribe `## Bloqueado por` y el bloqueo se respeta | `block sin API de dependencias…` |
| C3 | `claim` asigna, pone `tomado` y crea rama + worktree | `claim asigna…` |
| C4 | un solo escritor: no se toma lo asignado a otro; en una carrera, uno se retira | `un solo escritor…`, `si dos se asignan…` |
| C5 | `esperando` no se ofrece mientras el CI corre; sí cuando resolvió (sin contar los checks de la plataforma, §5c) | `wait deja el pendiente esperando…` |
| C6 | `evidence` rechaza lo inválido sin publicar y publica lo válido con la marca | `evidence rechaza lo inválido…` |
| C7 | `close` se niega sin evidencia válida | `close sin evidencia se niega…` |
| C8 | la evidencia exige comandos con salida, CI en verde y todos los criterios marcados | `evidence.test.mjs` |
| C9 | la puerta falla con un pendiente sin evidencia y con un PR sin `Closes #n` (con el comando que lo liga; `"unlinked": "warn"` lo deja pasar con aviso); una rama fuera del patrón es sólo informativa | `la puerta encuentra…`, `un PR que no cierra…` |
| C11 | con `reviewCheck`, la puerta acepta el check de esa app sobre el commit exacto y nada más | `revisión por check externo…` |
| C12 | `--check` valida evidencia y revisión sin `gh` y no publica | `evidence --check y review --check…` |
| C13 | `claim --cloud` va por la API con la sesión de ghosty-dev sin tocar etiquetas, asignación ni worktree; `stop` y `teleport` sólo sobre lo que va en la nube; `--pr` sin id no inventa pendiente; 403 `insufficient_scope` pide `login --force`; base sin https, redirección a otro host y sesión de otro servidor no mandan el token; ninguna salida lleva tokens | `test/cloud.test.mjs` |
| C15 | `show` imprime la ficha del comentario fijo más reciente, sin la línea de pie | `show trae la ficha…` |
| C14 | un pedido (`@ghosty` o la marca) vuelve a ofrecer el pendiente a su escritor; `wait --watch` lo trae, `asks` lo marca leído; la evidencia no cuenta | `un pedido de la persona despierta…` |
| C10 | `init` instala etiquetas, plantilla, Action, skill y `AGENTS.md` sin pisar lo que existe | `init instala…` |
| C17 | el CI no cuenta los checks de la lista normativa (§5c) y sí el smoke; `wait --watch` no espera a la vista previa y avisa cuando la revisión termina; `show` lee la ficha del PR antes que la del issue y los servicios del commit del PR | `el CI no cuenta…`, `wait --watch no espera…`, `show lee la ficha del PR…` |
| C18 | identidad (§8): orden de credenciales (`GHOSTY_DEV_TOKEN` → archivo → login) y `whoami` con `source`; un agente sin TTY nunca abre el navegador; `login --no-wait` sale ya con el pendiente 0600 y `--wait` lo retoma, sale con 75 si sigue pendiente; ninguna salida lleva tokens ni `device_code`; device flow con `authorization_pending` → tokens, `slow_down` suma 5 s, `expired_token` y `access_denied` fallan; loopback `127.0.0.1/cb` con PKCE S256 rechaza otro `state`; refresh con < 60 s y reintento único tras 401; `logout` revoca y borra; `auth.json` 0600; `env push` sin archivo falla y nunca imprime valores | `test/auth.test.mjs` |
| C19 | `preview`: lista → liga sólo en stdout y 0; armándose → 75 sin liga; `--wait` armándose→lista y no se conforma con un commit viejo; falló → 1 con el error limpio; 403 `insufficient_scope` pide `login --force`; PR deducido de la rama; la liga nunca sale en stderr, errores ni `show --pr` (que da `{phase, sha}`) | `test/preview.test.mjs` |
| C20 | `box logs` limpia la salida (ANSI, `?k=`, `Bearer`) y manda `--lines`; `box exec -- …` arma la línea de shell, sale con el código del comando y deduce el PR; `restart` y `rebuild`; 404 sin caja, 403 sin asiento e `insufficient_scope` con el siguiente paso y sin tokens | `test/box.test.mjs` |
| C21 | `wait --pr --until preview|ci|any`: un renglón JSON por cambio sin la liga; CI verde 0, rojo 1; tope → 75 (si «Ghosty · Preview/Smoke» siguen en curso con la vista previa lista, lo dice: `stuck` con el arreglo); una vista previa de un commit viejo no cuenta como lista | `test/box.test.mjs` |
| C22 | la puerta en borrador sale verde con su nota y corre con `ready_for_review`; sin script en la base pasa con aviso; con script que no carga o truena, rojo con el error limpio y el remedio (falla cerrada); un `gate.mjs` viejo se corre como antes | `test/gate-runner.test.mjs` |
| C23 | `Depende de #N`: apilado sobre la rama de otro PR o con su commit → se agrega una vez; lo que escribió una persona no se duplica ni se toca; al entrar ese PR, se quita | `test/deps.test.mjs` |
| C24 | `init` imprime repo y rama antes de escribir y, fuera de la rama principal, no escribe sin `--yes`; sin terminal y sin `--yes` no crea etiquetas y lo dice; lista los workflows que dispara un push a la rama principal; `protect --dry-run` lista los PR abiertos que quedarían bloqueados y por qué, sin escribir | `test/install.test.mjs` |
| C25 | `evidence` re-corre la puerta del PR que cierra #n (cualquier rama, por `head_sha`); el workflow con `issue_comment` (sólo comentarios con marca) re-corre el run de la puerta del PR que cierra el issue, si ya terminó | `test/adopt.test.mjs` |
| C27 | `preview share` imprime la liga pública (idempotente) y sólo ahí; `unshare` la revoca sin imprimirla; `requests` lista limpia; `accept/reject <id> --pr` deciden; PR cerrado o id inválido salen 1 | `test/share.test.mjs` |
| C28 | PR en conflicto con su base (`mergeable:false`/`mergeable_state:dirty`, reintento si llega `null`): `next`/`status` lo ponen como primer paso con `git fetch origin && git switch <rama> && git merge origin/<base>` y los archivos (git merge-tree); `show --pr` y `ready` lo avisan; la puerta falla con esa causa sin correr gate.mjs (en borrador sólo avisa) | `test/adopt.test.mjs`, `test/gate-runner.test.mjs` |
| C29 | `claim <n>` crea la rama desde `origin/<principal>` (o `--base`), nunca desde la rama actual, y avisa antes si el clon está en otra; `show <m>` con m PR lo dice («es un PR, no un pendiente: cierra #n»); `asks`/`next` dejan fuera, marcados «obsoletos», los avisos del bot de otro commit, de un check que ya no existe, anteriores a la cabeza o de un PR cerrado | `test/adopt.test.mjs` |
| C30 | El lock (npm/pnpm/yarn) coincide con package.json en HEAD: `check-lock` sale 1 con «… no coincide: corre `npm install` y súbelo»; el pre-push que instala `init` lo corre (sin pisar un hook ajeno); `evidence` se niega, `ready` avisa y `next` da el paso `lock`. `next` pone primero los pedidos (de la persona o el automático de gs en el PR) | `test/lock.test.mjs` |
| C31 | `doctor`: baja el catálogo público de gs (`GET /api/v2/preview-oauth/providers`, sin sesión, sin redirecciones; no hay catálogo propio), detecta como la caja (grepPattern, codeHints, alias de env), dice llaves faltantes (`env ls`), la URL a registrar sola en su renglón + consola + 3 pasos + «pídeselo a Ghosty con ghosty-browser», y si el código no usa `GS_PREVIEW_OAUTH_REDIRECT_URI`; prefiere `preview.oauth` del PR (`registered`). Sin catálogo no inventa | `test/doctor.test.mjs` |
| C32 | `preview` y `doctor` dicen las variables que el código lee y la vista previa del PR no tiene (`missingEnv` de gs, sólo nombres válidos; las que lee el PR primero): `preview` las imprime con «ghosty-dev env push», `doctor` agrega el check `env-faltantes`: sale 1 sólo por las prioritarias (`missingEnvPriority`: las lee el PR o el arranque del servidor); el resto de la app es informativo. Nunca valores | `test/preview.test.mjs`, `test/doctor.test.mjs` |
| C26 | `claim --pr <m> --issue <n>` adopta sin rama ni worktree y agrega `Closes #n`; `review/evidence --pr`; `ready`/`show` avisan del PR sin pendiente con el comando; `next` da el paso; `claim --cloud` sin `--yes` dice qué ocupa y qué desalojaría y no manda nada (75) | `test/adopt.test.mjs` |
| C33 | `merge <m>` no mezcla con un check en curso (también «Ghosty · Smoke»), en rojo, la puerta faltante, borrador o conflicto (75 si sólo falta que resuelva, `--wait` espera; 1 si algo falla); tras mezclar quita las etiquetas del pendiente y espera el deploy en push a la base. PR cerrado sin merge: `merge`/`wait`/`show`/`next` dicen quién, cuándo y el motivo y ofrecen `gh pr reopen`; el pre-push lo avisa. `block <n> --reason` deja motivo con marca; `next` lo pide en borrador. La evidencia exige «Flujo principal probado con sesión»; `doctor` pone la identidad de Ghosty antes que OAuth y avisa de la base de la preview | `test/merge.test.mjs`, `test/doctor.test.mjs`, `test/evidence.test.mjs` |
| C16 | `init` crea `.ghosty/factory.md` con `memory:` (8gb en monorepo o con `--max-old-space-size`, si no 4gb), dice por qué y nunca lo pisa, ni con `--force` | `init crea .ghosty/factory.md…`, `init pide 8gb…` |

## 7. Fuera de v0.1

Lo que no está porque no se traza a una ley ni a una fuente de la tabla: roles fijos, máquina de estados con
transiciones obligatorias, prioridades, épicas, memoria del proyecto, enjambres. Lo que en tu compu no se puede
(correr sin la laptop prendida, preview que bloquea el merge, CI aislado, varios agentes a la vez) es la nube de
Ghosty, no este repo.

## 8. Identidad

Normativo. ghosty-dev habla con dos sistemas y cada uno tiene su identidad; nunca se mezclan.

1. **GitHub es `gh`.** Issues, PR, checks y etiquetas van con la sesión de `gh` de la persona. El token de `gh`
   **nunca** se manda a Ghosty Studio ni a ningún otro servidor.
2. **Ghosty Studio sólo para la nube.** Lo único que necesita identidad de persona en Ghosty son los pendientes en
   la nube (§5b), la vista previa de un PR (§5c) y las variables (secretos) de la vista previa. Para eso ghosty-dev tiene su propio login OAuth 2.0;
   la identidad queda en dos piezas: `gh` para GitHub y esta sesión para Ghosty:
   - cliente público `ghosty-dev` (sin secreto), scope `profile repo:env dev` y nada más (`repo:env` = variables,
     `dev` = mandar, seguir y detener tus pendientes de Desarrollo y ver la vista previa de tus PR). Una sesión sin el permiso que pide la ruta recibe
     403 `insufficient_scope` y el CLI dice cuál falta y `ghosty-dev login --force` (sin reintentar);
   - `GHOSTY_DEV_BASE_URL` sólo acepta `https://` (o `http://` hacia `127.0.0.1`/`localhost`, para pruebas), sin
     usuario, query ni fragmento. Ningún fetch sigue redirecciones ni sale del origen de la base, tampoco los
     endpoints que anuncie la metadata. La sesión guardada sólo se manda al servidor que la emitió;
   - endpoints por metadata [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414)
     (`/.well-known/oauth-authorization-server`); sin `device_authorization_endpoint`, `${base}/oauth2/device`.
     `GHOSTY_DEV_BASE_URL` cambia la base (por defecto `https://www.ghosty.studio`);
   - con navegador en la máquina: redirect loopback [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)
     `http://127.0.0.1:<puerto al azar>/cb` + PKCE S256 ([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)) +
     `state`; un regreso con otro `state` se rechaza;
   - sin navegador (`SSH_CONNECTION`, `CI`, Linux sin `DISPLAY`/`WAYLAND_DISPLAY`) o con `--device`: device flow
     [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628) (`slow_down` suma 5 s al intervalo);
   - la sesión vive en `${XDG_CONFIG_HOME:-~/.config}/ghosty-dev/auth.json`, modo 0600 en carpeta 0700 (si
     alguien los abrió, se vuelven a cerrar y se avisa por stderr). El access
     se renueva con el refresh cuando le quedan menos de 60 s, y una vez tras un 401; el refresh rota y se guarda el
     nuevo. `logout` revoca el refresh ([RFC 7009](https://www.rfc-editor.org/rfc/rfc7009)) y borra el archivo;
   - `GHOSTY_DEV_TOKEN` manda sobre el archivo (CI): se usa tal cual, sin refresh ni reintento.
   - **Orden de credenciales antes de iniciar un login** (el de [fly.io/auth.md](https://fly.io/auth.md)):
     `GHOSTY_DEV_TOKEN` → sesión del archivo vigente o renovable → sólo entonces login. `login` con credenciales ya
     presentes no inicia nada y responde `{status:"ok", already:true, source}`; `whoami --json` dice `source`
     (`env` | `file`).
   - **Quien corre es un agente** si stdin o stdout no es TTY, o con `--json`: nunca se abre el navegador, va el
     device flow, y la liga sale en la primera línea antes de sondear.
4. **Login en dos pasos para agentes** (timeouts de ~2 min, sin ver stdout hasta que el comando termina):
   1. `login --no-wait [--json]` pide el código, guarda el pendiente (`device_code`, intervalo, vencimiento) en
      `pending-login.json` 0600 junto a `auth.json`, imprime liga y código y sale con 0 de inmediato. En `--json`:
      `{status:"pending", verification_uri_complete, user_code, expires_at, next:"ghosty-dev login --wait"}`.
   2. El agente le pasa la liga a la persona y espera a que apruebe.
   3. `login --wait [--timeout 90]` retoma el pendiente y sondea hasta `--timeout` segundos (90 por defecto, para
      caber en el timeout del agente; el código vive ~10 min). Aprobado: guarda la sesión, borra el pendiente, sale
      con 0. Sigue pendiente: sale con **75** y `{status:"pending", next:"ghosty-dev login --wait"}`. Caducado o
      negado: error con «corre ghosty-dev login --no-wait otra vez».

   Sin sesión, todo comando que la necesita falla con el siguiente paso exacto: `ghosty-dev login --no-wait`.
   **Ninguna salida** (tampoco `--json` ni errores) lleva `access_token`, `refresh_token` ni `device_code`.
5. **Variables.** `env ls` da sólo nombres (guardadas, faltantes, riesgos, pedidos bloqueados). `env push <archivo>`
   exige el archivo (nunca lee un `.env` implícito), imprime la ruta y los nombres antes de guardar, pide
   confirmación (sin terminal exige `--yes`), fusiona por defecto y dice cuáles ya guardadas se quedan; `--replace`
   reemplaza todas. Sólo el dueño del espacio guarda. **Ningún valor se imprime**, tampoco en errores.

Las APIs son `GET|POST /api/v2/me/repos/:owner/:name/env` (variables), `GET /api/v2/me/repos/:owner/:name/prs/:pr/preview`
(vista previa del PR), `GET|POST …/prs/:pr/box` (su caja) y `/api/v2/me/dev-runs` (nube) de Ghosty Studio, con `Authorization: Bearer`. Los mensajes del servidor se imprimen sin caracteres de control, sin nada con
forma de token y recortados. Seguridad y cómo reportar: [SECURITY.md](SECURITY.md).
