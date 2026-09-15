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

## Fase 0 — Entrada y requisitos

Reunir las URLs a auditar y comprobar que el entorno puede ejecutar la auditoría.

## Fase 1 — Inventario de cookies reales

Cargar la URL en un Chromium visible con perfil limpio, aceptar el banner, esperar a que la página se asiente y leer el almacén de cookies completo vía CDP.

## Fase 2 — Cookies declaradas en la página de cookies

Localizar la página de política de cookies desde el enlace del footer y extraer todas las cookies que declara.

## Fase 3 — Cookies declaradas en el panel del banner

Reabrir el banner desde esa misma página, entrar en «Configuración de cookies», desplegar todas las secciones y extraer las cookies que declara cada categoría.

## Fase 4 — Salidas e informe

Cruzar los tres listados, escribir `cookies.csv`, `correspondencia.csv` e `informe.html`, y resumir los conteos en la conversación.

## Bloqueos

Cuando `audit.mjs` no encuentra una pieza del recorrido, no improvisa: escribe un JSON de bloqueo en stdout y termina con código de salida 2. Ante ese código hay que preguntar al usuario y relanzar el script con el parámetro que resuelva el bloqueo.

| Bloqueo | Se resuelve con |
| --- | --- |
| `banner-no-encontrado` | `--selector-aceptar` |
| `pagina-cookies-no-encontrada` | `--cookies-url` |
| `boton-reabrir-no-encontrado` | `--selector-reabrir` |
| `panel-configuracion-no-encontrado` | `--selector-reabrir` |
