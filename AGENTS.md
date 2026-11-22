<!-- ghosty-dev:agents -->
## Bitácora (ghosty-dev)

Este repo usa **ghosty-dev**: las tareas son issues de GitHub con etiqueta `ghosty-dev:*` y se cierran con
evidencia. No uses listas TODO en markdown para llevar el trabajo.

1. **El trabajo vive en la bitácora, no en la sesión.** Empieza con `ghosty-dev ready --json`, toma uno con
   `ghosty-dev claim <n>` y trabaja sólo en su worktree (`../<repo>-<n>`, rama `ghosty-dev/<n>-…`).
2. **Se revisa la evidencia, no el código.** Con el CI en verde, otro agente con contexto limpio revisa el PR
   (subagente `ghosty-dev-revisor`, o `ghosty-dev review <n>` en otra sesión); tú no te calificas. Con la revisión
   en 0 hallazgos abiertos: `ghosty-dev evidence <n> --file evidencia.md`
   (secciones «Qué se hizo», «Verificación» con comandos `$ …` y su salida real, «CI» con resultado y liga,
   «Preview», «Criterios de aceptación» marcados). El PR lleva `Closes #<n>`; sin revisión del commit actual y sin
   evidencia, el check `ghosty-dev/evidencia` no deja mergear. Nunca cierres un issue sin evidencia.
3. **Se espera por evento, no se sondea.** Con el PR abierto: `ghosty-dev wait <n> --watch` espera al CI en una sola llamada (tope 5 min); si tarda más, toma otro pendiente o termina. Si el repo está conectado a Ghosty Studio, `wait --watch` también avisa cuando la vista previa y la revisión de Ghosty terminan, y `ghosty-dev show <n>` da la ficha y los servicios del PR (vista previa con su liga, revisión, smoke, CI): no hace falta otro CLI.
   Para probar la app: push → `ghosty-dev preview --wait --json` → prueba la app en `url` → evidencia (0 lista, 75 armándose, 1 falló; sin pendiente: `show --pr <m>`);
   si falla: `ghosty-dev box logs` / `ghosty-dev box exec -- <comando>` → arregla → push (la caja la administras tú; `wait --pr <m> --until ci|review` espera sin pendiente).
   La liga lleva la llave de la vista previa: nunca la pegues en la evidencia, el issue ni el PR.
   `ghosty-dev ready` te lo vuelve a ofrecer cuando el CI resuelva.

La nube (`claim <n> --cloud`) y las variables de la vista previa (secretos) van con `ghosty-dev login --no-wait` → la persona aprueba la liga →
`ghosty-dev login --wait` (sólo si `whoami` no encuentra sesión, y preguntando antes) y `ghosty-dev env ls | push <archivo>`
(sesión propia de Ghosty Studio; GitHub sigue siendo `gh`). El archivo lo nombra la persona y ningún valor se imprime.

Un solo escritor por pendiente. Lo que la persona pida y lo que descubras va a un pendiente nuevo
(`ghosty-dev add "título" --goal … --criteria …`), y si te bloquea: `ghosty-dev block <n> --by <m>`. La persona (el Clerk) lee la evidencia y
decide el merge. Los identificadores van siempre en inglés (variables, funciones, llaves, archivos); en
español sólo comentarios, mensajes y nombres de pruebas. Especificación: `SPEC.md` del paquete ghosty-dev.
<!-- /ghosty-dev:agents -->
