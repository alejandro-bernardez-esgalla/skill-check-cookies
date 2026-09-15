---
name: check-cookies
description: Audita el cumplimiento de cookies de una o varias URLs. Compara las cookies realmente presentes en el navegador con las declaradas en la página de política de cookies y en el panel «Configuración de cookies» del banner, y genera dos CSV y un informe HTML de discrepancias. Úsala cuando pidan auditar cookies, revisar la política de cookies de un sitio, comprobar si el banner declara las cookies que se instalan, o detectar cookies no declaradas.
---

# Auditoría de cookies web

Esta skill audita un sitio a tres bandas: lo que el navegador tiene, lo que la página de cookies dice tener y lo que el panel del banner dice tener. Todo lo que no cuadre entre esas tres listas es una discrepancia.

Implementa [SPEC 01](../../../specs/01-auditoria-cookies-web.md). Las heurísticas de detección del banner viven en [references/deteccion-banner.md](references/deteccion-banner.md).

## Piezas

| Pieza | Qué hace |
| --- | --- |
| `scripts/audit.mjs` | Conduce Chromium con Playwright y recolecta los tres listados en `auditoria.json`. |
| `scripts/build_report.mjs` | Lee `auditoria.json`, cruza los listados y escribe los CSV y el informe HTML. |
| `references/deteccion-banner.md` | Patrones de texto y DOM para localizar banner, enlace de cookies, botón de reapertura y secciones. |

Las salidas de cada URL van a `reports/<dominio>-<YYYYMMDD-HHmm>/`.

Por dentro, `audit.mjs` recorre cuatro fases por cada URL: inventario de
cookies reales vía CDP (fase 1), cookies declaradas en la página de cookies
(fase 2), cookies declaradas en el panel del banner (fase 3) y, ya en
`build_report.mjs`, el cruce de los tres listados en las salidas (fase 4).
El detalle de cada fase está en [SPEC 01](../../../specs/01-auditoria-cookies-web.md);
esta sección describe el flujo que sigue la skill, no el script.

## Flujo

1. **Reunir las URLs.** Si no se han dado URLs, pedirlas antes de hacer nada.
   Aceptar una o varias; cada una se audita por separado, con su propia
   carpeta de salida.

2. **Ejecutar `audit.mjs` por cada URL**, desde la raíz del repositorio:

   ```
   node .claude/skills/check-cookies/scripts/audit.mjs --url <URL>
   ```

   Se abre una ventana de Chromium visible: es intencionado, no interrumpirla.
   Añadir `--salida <carpeta>` solo si el usuario ha pedido una ruta concreta;
   por defecto usa `reports/<dominio>-<fecha>/`.

3. **Interpretar el código de salida.**
   - Código `0`: la fase 1-3 terminó bien. Continuar en el paso 4.
   - Código `2`: hubo un bloqueo. La última línea de stdout es un JSON con
     `bloqueo`, `fase` y `descripcion`. Mirar la tabla de **Bloqueos** más
     abajo, explicarle al usuario qué no se ha encontrado y preguntarle el
     valor que resuelve ese bloqueo concreto (una URL, un selector CSS, o el
     texto visible de un botón, según el caso). Para
     `boton-reabrir-no-encontrado`, preguntar primero por el texto del botón
     (`--texto-reabrir`), que el usuario puede leer sin abrir el inspector;
     recurrir a `--selector-reabrir` solo si el texto no es suficiente para
     distinguirlo. No adivinar el valor ni reintentar sin ese dato.
   - Código `1`: error de uso (falta `--url`, URL inválida). No es un
     bloqueo; corregir el argumento y no relanzar a ciegas.

4. **Relanzar tras un bloqueo.** Repetir el comando del paso 2 añadiendo el
   parámetro resuelto (p. ej. `--selector-aceptar "#cookie-ok"`). Si vuelve a
   bloquearse en una fase distinta, repetir este paso; si se bloquea otra vez
   en la misma fase, no seguir insistiendo sola: preguntar al usuario si
   quiere afinar el valor o descartar esa URL.

5. **Registrar la incidencia resuelta.** En cuanto una URL termina con
   código `0` después de haber pasado por el paso 4, editar el
   `auditoria.json` que acaba de escribir `audit.mjs` (carpeta indicada en su
   salida) y añadir una entrada a `incidencias` por cada bloqueo resuelto:

   ```json
   { "fase": 1, "descripcion": "<descripcion del bloqueo>", "resolucionUsuario": "<parámetro y valor usados>" }
   ```

   Si la URL no tuvo ningún bloqueo, no hay nada que añadir aquí: `audit.mjs`
   ya deja `incidencias: []`.

6. **Ejecutar `build_report.mjs`** sobre el `auditoria.json` de esa URL:

   ```
   node .claude/skills/check-cookies/scripts/build_report.mjs --auditoria <carpeta>/auditoria.json
   ```

   Esto escribe `cookies.csv`, `correspondencia.csv` e `informe.html` en la
   misma carpeta; el informe incluye tanto los conteos por severidad como el
   apartado de incidencias que se acaba de editar en el paso anterior.

7. **Resumir en la conversación**, por cada URL: la ruta de la carpeta de
   salida, el conteo por severidad que imprime `build_report.mjs` y una
   frase sobre el estado general (equivalente al semáforo del informe:
   crítico si hay `Crítica`, atención si hay `Alta`, revisar si solo hay
   `Media`, correcto si no hay ninguna). Señalar `informe.html` como el
   entregable para abrir y compartir.

## Bloqueos

Cuando `audit.mjs` no encuentra una pieza del recorrido, no improvisa: escribe un JSON de bloqueo en stdout y termina con código de salida 2. Ante ese código hay que preguntar al usuario y relanzar el script con el parámetro que resuelva el bloqueo.

| Bloqueo | Fase | Se resuelve con |
| --- | --- | --- |
| `banner-no-encontrado` | 1 | `--selector-aceptar` |
| `pagina-cookies-no-encontrada` | 2 | `--cookies-url` |
| `boton-reabrir-no-encontrado` | 3 | `--texto-reabrir` (el texto visible del botón; se esperaba «Configurar cookies») o `--selector-reabrir` |
| `panel-configuracion-no-encontrado` | 3 | `--selector-reabrir` |
