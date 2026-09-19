# Extractor curricular — Currículo V1-B-2

Herramienta administrativa/offline. **No forma parte del runtime web de
Docente IA** (Next.js/Node) y no se ejecuta nunca desde `app/`.

## Por qué Python en vez de TypeScript/Node

El repositorio ya tiene `pdf-parse` (extracción de texto lineal) y `pdf-lib`
(generación/manipulación de PDF) como dependencias del runtime Node. Ninguna
de las dos ofrece extracción **consciente de geometría** (coordenadas x/y por
palabra, detección de tablas por posición) — que es justamente lo que este
trabajo requiere: el Programa Sintético de Fase 4 usa una tabla real de 3
columnas (Contenido | PDA 3° | PDA 4°) que la extracción lineal simple
entremezcla (confirmado empíricamente en la ronda de inspección anterior).

`pdfplumber` sí ofrece esto (`find_tables()`, `extract_words()` con
posición) y ya se validó contra el PDF real. No existe un equivalente maduro
y ya integrado en el toolchain Node de este proyecto. Como esta extracción
es una operación **administrativa, offline, de una sola vez por documento
oficial** — nunca se llama desde una ruta de la app ni desde un flujo de
usuario — no hay ninguna razón para forzarla a Node solo por consistencia de
lenguaje, y sí una razón real para NO agregar esta dependencia al bundle/
runtime de la aplicación.

**Separación explícita:** `package.json` (raíz del proyecto) no se toca.
Este directorio tiene su propio `requirements.txt` y se ejecuta en un
entorno virtual de Python aislado, nunca desde `npm run` ni desde ninguna
ruta de la app.

## Instalación (entorno aislado, no afecta el proyecto Node)

```bash
cd scripts/curriculo-ingesta
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
```

## Uso

```bash
./.venv/bin/python3 extractor.py --pdf /ruta/al/PDF/oficial.pdf --salida /ruta/de/salida.json
```

El PDF de entrada y el JSON de salida **nunca se commitean al repositorio**
— son artefactos de ejecución (fuente oficial descargada localmente, salida
temporal para revisión) y viven fuera del árbol de git. Este directorio solo
contiene el código del extractor.

## Alcance de esta microfase (V1-B-2)

Produce una estructura JSON en memoria/archivo temporal — **no inserta nada
en Supabase**, ni en `ingesta_curricular`/`ingesta_curricular_candidato` ni
en las 11 tablas canónicas de V1-A. Esa transformación (JSON → candidatos de
staging) es una microfase posterior (V1-B-3).

0 llamadas a IA. 0 OCR. Extracción y clasificación CONFIRMADO/DUDOSO
enteramente deterministas, basadas en geometría del documento.

## Perfiles de extracción

`perfiles.py` describe el formato documental observado (rangos de página por
campo, mapeo de columna→grado, encabezados esperados) como **datos de
configuración**, no como lógica dispersa en el código — el perfil actual
(`PERFIL_PROGRAMA_SINTETICO_FASE4_2024`) es específico de la edición 2024 del
Programa Sintético de Fase 4. Un documento de otra fase/edición requiere su
propio perfil nuevo (page ranges y encabezados propios), no un cambio al
motor de extracción.
