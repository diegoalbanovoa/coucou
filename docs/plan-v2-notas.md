# Notas de implementación — Plan v2

Registro de diferencias entre `docs/plan-v2.md` y la realidad del código, y lo verificado al cerrar cada fase. Formato: una entrada por fase.

## Fase 0: Preparación, QA visual y agente de diseño

**Diferencia con el plan (base de la rama):** el plan dice "Base: rama `windows/agent-chat`". En la práctica, `windows/personalizacion` (fusionada y pusheada a `origin` antes de empezar este plan) ya contiene exactamente el "Estado actual" que la sección 0 describe: panel de consolas con la tarjeta "3 CONSOLES", pestaña `+` de archivos, pestaña Sistema con disco/memoria/procesos, chat ya reescrito una vez. `windows/agent-chat` es un punto anterior que no tiene nada de eso. `windows/correcciones-v2` se creó desde `windows/personalizacion`, no desde `windows/agent-chat`, porque es la que de verdad coincide con las capturas del 9 de octubre que el plan usa como referencia.

**Línea base (antes de tocar código de este plan), en `windows/correcciones-v2` recién creada desde `windows/personalizacion` (commit `ba0fe49`):**
- `cargo test --workspace`: 86 tests lib + 3 tests hook = **89 tests Rust**, 0 fallos, 6 ignorados (suite *live* opt-in).
- `cargo clippy --workspace --all-targets`: limpio, 0 warnings.
- `npm run test`: **121 tests TS**, 0 fallos.
- `npx tsc --noEmit`: limpio.

Pendiente de esta fase: modo mock (`src/dev/mock-bridge.ts` + fixtures), capturas automáticas (Playwright + `scripts/shots.mjs`), investigación/instalación de HIG Doctor a nivel de usuario, y el subagente `.claude/agents/coucou-design-reviewer.md`.

**Modo mock — cómo quedó resuelto:** `vite.config.ts` alias `*/core/bridge` → `src/dev/mock-bridge.ts` solo bajo `--mode mock` (regex sobre la cantidad de `../`, nunca sobre `mock-bridge.ts` consigo mismo — ese archivo no importa `"../core/bridge"` para no entrar en su propio alias). Todo lo demás (`island.ts`, `agent.ts`, `hooks.ts`, `chat.ts`, `consoles.ts`, `settings/main.ts`...) sigue importando `../core/bridge` sin saber que el modo mock existe. `IS_TAURI` se exporta como `false` desde el mock, así que la isla se revela igual que en `npm run dev` normal: hay que esperar ~7 s a que termine el saludo de arranque (se colapsa a la píldora compacta) y hacer clic sobre `#island` para expandirla — no hace falta simular el hover exacto del wake-strip.

**Fixtures — un hallazgo real, no solo cosmético:** con los 8 procesos de la fixture (`fixtures/system.ts`), la tarjeta de Sistema ya corta por completo el checklist de limpieza y los botones "Look for what can go"/"Delete" — quedan fuera del área visible de la tarjeta, no solo `claude.exe ×3` sin agrupar como decía el plan. Confirma que la Fase 6 no es solo una cuestión de UX sino también de overflow real. `scripts/shots.mjs` marca `system-cleanup` como no listo (`ready:false`) en vez de fingir una captura útil, porque alcanzar esos botones requeriría hacer scroll dentro de una tarjeta que la Fase 6 va a rediseñar de raíz — no vale la pena automatizar el scroll de un layout que va a desaparecer.

**Sesiones en vivo — límite real del modelo de datos actual:** `hooks.ts` solo guarda nombre/carpeta/terminal del *último* evento en la única tarea `integration_claude` — no hay manera de representar dos sesiones de Claude Code a la vez con los datos de hoy. El fixture `MOCK_LIVE_SESSIONS` trae dos entradas, pero `mock-bridge.ts` solo aplica la primera. Mostrar "2 sesiones en vivo" de verdad (como pide 3.5, detalle de consola) necesita un cambio de modelo en la Fase 3, no es un bug del mock.

**`.claude/` y el subagente:** el `.gitignore` raíz excluye `.claude/` entero ("Local only (never published)"). El plan pide que `coucou-design-reviewer.md` sí viva en el repo. Se resolvió con la excepción estándar de git (`.claude/*` + `!.claude/agents/` + `!.claude/agents/coucou-design-reviewer.md`) en vez de sacar todo `.claude/` del ignore — el resto de `.claude/` (settings locales, etc.) sigue sin publicarse.

**HIG Doctor:** no se instaló. Es una herramienta de terceros (`npx hig-doctor`) cuya existencia y comportamiento exacto el plan no pudo verificar de antemano ("**VERIFICAR** que la CLI analiza TS y CSS"); instalarla a ciegas antes de tener algo que auditar (no hay cambios de diseño todavía — eso empieza en la Fase 1) no aporta nada ahora. Queda para el arranque de la Fase 1, cuando sí haya `tokens.css` y componentes que revisar. El subagente propio (`.claude/agents/coucou-design-reviewer.md`) no depende de que exista.

**Playwright:** version fijada en `1.55.1` (no la primera que se instaló, `1.49.1` — esa tenía un aviso de seguridad alto sobre verificación de certificado al descargar navegadores, `GHSA-7mvr-c777-76hp`; `npm audit` quedó en una sola vulnerabilidad alta preexistente, en `source-map-js` vía la cadena de Vite→postcss, sin relación con este plan).

**`scripts/shots.mjs` — lección operativa:** la primera versión mataba el servidor `vite --mode mock` con `child.kill()`, que en Windows solo llega al proceso `npx` inmediato — el `node vite.js` real queda huérfano reteniendo el puerto 1420. Arreglado con `taskkill /PID <pid> /T /F` (todo el árbol) en vez de la señal. Verificado corriendo el script dos veces seguidas sin que quedara nada vivo entre una corrida y otra.

**Resultado final de la Fase 0, en verde:**
- `npm run dev:mock` muestra la isla con datos falsos en las 4 vistas (home/consoles, home/services, chat, system) y en la ventana de Ajustes — verificado visualmente.
- `npm run shots`: 34 capturas generadas, 28 omitidas con nota explícita (estados de fases 3, 4, 5 y 7 que todavía no tienen UI que fotografiar) — sin errores, dos corridas seguidas sin procesos huérfanos.
- `tests/mock-not-in-build.test.mjs`: build real de producción, cero rastro de `mock-bridge` o `[mock]` en `dist/`.
- `cargo test --workspace`: 89 (sin cambios — esta fase no tocó Rust).
- `cargo clippy --workspace --all-targets`: limpio.
- `npm run test`: **123 tests** (121 + 2 nuevos de esta fase).
- `npx tsc --noEmit`: limpio.

## Fase 1: Sistema de diseño "Coucou HIG"

**`tokens.css` — dónde se importa:** el plan no especifica el mecanismo. Se resolvió con `@import url(...)` como primera línea de `style.css` y de `settings/settings.css` (cada uno con su ruta relativa correcta), en vez de un `import` JS en `main.ts`/`settings/main.ts` — más simple y symmétrico con cómo esos dos archivos ya cargan su propio CSS.

**Ajustes NO es una ventana clara** (el plan pedía **VERIFICAR**): `settings.css` ya tenía `color-scheme: dark` y `--bg:#0b0c0e` antes de este plan. No existe variante `[data-surface="settings"]` porque no hace falta — ambas ventanas son oscuras.

**Alias de variables — más conservador de lo que el plan sugiere:** "Las variables actuales (--card, --ink, --indigo, …) pasan a ser alias de las nuevas" se leyó primero como "alias todo lo que se pueda", incluidos `--red→--c-red`, `--green→--c-green`, `--amber→--c-orange`. Se revirtió: esos tokens iOS tienen un hex **distinto** del valor actual (p. ej. `--c-red:#ff453a` vs `--red:#f4505e` de hoy), así que aliasearlos habría cambiado el color de cada botón/badge existente sin que ninguna fase lo haya pedido todavía. Solo se aliasearon `--card`, `--ink` e `--indigo`, los tres que **sí** tienen el mismo hex en ambos lados (confirmado dígito por dígito). El resto migra cuando la fase que rediseña esa vista llegue.

**`tile()` — extraído de `views/views.ts`, no de `views/integrations.ts`:** el plan dice "extraído de integrations.ts" en el párrafo 3.1, pero la ficha de servicios (`.pill`, con la carita y el badge) vive en `buildPill()` dentro de `views/views.ts` — `integrations.ts` es la tarjeta de detalle (emails, deployments…), un componente totalmente distinto. Extraído a `src/ui/tile.ts` sin cambiar el DOM ni el CSS; `views.ts` ahora llama a `tile()`. Verificado con una captura `?pane=services` antes/después, pixel a pixel por inspección visual — idéntica.

**Lint de "sin hex fuera de tokens.css" — acotado a lo que Fase 1 construyó, no a todo el código:** al escribir el test se descubrió que `core/layout.ts`, `core/state.ts`, `island/hooks.ts`, `settings/main.ts`, `upload/canvas.ts`, `views/integrations.ts`, `views/ticker.ts` y `views/views.ts` tienen decenas de colores hex literales preexistentes (colores de marca de integraciones, outfits de Mochi, badges) — nada de esto lo tocó esta fase. Un test que exigiera cero hex en *todo* `src/` habría fallado el primer día contra código que nadie ha tocado todavía, lo cual lo vuelve ruido en vez de una puerta útil. `tests/design-tokens.test.mjs` solo vigila `src/ui/` y `src/styles/` — la superficie que esta fase sí construyó — con una única excepción documentada: los 3 colores de badge en `ui/tile.ts`, copiados tal cual de `buildPill()` para no romper el pixel-parity. El resto del código se irá acotando archivo por archivo en cada fase que lo rediseñe.

**Dos variables CSS huérfanas encontradas, preexistentes y ajenas a este plan:** `--ink-1` y `--ink-3` se usan en `style.css` (líneas ~793-856) pero nunca se declaran en ningún `:root` — parece un typo de antes de este plan (¿por `--ink`/`--ink-2`?) que deja esas reglas de `color` silenciosamente sin efecto. No se tocó: arreglarlo sería meterse en código que ninguna fase ha pedido rediseñar todavía. Documentado como excepción conocida en `tests/design-tokens.test.mjs` en vez de ignorado en silencio.

**Iconos añadidos (1.3):** `chevronDown`, `paperclip`, `globe`, `lock`, `thermometer`, `heartPulse`, `code`, `pdf`. `arrow-up` (enviar), `stop` y `chevron-left`, que el plan también pedía, ya existían de la Fase 2 del plan anterior.

**Componentes base construidos, ninguno usado todavía:** `button`, `iconButton`, `chip`, `listRow`, `segmented`, `gauge`, `inlineConfirm`, `sheet`, `toast`, `pushNav` en `src/ui/`. Nada los llama todavía — eso empieza en las Fases 3-7. `inlineConfirm` con confirmación destructiva enfoca por defecto el botón "No" (Never mind), no el de confirmar, para que un Enter perdido nunca sea el que borra algo — el plan no lo especifica, pero es la lectura obvia de "nunca alert/confirm" aplicada a quién recibe el foco inicial.

**Resultado final de la Fase 1, en verde:**
- Captura `?pane=services` antes/después: idéntica (inspección visual, no hay diff automatizado de píxeles en el repo todavía).
- `tests/design-tokens.test.mjs` (nuevo): toda variable CSS usada está declarada en algún lado; `src/ui/` y `src/styles/` sin hex fuera de la excepción documentada.
- `tests/gauge.test.mjs` (nuevo): umbrales de color de `toneFor()` — carga (CPU/memoria) ámbar a 70%, rojo a 85%; disco ámbar a 90%, rojo a 95%.
- `cargo test --workspace` / `cargo clippy`: sin cambios (89 tests, limpio) — esta fase no tocó Rust.
- `npm run test`: **128 tests** (123 + 5 nuevos).
- `npx tsc --noEmit`: limpio.

## Fase 2: Idiomas (inglés y español)

**Alcance real, mucho mayor que el diccionario del plan:** la sección 2.5 del plan da unas 90 claves, pensadas para la UI que las fases 3-7 todavía van a construir. La UI que **ya existe hoy** tiene su propio conjunto de ~150 cadenas (settings/main.ts solo ya tenía ~60), con texto que no coincide literalmente con lo que el plan anticipaba — p. ej. el tooltip real de la pestaña "Inicio" dice hoy "Overview", no "Home"; el de "Chat" dice "Ask", no "Chat". Se tradujo el texto **real** (sin renombrar nada que esta fase no pidió cambiar) y se amplió el diccionario con todas las claves que hicieron falta además de las del plan — quedó documentado en los propios comentarios de `en.ts` cuándo una clave no coincide con el texto "final" que el plan sugiere.

**El reto real de esta fase no fue traducir — fue hacer que la traducción se vea sin reiniciar.** La mayoría de las vistas (`views.ts`, `chat.ts`, `system.ts`) construyen sus botones y etiquetas **una sola vez**, al crear la vista, y el patrón de la app ya existente para evitar trabajo de más es un `if (key === cached) return;` al principio de `sync()`. Ninguna de esas claves de caché incluía el idioma, así que cambiar el idioma con el chat ya abierto no habría movido ni una letra hasta que algo *más* cambiara. Se resolvió añadiendo `getLocale()` a cada una de esas claves de caché (`consoles.ts`, `views.ts`'s `cardKey`, `chat.ts`'s `shotKey`/`renderedCount`/`renderedDraft`), y en los tres sitios donde un conjunto de botones se construye una única vez de verdad fuera de `sync()` (los botones Allow/Deny de aprobación, Retry/"Open in n8n" de error, "Open terminal"/OK de turno terminado) se cambió el guard de "construido una vez" (`if (built) return`) por "construido para este idioma" (`if (builtFor === getLocale()) return`) — construir de nuevo solo pasa cuando cambia el idioma, nunca en un `sync()` normal, así que el riesgo original que ese guard evitaba (reconstruir el botón entre un mouse-down y un mouse-up) sigue evitado.

**`system.ts` y `buildConfused`/`buildPlaceholder` tenían un `sync()` que literalmente no hacía nada** ("Nothing to do here: the numbers come from the poll"). Se les dio contenido real: comparan el idioma actual contra el último mostrado y, si cambió, vuelven a pintar.

**Dos cadenas que mi primer barrido con grep no encontró:** `island/agent.ts`'s `providerLabel()` devuelve "No agent CLI found" / "Pick an agent" con un `return "..."` directo, sin pasar por `text:`/`title:`/`.textContent =` — el patrón que estaba usando para buscar. Encontrado al revisar `island/*.ts` con un patrón distinto (`return "[A-Za-z]`) antes de dar la Fase 2 por cerrada. `search.ts`'s `counter()` tenía lo mismo con `"none"`.

**`fmtBytes` usa binario (1024), no decimal (1000), aunque el ejemplo del plan (`fmtBytes(9.8e9) → "9.8 GB"`) solo cuadra en decimal:** `views/system.ts`'s `size()` ya existente usa 1024 y tiene su propia suite de tests — introducir una segunda convención de "GB" en la misma app (una decimal, otra binaria) habría sido confuso de verdad, no un detalle. `fmtBytes` quedó en 1024 para que, cuando una fase futura junte ambas funciones, "GB" siga significando lo mismo en todas partes. El test de `i18n.test.mjs` usa `9.8 × 1024³` en vez del `9.8e9` literal del plan, documentado en el propio test.

**`timeAgo()` (en `integrations.ts`) no se tradujo del todo a propósito:** el formato compacto `{n}m`/`{n}h`/`{n}d` se deja igual en los dos idiomas — es la abreviatura que ya usan apps en español para lo mismo, y traducirla no habría ganado nada. Solo "just now" (→ "ahora mismo") pasa por `t()`. Donde el código SÍ construye una frase completa ("{time} ago" → "hace {time}"), se corrigió el orden de palabras: el inglés pone "ago" al final, el español pone "hace" al principio — una concatenación ingenua de sufijo nunca iba a funcionar en español, así que la clave es una plantilla con `{time}` en el medio, no un sufijo.

**Rust: nada de `sys-locale` ni ningún otro crate nuevo** (prohibido por la regla 1). `platform::system_locale()` se implementó con `GetUserDefaultLocaleName` (Windows, activando la *feature* `Win32_Globalization` ya permitida por la regla 1) y `$LC_ALL`/`$LC_MESSAGES`/`$LANG` (Linux) — ambas sin dependencias nuevas. `src-tauri/src/i18n.rs` es deliberadamente pequeño: solo las 4 etiquetas del menú de la bandeja, porque es lo único que Rust dibuja directamente hoy (ni el selector de carpetas ni el de archivos tienen un título propio que cambiar).

**`scripts/shots.mjs` tenía su propio bug de i18n:** usaba los tooltips en inglés ("Ask", "System"...) como selector para hacer clic en cada pestaña — escrito en la Fase 0, antes de que esos tooltips fueran texto traducible. En las corridas `?lang=es` el clic fallaba (`TimeoutError` esperando `button[title="Ask"]`, que ahora dice "Preguntar"). `TABS` pasó a ser un mapa por idioma (`TABS[lang][view]`). Verificado sin procesos huérfanos tras el *crash* — el bloque `finally` de `killTree()` corrió igual aunque el script terminara con una excepción sin capturar.

**Verificado visualmente (mock, `?lang=es`):** overview ("4 CONSOLAS", "transmite", "se aprueba aquí"), Sistema ("9.0 GB libres", "Memoria", "LO QUE MÁS MEMORIA USA"), chat ("Continuar…"), y Ajustes completo incluido el propio selector de idioma funcionando ("Se encontraron 4" — plural correcto). Capturas en `shots/` vía `npm run shots`, que ya corría en/es desde la Fase 0.

**Resultado final de la Fase 2, en verde:**
- `tests/i18n.test.mjs` (nuevo, 7 tests): paridad de claves en/es, sin cadenas vacías, `{placeholders}` coinciden, `fmtBytes`/`fmtPercent`/`tn()`.
- `tests/no-hardcoded-strings.test.mjs` (nuevo): cero cadenas literales fuera de la lista blanca de nombres propios en `src/views`, `src/settings`, `src/island` — verificado que de verdad detecta algo inyectando una cadena de prueba antes de confirmar en verde.
- `cargo test --workspace`: **91 tests** (89 + 2 de `i18n.rs`).
- `cargo clippy --workspace --all-targets`: limpio.
- `npm run test`: **136 tests** (128 + 8).
- `npx tsc --noEmit`: limpio.
- `npm run shots`: regenerado completo tras esta fase.
- `npm run shots`: regenerado completo tras esta fase, sin errores.
