#!/usr/bin/env node
// Recolector de la auditoría de cookies. Conduce Chromium con Playwright y
// vuelca los tres listados en auditoria.json. Ver SPEC 01.

import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const DIR_SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(DIR_SCRIPTS, '../../../..');

// Heurística provisional en castellano e inglés. El paso 6 de la SPEC la mueve
// a references/deteccion-banner.md; aquí solo cubre la fase 1.
const PATRON_ACEPTAR =
  /acept\w*|permitir\s*todas?|estoy\s*de\s*acuerdo|accept\s*(all)?|allow\s*all|i\s*agree|agree/i;

const SELECTOR_CLICABLES = 'button, a, [role="button"], input[type="button"], input[type="submit"]';

function dosDigitos(n) {
  return String(n).padStart(2, '0');
}

// Sello para el nombre de la carpeta de salida: YYYYMMDD-HHmm en hora local.
function sello(fecha) {
  return (
    `${fecha.getFullYear()}${dosDigitos(fecha.getMonth() + 1)}${dosDigitos(fecha.getDate())}` +
    `-${dosDigitos(fecha.getHours())}${dosDigitos(fecha.getMinutes())}`
  );
}

// ISO 8601 con el desfase local, no en UTC: 2026-09-15T10:32:00+02:00.
function isoLocal(fecha) {
  const desfase = -fecha.getTimezoneOffset();
  const signo = desfase >= 0 ? '+' : '-';
  const absoluto = Math.abs(desfase);
  return (
    `${fecha.getFullYear()}-${dosDigitos(fecha.getMonth() + 1)}-${dosDigitos(fecha.getDate())}` +
    `T${dosDigitos(fecha.getHours())}:${dosDigitos(fecha.getMinutes())}:${dosDigitos(fecha.getSeconds())}` +
    `${signo}${dosDigitos(Math.floor(absoluto / 60))}:${dosDigitos(absoluto % 60)}`
  );
}

function leerArgumentos() {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      salida: { type: 'string' },
      'cookies-url': { type: 'string' },
      'selector-aceptar': { type: 'string' },
      'selector-reabrir': { type: 'string' },
    },
  });

  if (!values.url) {
    console.error('Falta --url. Uso: node audit.mjs --url https://ejemplo.com');
    process.exit(1);
  }

  // Aceptamos "ejemplo.com" sin protocolo para no obligar a escribirlo.
  const bruta = /^https?:\/\//i.test(values.url) ? values.url : `https://${values.url}`;

  let url;
  try {
    url = new URL(bruta);
  } catch {
    console.error(`La URL no es válida: ${values.url}`);
    process.exit(1);
  }

  return {
    url: url.href,
    dominio: url.hostname,
    salida: values.salida ?? null,
    cookiesUrl: values['cookies-url'] ?? null,
    selectorAceptar: values['selector-aceptar'] ?? null,
    selectorReabrir: values['selector-reabrir'] ?? null,
  };
}

// Algunos CMP difieren la carga del banner hasta la primera interacción del
// usuario (ratón o scroll), para no penalizar métricas de rendimiento. Sin
// esto el banner puede tardar más de 20 s en aparecer o no llegar a cargarse.
async function dispararInteraccion(pagina) {
  await pagina.mouse.move(400, 300);
  await pagina.mouse.move(600, 400);
  await pagina.mouse.wheel(0, 200);
}

// Localiza y pulsa el botón de aceptar del banner de cookies.
// Devuelve true si lo encontró y pulsó, false si no apareció ninguno.
async function aceptarBanner(pagina, selectorAceptar) {
  await dispararInteraccion(pagina);

  const candidato = selectorAceptar
    ? pagina.locator(selectorAceptar).first()
    : pagina.locator(SELECTOR_CLICABLES).filter({ hasText: PATRON_ACEPTAR }).first();

  try {
    await candidato.waitFor({ state: 'visible', timeout: 12000 });
  } catch {
    return false;
  }

  await candidato.click();
  return true;
}

// Recorre la página con scroll hasta el final, dando tiempo a que el contenido
// perezoso se cargue, en vez de saltar directo a scrollHeight.
async function scrollHastaElFinal(pagina) {
  await pagina.evaluate(async () => {
    const paso = Math.max(window.innerHeight, 400);
    let posicionAnterior = -1;
    while (window.scrollY !== posicionAnterior) {
      posicionAnterior = window.scrollY;
      window.scrollBy(0, paso);
      await new Promise((resuelve) => setTimeout(resuelve, 200));
    }
  });
}

function auditoriaVacia(opciones, fecha) {
  return {
    url: opciones.url,
    dominio: opciones.dominio,
    timestamp: isoLocal(fecha),
    urlPaginaCookies: null,
    cookiesReales: [],
    cookiesPagina: [],
    cookiesPanel: [],
    incidencias: [],
  };
}

async function main() {
  const opciones = leerArgumentos();
  const fecha = new Date();

  const dirSalida =
    opciones.salida ?? path.join(RAIZ, 'reports', `${opciones.dominio}-${sello(fecha)}`);
  await mkdir(dirSalida, { recursive: true });

  const auditoria = auditoriaVacia(opciones, fecha);

  // Perfil limpio: un contexto efímero por ejecución, nunca launchPersistentContext.
  // Sin esto, las cookies de auditorías anteriores contaminarían el inventario.
  const navegador = await chromium.launch({ headless: false });
  const contexto = await navegador.newContext();

  try {
    const pagina = await contexto.newPage();
    await pagina.setViewportSize({ width: 1440, height: 900 });

    // Fase 1: cargar la URL, aceptar el banner y asentar la página antes de
    // inventariar cookies (el inventario CDP llega en el paso 5).
    await pagina.goto(opciones.url, { waitUntil: 'domcontentloaded' });

    const bannerAceptado = await aceptarBanner(pagina, opciones.selectorAceptar);
    if (bannerAceptado) {
      console.log('Banner de cookies aceptado.');
    } else {
      console.warn('No se encontró el botón de aceptar del banner; se continúa sin aceptarlo.');
    }

    // Best-effort: sitios con publicidad no llegan nunca a red inactiva real.
    try {
      await pagina.waitForLoadState('networkidle', { timeout: 15000 });
    } catch {
      console.warn('La red no llegó a quedar inactiva en 15 s; se continúa igualmente.');
    }
    await scrollHastaElFinal(pagina);
  } finally {
    await contexto.close();
    await navegador.close();
  }

  const rutaJson = path.join(dirSalida, 'auditoria.json');
  await writeFile(rutaJson, `${JSON.stringify(auditoria, null, 2)}\n`, 'utf8');

  console.log(`Carpeta de salida: ${dirSalida}`);
  console.log(`Auditoría escrita: ${rutaJson}`);
}

await main();
