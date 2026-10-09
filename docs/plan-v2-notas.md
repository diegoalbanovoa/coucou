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
