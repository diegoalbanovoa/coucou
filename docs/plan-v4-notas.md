# Registro de diferencias entre `handoff/plan.md` y la realidad del código

Plan v4 (ideas de OpenJarvis). Este archivo anota lo que el código real dijo distinto al plan, la línea base y los resultados de las pruebas manuales.

## Fase 0

### Línea base (corrida el 2026-10-14, rama `windows/v4` creada desde `windows/v3` en `5341eef`)

| Verificación | Resultado |
|---|---|
| `cargo test --workspace` (`windows/src-tauri`) | 152 passed, 6 ignored (paquete `coucou`); 3 passed (`coucou-hook`); 0 fallos |
| `cargo clippy --workspace --all-targets` | limpio, sin warnings |
| `npm run test` (`windows/`) | 190 passed, 0 fallos |
| `npx tsc --noEmit` | limpio |

`git status` al empezar: único elemento sin seguimiento `handoff/` (el plan y el estado; D9 = sin seguimiento). Ningún archivo modificado. El árbol cuenta como limpio.

### Las 6 discrepancias del plan, revisadas contra el código

1. **`estado-actual.md` desactualizado: confirmada.** Decía `windows/correcciones-v2`, árbol sucio, 107/179 tests. Hoy la rama es `windows/v3` (y `windows/v4` desde la Fase 0), 152 + 3 tests de cargo y 190 de npm. Se regenera en esta fase.
2. **Crate nuevo `tauri-plugin-global-shortcut = "2"`: confirmada** (`src-tauri/Cargo.toml` línea 28, con su comentario). Este plan no añade más.
3. **El chat de proveedor no recuerda la conversación: confirmada.** `providers::send` (`providers.rs`, ~línea 206) manda `"messages": [{"role": "user", "content": prompt}]`. Lo arregla la Fase 2.
4. **Tarjeta de aprobación bajo la ficha de Claude Code: confirmada.** Anotada en `quick-assistant-tools/tasks.md` 4.4 ("Known cosmetic effect"). No se toca.
5. **`healthNotify` sin efecto: confirmada.** El campo existe (`settings.rs`, `state.ts`) pero nada lo lee; `docs/plan-v2-notas.md` documenta el aviso efímero como diferido y la fila de Ajustes se quitó. Decisión D8, no se toca.
6. **Árbol limpio: verificada.** Ver arriba.

### Discrepancias nuevas halladas al leer el código

- **`src/dev/mock-bridge.ts` no implementa ningún comando de proveedor** (ni `providerSend`, ni `providerList`, ni `ollamaDetect`), aunque `bridge.ts` sí los define y la regla 7 del plan dice que el mock implementa la misma interfaz. El alias de Vite lo permite porque `tsc` no comprueba el mock contra `Bridge`. En la Fase 2 se añade solo `providerSend` (el que el plan manda cambiar); el resto queda como deuda del mock, fuera de alcance.

### Cambios de openspec: archivo

D3 = archivar, pero solo si pasan las pruebas manuales. Como siguen pendientes (A, B y C), **no se archivó nada** y los checkboxes 3.3 y 7.4 siguen sin marcar.

### Listas de prueba manual (las hace Diego; no marcadas)

Con `npm run tauri dev` o con una build de `npx tauri build`. Proveedor en la nube para la prueba B por defecto (D4): OpenRouter.

**A. agent-activity-panel 3.3**

- [ ] Con los hooks globales de `~/.claude/settings.json` activos, lanzar en este repo una sesión de Claude Code que invoque `mecanico`, `planificador` o `constructor` con la herramienta `Agent`. Abrir Sistema → "Agentes": aparece en vivo una ficha por cada `agent_type`, con su última acción y la hora, sin reiniciar Coucou.

**B. provider-chat-profiles 7.4**

- [ ] 1. Con Ollama instalado y corriendo, el selector del chat lista sus modelos. Elegir uno y chatear: la respuesta llega poco a poco.
- [ ] 2. Crear un perfil de OpenRouter con su clave. Chatear y pulsar Detener a mitad de una respuesta.
- [ ] 3. Alternar entre la CLI, Ollama y la nube: cada turno lo responde un solo backend.
- [ ] 4. Con una clave inválida aparece la tarjeta "clave inválida", traducida.
- [ ] 5. Con Ollama apagado no sale ningún error; sus modelos simplemente no aparecen.
- [ ] 6. En PowerShell, `Select-String -Path "$env:APPDATA\Coucou\*","$env:LOCALAPPDATA\Coucou\*" -Pattern "<primeros 8 caracteres de la clave>" -Recurse` no devuelve nada.

**C. quick-assistant-tools 7.4**

- [ ] 1. Registrar el atajo. Antes, registrar la misma combinación en otra app y comprobar que Coucou avisa del conflicto.
- [ ] 2. Abrir el asistente rápido desde otra app.
- [ ] 3. Aprobar y denegar al menos una vez `search_files`, `open_app` y `query_vault`.
- [ ] 4. `read_approved_folder` dentro de una carpeta permitida no muestra tarjeta.
- [ ] 5. Al pausar desde la bandeja, toda herramienta se rechaza al instante.
- [ ] 6. El registro de Ajustes muestra también lo denegado y lo rechazado.
- [ ] 7. El campo se abre siempre vacío, sin nada de la ventana que tenía el foco.

### Resultados de Diego

(pendientes: copiar aquí tal cual cuando los entregue)

### Estado de cierre de la Fase 0

Hecho: línea base, notas, listas de prueba, regeneración de `windows/_prive/estado-actual.md`, rama `windows/v4`. Pendiente de humano: pruebas A, B y C, y con ellas el marcado de `tasks.md` y el archivo de openspec.

## Fase 2

- El historial que recibe un perfil de proveedor incluye también los turnos que respondió una CLI, porque la conversación visible es una sola (D10 por defecto: 24 000 caracteres e incluirlos).
- El tipo de mensaje del chat es `ChatMessage` en `src/core/state.ts` (roles `user | assistant | error`).

## Fase 4

- **Fixture de la línea `result` de Claude Code: NO verificado contra una línea real.** El plan pide pegar una línea capturada con `claude -p "di hola" --output-format stream-json --verbose`. No se ejecutó (gasta cuota y no hubo permiso explícito de Diego). El test `the_result_line_reports_tokens_and_cost` de `agent.rs` usa la forma documentada (`usage.input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`, `total_cost_usd`). **Pendiente:** que Diego (o el constructor con su permiso) capture una línea real y reemplace la constante `RESULT_LINE`.
- **Salida de `usage` desde `agent::send`:** se eligió una función nueva `agent::send_measured(..., usage_out: &mut Usage)`; `send` la envuelve con un `Usage` descartable. Así no cambia ningún llamador existente (el comando `agent_send` usa `send_measured`; los tests de `agent.rs` siguen con `send`, que queda con `#[cfg_attr(not(test), allow(dead_code))]`). El `Result<String, String>` del comando no cambia.
- **Asistente rápido:** `quick_loop::run` ahora devuelve `Result<(String, Usage), String>`; los dos tests existentes se ajustaron. No hay streaming en esa ruta, así que su fila solo tiene latencia total (`first_text_ms` queda en `None`).
- **Reintento de `stream_options`:** `send` repite la petición una sola vez sin `stream_options` si llega 400/422 y recuerda el perfil en `NO_USAGE` (solo memoria, `OnceLock<Mutex<HashSet>>`).
- **D11:** el ledger vive solo en memoria (tope 500 turnos).
- **D12 / espacio:** medido con Playwright sobre `npm run dev:mock` a 1x y 1.5x, en en y es: "Procesos · Almacenamiento · Agentes · Uso" cabe sin cortarse (ningún segmento con `scrollWidth > clientWidth`, la barra ocupa exactamente el ancho del contenido). D12 no se activa. Las filas de la lista no desbordan; con más de 1-2 filas la lista hace scroll vertical dentro del alto fijo de 380 px de la vista Sistema (`layout.ts`), igual que la lista de procesos.
- **`npm run shots` completo no se corrió** (lento y escribe en `windows/shots/`); se usó un script equivalente en el scratchpad solo para el panel Uso.
- **Hallazgo y arreglo en el mock:** `npm run dev:mock` no cargaba desde `provider-chat-profiles` (`chat.ts` importa `providerKeyFor` y el mock no lo exportaba; tampoco tenía `providerList/Save/Delete`, `ollamaDetect`). Se añadieron solo esos mínimos (sin proveedores guardados, sin Ollama) para poder verificar la UI. Se anota que `npm run shots` llevaba roto desde v3 por esto.
- **Revisor de diseño (`coucou-design-reviewer`): NO pasado.** El constructor no puede lanzar subagentes. Revisión manual: solo tokens de `tokens.css` (`--c-label`, `--c-label-2`, `--t-footnote`, `--s-1`), sin iconos nuevos, sin `alert/confirm`, `inlineConfirm` para borrar, sin animaciones nuevas. **Pendiente:** pasar el revisor.
- **Prueba manual pendiente de Diego:** un turno con Claude Code, uno con Ollama y uno con el asistente rápido aparecen como tres filas con cifras plausibles, y la de Claude Code muestra coste.

