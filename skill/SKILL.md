---
name: ghosty-dev
description: Trabajar con la bitácora del repo (pendientes en GitHub Issues que se cierran con evidencia). Úsala al empezar cualquier tarea de código en un repo con etiquetas ghosty-dev:*, cuando pidan «toma el siguiente pendiente», «cierra el #n» o cuando descubras trabajo nuevo.
---

# Bitácora: el trabajo vive en GitHub Issues, no en tu sesión

**El flujo en 5 renglones** (si sólo recuerdas esto, basta):

1. `ghosty-dev next` — el siguiente paso exacto según el repo (empieza aquí siempre, también tras compactar).
2. Trabajo nuevo: `ghosty-dev claim <n>`. Trabajo que ya existe (PR a mano, rama propia): `ghosty-dev claim --pr <m> --issue <n>`.
3. Push → `ghosty-dev preview --wait --json` → prueba la app; si falla: `ghosty-dev box logs` / `box exec -- <cmd>` → arregla → push.
4. CI verde → revisión de otra sesión: `ghosty-dev review <n> --pr <m>` (subagente ghosty-dev-revisor), 0 hallazgos abiertos.
5. `ghosty-dev evidence <n> --pr <m> --file evidencia.md` (re-dispara la puerta) → la persona mezcla. Nunca `gh issue comment` a mano.

Tu sesión se puede tirar en cualquier momento. Lo que importa queda en el **pendiente** (un issue con etiqueta
`ghosty-dev:*`). Tres leyes, sin excepción:

1. **El trabajo vive en la bitácora, no en la sesión.** Lo pendiente, lo decidido y lo descubierto se escribe en
   el issue, no en tu contexto ni en un TODO de markdown.
2. **Se revisa la evidencia, no el código.** Nunca digas «ya quedó» sin evidencia; nunca cierres sin el
   comentario de evidencia.
3. **Se espera por evento, no se sondea.** Nunca preguntes una y otra vez por el CI (`sleep`, loops). Espéralo
   con UNA sola llamada que se bloquea (`ghosty-dev wait <n> --watch`, tope 5 min); si tarda más, toma otro
   pendiente o termina.

## El ciclo

```sh
ghosty-dev ready --json            # qué se puede tomar (listo, desbloqueado o CI ya resuelto)
ghosty-dev claim <n>               # te lo asigna y crea su worktree y su rama ghosty-dev/<n>-…
cd ../<repo>-<n>                 # trabaja SÓLO ahí: un pendiente, un worktree, un escritor
# … código y tests …
git push -u origin HEAD && gh pr create --fill --body "Closes #<n>"
ghosty-dev wait <n> --watch        # espera al CI en una sola llamada (en Claude Code, timeout 360000)
ghosty-dev show <n>                # la ficha y los servicios del PR: vista previa (con su liga), revisión, smoke y CI
ghosty-dev preview --wait --json   # la vista previa del PR de tu rama: espera a la del último push y da su liga
```

- **Probar la vista previa** (repo conectado a Ghosty Studio): push → `ghosty-dev preview --wait --json` → prueba la app en `url` → evidencia.
  `preview` sale 0 lista (`url` es la liga), 75 todavía armándose (vuelve a correrlo con `--wait`; en Claude Code,
  timeout 660000) y 1 si falló (`error` dice por qué; arréglalo y vuelve a subir). Si avisa que la vista previa es de
  otro commit, te falta `git push`. Sin pendiente (PR escrito desde la terminal): `ghosty-dev show --pr <m>`.
- **La vista previa falló o la app truena: tú administras su caja**, no otro agente. `ghosty-dev box logs [--lines 400]`
  (log del build y del servidor) → `ghosty-dev box exec -- <comando>` (en `/app/src`, 60 s, sale con su código; p. ej.
  `curl -s -o /dev/null -w '%{http_code}' localhost:3000/ruta`) → arregla en tu rama → push → `preview --wait`.
  `box restart` reinicia la app; `box rebuild` la rearma sin push. Lo que arregles en la caja con `exec` se pierde en
  el siguiente push: el arreglo va al código. Para esperar CI o revisión sin pendiente:
  `ghosty-dev wait --pr <m> --until ci|review|preview|any --json` (0 cumplido, 1 falló/rojo, 75 tiempo).
- **PR apilado** (su base es la rama de otro PR, o lo armaste sobre uno sin mezclar): `preview`/`wait` escriben solos
  `Depende de #N` en la descripción y la quitan cuando ese PR entra (`ghosty-dev deps` para hacerlo ya).
- **Borrador:** mientras el PR es draft la puerta no exige evidencia (ni hay vista previa); al marcarlo listo
  (`gh pr ready`) se exige todo.
  **La liga lleva la llave de la vista previa:** úsala para probar (navegador, curl, Playwright), pero nunca la
  pegues en la evidencia, el issue, el PR ni el chat; en «Preview» escribe qué probaste y el commit.

- **Servicios del PR.** Si el repo está conectado a Ghosty Studio, todo PR recibe solo, por webhook, su vista
  previa, la revisión de Ghosty Review (hallazgos como comentarios en línea), el smoke y la ficha, lo hayas abierto
  tú o un agente de la nube. No necesitas otro CLI: `wait --watch` avisa cuando la vista previa y la revisión
  terminan (sin esperarlas: el veredicto verde/rojo es del CI, y el smoke cuenta como CI) y `show <n>` te da su
  estado y la liga de la vista previa. Con hallazgos, arréglalos en la misma rama y vuelve a subir.

- **La persona te pidió algo** (`ready` dice `reason: pedido`, o `wait` regresa con `asks`) → eso manda sobre lo
  demás: hazlo en la misma rama, sube y vuelve a esperar. `ghosty-dev asks <n>` los lee y los marca leídos. La
  persona te escribe en el issue o el PR con `@ghosty`, o desde Ghosty Studio (web, iOS o Teams): todo llega igual.
- **La nube** (`claim <n> --cloud`, `cloud`, `stop`, `teleport`) usa la misma sesión de `ghosty-dev login` que las
  variables; no necesitas el CLI `ghosty`. Si dice «no tiene el permiso dev», pídele a la persona
  `ghosty-dev login --force` (no lo repitas en bucle).
- **Tools de Ghosty desde la terminal (opcional):** con `ghosty login`, el CLI `ghosty` te da lo de Ghosty Studio (imágenes,
  documentos, sitios, navegador, voz, datos…). `ghosty --help` lista los comandos; úsalos en vez de instalar
  librerías para eso.
- **La vista previa no arranca por variables** (la ficha o `show` lo dicen): `ghosty-dev env ls` da los nombres que
  faltan. Para guardarlas: `ghosty-dev env push <archivo>`. Pregúntale a la persona de qué archivo salen, enséñale
  los nombres que imprime y, con su sí, `--yes`. Nunca leas un `.env` que no te nombró ni pegues un valor en el
  chat, el issue o el PR.
- **Sesión de Ghosty Studio** (sólo para variables; GitHub sigue siendo `gh`). Primero mira si ya hay:
  `ghosty-dev whoami --json` (`source`: `env` = `GHOSTY_DEV_TOKEN`, `file` = sesión guardada). Si hay, no pidas
  login. Si no, **pregunta antes de correr login: cambia la configuración de la máquina.** Con su sí, en dos pasos:

  ```sh
  ghosty-dev login --no-wait --json   # sale ya: {status:"pending", url, code, …}
  # pásale a la persona la liga y el código, y espera a que diga que ya aprobó
  ghosty-dev login --wait --json      # sondea hasta 90 s; código 75 = sigue pendiente: vuelve a correrlo
  ```

  Muestra la liga al humano y espera a que apruebe; no intentes saltarte ese paso. Si caducó o lo negaron, vuelve a
  empezar con `--no-wait`. Nunca imprimas, registres ni pongas en un mensaje el access_token, refresh_token ni
  device_code (ni leas `~/.config/ghosty-dev/`).
- **CI verde** → pide la revisión (abajo) y, cuando no tenga hallazgos abiertos, publica la evidencia.
- **CI rojo** → arréglalo, sube y vuelve a esperar.
- **Se acabaron los 5 min** → el pendiente queda en `esperando-ci`: toma otro independiente o termina.
  `ghosty-dev ready` te lo vuelve a ofrecer con `ci-verde` o `ci-rojo` cuando resuelva.

```sh
ghosty-dev evidence <n> --file evidencia.md   # valida el formato y lo publica en el issue
```

Después de publicarla, dile a la persona **dónde está y qué dice**: la liga del comentario (la imprime
`ghosty-dev evidence`), **la liga del PR** (ahí da el merge) y un resumen de tres renglones (qué se hizo, qué pruebas pasaron, CI). Que pueda decidir
el merge sin abrir el código.

El PR lo mergea el **Clerk** (la persona) después de leer la evidencia; `Closes #<n>` cierra el pendiente.
Si no hubo PR (tarea sin código), `ghosty-dev close <n>`, que también exige evidencia.

## La revisión: tú no te calificas

Quien escribe se califica de más. Antes de la evidencia, **otro agente con contexto limpio** revisa tu PR:

- **En Claude Code:** lanza el subagente `ghosty-dev-revisor` y pásale **sólo** «Revisa el pendiente #<n>». Nada
  de lo que pensaste, probaste o decidiste: si se lo cuentas, ya no es una revisión limpia.
- **Sin subagentes (Codex u otro):** corre `ghosty-dev review <n>` y pídele a la persona que pegue ese encargo
  en **otra sesión** (mejor si es otro modelo).

El revisor publica su revisión en el issue, atada al commit exacto del PR. La puerta exige una revisión **del
commit actual** con `Hallazgos abiertos: 0`.

- **Con hallazgos:** agrega al PR el archivo de pruebas que te pasó el revisor, arregla el código hasta que pase,
  sube, `ghosty-dev wait <n> --watch` y vuelve a pedir la revisión (cada push necesita revisión nueva).
- **Tope: 3 rondas.** Si a la tercera sigue con hallazgos, detente y explícale a la persona qué falta.

## El archivo de evidencia

~~~markdown
## Qué se hizo
Una o dos frases concretas.

## Verificación
```sh
$ npm test
<salida real, copiada, no resumida>
```

## CI
✅ passed — <liga del run>

## Preview
<liga o video del recorrido, o «no aplica»>

## Criterios de aceptación
- [x] <cada criterio del pendiente, con el mismo texto>
~~~

Reglas: la salida es la real (si la recortas, dilo); un criterio que no se cumple se queda `[ ]` y no publicas;
CI rojo no se publica como evidencia.

## Abrir pendientes desde la plática

Cuando la persona te diga qué hay que hacer («hay que paginar /pedidos»), tú abres el pendiente. Escribe un
objetivo (qué debe quedar cierto) y criterios que se puedan comprobar. Si son varios, uno por pendiente, y marca
los bloqueos. Enséñale a la persona la lista antes de crearlos. Al crearlos, `add` le abre a la persona sus
pendientes en el navegador (una vez por tanda); si quiere verlos otra vez, `ghosty-dev board`.

```sh
ghosty-dev add "Paginar /pedidos" --goal "GET /pedidos responde por páginas de 20" \
  --criteria "acepta ?page=N" --criteria "hay un test por página"
ghosty-dev add "Exportar CSV" --goal "…" --criteria "…" --by 12   # bloqueado por #12
```

## Lo que descubras

Si encuentras un bug, un test roto que no es tuyo o trabajo que falta: **abre un pendiente nuevo**, no una nota
ni un comentario perdido, y sigue con el tuyo.

```sh
ghosty-dev add "título" --goal "…" --criteria "…" --from <n>
# si tu pendiente no puede seguir sin él:
ghosty-dev block <n> --by <nuevo>
```

## Prohibido

- Identificadores en otro idioma que no sea inglés: variables, funciones, tipos, parámetros, llaves de objetos
  y nombres de archivo van en inglés aunque el pendiente esté en español (`{ array: '[1,2]' }`, no
  `{ arreglo: … }`). En español sólo comentarios, mensajes al usuario y nombres de las pruebas.

- Tomar un pendiente asignado a otro, o trabajar dos pendientes en el mismo worktree.
- Cerrar un issue con `gh issue close` directo, o publicar evidencia que no corriste.
- Mandar el token de `gh` a Ghosty, imprimir el valor de una variable o subir variables sin que la persona nombre el
  archivo y diga que sí.
- Sondear el CI (`sleep`, loops, preguntar una y otra vez). La única espera es `ghosty-dev wait <n> --watch`.
- Calificarte a ti mismo, escribir o publicar tú la revisión, o contarle al revisor lo que hiciste.
