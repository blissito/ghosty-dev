<!-- bitacora:agents -->
## Bitácora (ghosty-bitacora)

Este repo usa **ghosty-bitacora**: las tareas son issues de GitHub con etiqueta `bitacora:*` y se cierran con
evidencia. No uses listas TODO en markdown para llevar el trabajo.

1. **El trabajo vive en la bitácora, no en la sesión.** Empieza con `bitacora ready --json`, toma uno con
   `bitacora claim <n>` y trabaja sólo en su worktree (`../<repo>-<n>`, rama `bitacora/<n>-…`).
2. **Se revisa la evidencia, no el código.** Antes de terminar: `bitacora evidence <n> --file evidencia.md`
   (secciones «Qué se hizo», «Verificación» con comandos `$ …` y su salida real, «CI» con resultado y liga,
   «Preview», «Criterios de aceptación» marcados). El PR lleva `Closes #<n>`; sin evidencia, el check
   `bitacora/evidencia` no deja mergear. Nunca cierres un issue sin evidencia.
3. **Se espera por evento, no se sondea.** Con el PR abierto y el CI corriendo: `bitacora wait <n>` y termina.
   `bitacora ready` te lo vuelve a ofrecer cuando el CI resuelva.

Un solo escritor por pendiente. Lo que descubras va a un pendiente nuevo (`gh issue create --label
bitacora:listo`), y si te bloquea: `bitacora block <n> --by <m>`. La persona (el Clerk) lee la evidencia y
decide el merge. Especificación: `SPEC.md` del paquete ghosty-bitacora.
