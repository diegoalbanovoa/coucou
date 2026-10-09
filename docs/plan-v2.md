# Plan v2: correcciones de Coucou para Windows

**Para:** la IA que va a implementar esto (Claude Code u otra) dentro del repo `coucou`.
**Base:** rama `windows/agent-chat`. Trabajar en una rama nueva: `windows/correcciones-v2`.
**Stack:** Tauri 2 · backend Rust · webview TypeScript **sin framework** (DOM a mano con el helper de 5 funciones) · 1 sola dependencia npm de runtime.
**Fecha:** 9 oct 2026.

> Lee el documento completo antes de escribir código. Ejecuta las fases **en orden**. Cada fase termina con sus pruebas de aceptación en verde y un commit propio. Si la realidad del código difiere de lo que aquí se asume (marcado **VERIFICAR**), adapta lo mínimo necesario y anota la diferencia en `docs/plan-v2-notas.md`. No inventes alcance nuevo.

---

## 0. Qué se pide (fuente: el dueño del proyecto)

| # | Pedido | Fase |
|---|---|---|
| 1 | El panel de **consolas** debe verse **igual que el de integraciones** (rejilla de fichas con la carita de color) | 3 |
| 2 | **Idiomas**: inglés y español, por ahora | 2 |
| 3 | El **chat** quedó mal: **se sale de la pantalla** y está mal personalizado. Rediseñarlo | 4 |
| 4 | Usar un **agente de diseño estilo iOS** para guiar el diseño | 0 y 1 |
| 5 | La parte de **archivos** (pestaña `+`) debe ir **embebida en el chat** | 5 |
| 6 | La pestaña de **memoria y disco** necesita un mejor diseño de UX/UI | 6 |
| 7 | **Mochi se ve enfermo** cuando el equipo supera el **70 %** de su capacidad, con animaciones | 7 |

### Estado actual (según las capturas del 9 oct)

- **Barra superior:** Inicio · Chat · `+` (archivos) · Sistema (icono de disco). A la derecha, Ajustes y Sonido.
- **Inicio → tarjeta derecha (Servicios):** rejilla 2×2 de fichas. Cada ficha tiene una carita de color con dos ojos y el nombre: n8n (naranja), Vercel (morado), GitHub (rojo), Stripe (azul). **Esta es la referencia visual.**
- **Inicio → tarjeta derecha (Consolas):** cabecera "3 CONSOLES", una tarjeta grande "Claude Code 2.1.241 (Claude Code)" con chips "streams" y "approvable here" que **se cortan**, y la sección "RUNNING NOW · coucou · Windows Terminal". No sigue el estilo de los servicios.
- **Chat:** la cabecera tiene "Claude Code", "Attach project…", lupa y `>`. Mochi ocupa una columna izquierda de unos 100 px. El panel **se sale por abajo de la pantalla** y no se ve el compositor. Además hay un brillo morado abajo.
- **`+`:** "Drop your files here" con los chips PDF · Images · Code · Docs, en una vista aparte.
- **Sistema:** barra de C: (naranja, "51 GB free"), barra de memoria (verde, "9.8 GB of 15 GB"), enlace "Open Windows Disk Cleanup" y la lista "USING THE MOST MEMORY" con procesos repetidos (`claude.exe` ×3) y una × sin confirmación visible.

---

## 1. Reglas globales (aplican a todas las fases)

1. **Dependencias:** ninguna dependencia **npm de runtime** nueva. Se permiten devDependencies solo para QA (Playwright, Fase 0). En Rust, ningún crate nuevo; sí se permite activar *features* Win32 del crate de Windows que ya usa `platform/windows.rs`. **VERIFICAR** si es `windows` o `windows-sys`.
2. **Textos:** toda cadena visible pasa por `t()` (Fase 2). Cero literales de UI en `src/views`, `src/settings`, `src/island` ni en `tray.rs`.
3. **Colores, tipografía, espacios y radios:** solo con *tokens* (Fase 1). Nada de hex sueltos en CSS ni en TS, excepto en `tokens.css` y en la paleta de Mochi.
4. **Iconos:** solo con `icon()` (SVG propios, 24×24, `currentColor`). **Prohibido usar SF Symbols ni la fuente SF Pro**: su licencia los restringe a plataformas Apple. El estilo "iOS" se imita, no se copia.
5. **Ventanas:** nada de `alert`, `confirm` ni `prompt`. Las confirmaciones son en línea (*inline*), dentro de la isla.
6. **La isla es una ventana del tamaño de su contenido.** Todo popover, *sheet* o panel debe caber en la altura que calcula `core/layout.ts` y se aplica con `set_island_rect`. Nada puede pintarse fuera de esa altura.
7. **El webview nunca toca rutas, claves ni procesos.** Todo pasa por comandos Tauri tipados en `core/bridge.ts`.
8. **Movimiento:** toda animación respeta `prefers-reduced-motion: reduce` (queda solo un fundido o un estado estático).
9. **Calidad:** al final de cada fase, `cargo test`, `cargo clippy --all-targets`, `npm run test` y `tsc --noEmit` deben quedar limpios. Los tests existentes (161 o más) siguen en verde.
10. **Revisión de diseño:** al terminar cada fase de UI (1, 3, 4, 5, 6 y 7), invocar el subagente `coucou-design-reviewer` (Anexo A) y corregir todo lo que marque como **Alta**.
11. **Commits:** uno por fase como mínimo, con mensaje en español: `fase N: <resumen>`.
12. **Consumo:** con la isla colapsada y el monitor de salud activo, el uso de CPU de Coucou en reposo debe quedar **por debajo de 0,5 %** (se mide en la Fase 8). Cada frame de animación de Mochi debe costar **menos de 4 ms**.

---

## Fase 0: Preparación, QA visual y agente de diseño

### 0.1 Rama y línea base
- `git switch -c windows/correcciones-v2`
- Copiar este documento a `docs/plan-v2.md` (el subagente revisor lo lee de ahí).
- Correr las 4 verificaciones y guardar el número de tests en `docs/plan-v2-notas.md`.

### 0.2 Modo *mock* para ver la UI sin Tauri (imprescindible para QA)
Objetivo: poder abrir la isla en un navegador normal con datos falsos y sacar capturas automáticas.

- `src/dev/mock-bridge.ts`: implementa la **misma interfaz** que `core/bridge.ts` (todos los comandos y eventos) con datos de `src/dev/fixtures/`:
  - `consoles.ts`: Claude Code (verificado, 2 sesiones en vivo), Gemini, Codex, Copilot (sin verificar) y PowerShell.
  - `integrations.ts`: n8n, Vercel, GitHub y Stripe.
  - `chat.ts`: 25 mensajes, con uno de 20 000 caracteres, bloques de código, una lista, una tabla, pasos de herramientas y un error.
  - `system.ts`: tres escenarios: `ok` (CPU 18 %, RAM 45 %), `strained` (RAM 76 %) y `sick` (CPU 91 %, RAM 88 %). Más una lista de 14 procesos con repetidos y 2 unidades de disco.
- Activación: `npm run dev:mock`, un script de Vite con `--mode mock`. En modo mock, `bridge.ts` exporta el mock. **El mock nunca entra en el build de producción**: comprobarlo con un test que busque `mock-bridge` en `dist/`.
- Parámetros de URL del modo mock: `?view=home|chat|system|settings`, `?pane=consoles|services`, `?scenario=ok|strained|sick`, `?lang=en|es`, `?state=drop|search|attachments|cleanup|console-detail`.

### 0.3 Capturas automáticas
- devDependency: `@playwright/test` con una versión fija.
- `scripts/shots.mjs` levanta `dev:mock` y saca PNG de cada combinación de la tabla a `shots/` (añadir `shots/` a `.gitignore`):

| Vista | Estados | Idiomas | Escala |
|---|---|---|---|
| home | consoles, services, console-detail | en, es | 1, 1.5, 2 |
| chat | vacío, largo, search, drop, attachments, streaming | en, es | 1, 1.5 |
| system | ok, strained, sick, cleanup | en, es | 1, 1.5 |
| settings | general, salud | en, es | 1 |
| mochi-gallery | todos los ánimos, en t=0 y t=1 s | — | 2 |

- Script: `npm run shots`.

### 0.4 Agente de diseño estilo iOS (investigación hecha)

| Opción | Qué es | Encaje con Coucou | Licencia |
|---|---|---|---|
| **HIG Doctor** (`raintree-technology/apple-hig-skills`) | CLI + servidor MCP + 14 skills (`hig-foundations`, `hig-components-*`, …). Audita código contra el Apple HIG **y también código web y multiplataforma** (431 reglas) | **El mejor**: sirve para auditar TS y CSS | MIT la herramienta. El texto del HIG en `references/` es © Apple |
| **apple-hig-expert** (`borghei/Claude-Skills`) | Skill asesor del HIG: tipografía, colores semánticos, rejilla de 4/8, objetivos ≥44 pt, movimiento reducido, accesibilidad | Bueno como criterio | Sin licencia declarada (NOASSERTION) |
| **mobile-ios-design** (`wshobson/agents`) | Skill de HIG + SwiftUI: claridad, deferencia, profundidad | Principios útiles; el código es SwiftUI, no aplica | MIT |

**Decisión:**
1. Instalar HIG Doctor **a nivel de usuario**, no dentro del repo, para no meter texto © Apple en un proyecto MIT:
   - CLI: `npx hig-doctor .`
   - MCP (opcional): `npx -y hig-mcp`, configurado según su README.
   - **VERIFICAR** que la CLI analiza TS y CSS. Si no lo hace, usarla solo como consulta de reglas.
2. **No** copiar contenido de esas skills al repo.
3. Crear el subagente propio `.claude/agents/coucou-design-reviewer.md` con el contenido del **Anexo A**. Este sí va al repo, porque codifica **nuestro** sistema de diseño (Fase 1) y usa HIG Doctor como segunda opinión.
4. Al auditar, **ignorar reglas exclusivas de iPhone** que no aplican a una isla de escritorio en Windows: barra de pestañas abajo, *safe areas*, Dynamic Type, hápticos.

### Aceptación de la Fase 0
- `npm run dev:mock` muestra la isla en el navegador con datos falsos en las 4 vistas.
- `npm run shots` genera todas las capturas sin errores.
- El subagente responde con el formato del Anexo A al pedirle "revisa src/views/chat.ts".

---

## Fase 1: Sistema de diseño "Coucou HIG"

Inspirado en el Apple HIG (claridad, deferencia, profundidad; rejilla de 4 pt; colores semánticos; materiales translúcidos; movimiento con muelles) y adaptado a una isla oscura de escritorio en Windows.

### 1.1 Tokens: `src/styles/tokens.css` (nuevo, se importa primero)

```css
:root {
  /* Superficies (la isla es siempre oscura, como una Dynamic Island) */
  --c-island: #000000;
  --c-surface-1: #141518;            /* = --card actual */
  --c-surface-2: #1c1d21;
  --c-surface-3: #26272c;
  --c-fill: rgba(120, 120, 128, 0.24);
  --c-fill-2: rgba(120, 120, 128, 0.14);
  --c-separator: rgba(255, 255, 255, 0.08);

  /* Texto */
  --c-label: #f5f6f8;                /* = --ink actual */
  --c-label-2: rgba(235, 235, 245, 0.62);
  --c-label-3: rgba(235, 235, 245, 0.32);

  /* Acento y colores de sistema (variantes oscuras de iOS) */
  --c-accent: #6366f1;               /* = --indigo actual */
  --c-accent-press: #4f46e5;
  --c-on-accent: #ffffff;
  --c-green: #30d158;
  --c-orange: #ff9f0a;
  --c-red: #ff453a;
  --c-blue: #0a84ff;
  --c-yellow: #ffd60a;
  --c-purple: #bf5af2;
  --c-teal: #40c8e0;

  /* Material "vidrio" (overlays, sheets, compositor, buscador) */
  --c-glass: rgba(28, 29, 33, 0.72);
  --c-glass-border: rgba(255, 255, 255, 0.10);
  --c-glass-highlight: rgba(255, 255, 255, 0.06);
  --glass-blur: blur(20px) saturate(160%);

  /* Tipografía: Segoe UI Variable en Windows; jamás SF Pro */
  --font-ui: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
  --font-display: "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif;
  --font-mono: "Cascadia Code", "Cascadia Mono", Consolas, ui-monospace, monospace;
  --t-caption2: 500 10px/13px var(--font-ui);
  --t-caption: 600 11px/14px var(--font-ui);     /* etiquetas de sección MAYÚSCULAS, tracking 0.06em */
  --t-footnote: 400 12px/16px var(--font-ui);
  --t-subhead: 500 13px/18px var(--font-ui);
  --t-body: 400 14px/21px var(--font-ui);
  --t-headline: 600 14px/20px var(--font-ui);
  --t-title3: 600 16px/22px var(--font-display);
  --t-title2: 700 20px/24px var(--font-display);  /* cifras de los gauges, tabular-nums */
  --t-code: 400 12.5px/19px var(--font-mono);

  /* Espacio (rejilla de 4) */
  --s-1: 4px; --s-2: 8px; --s-3: 12px; --s-4: 16px; --s-5: 20px; --s-6: 24px; --s-8: 32px;

  /* Radios (regla concéntrica: radio interior = radio exterior − padding) */
  --r-xs: 6px; --r-sm: 8px; --r-md: 12px; --r-lg: 16px; --r-xl: 20px; --r-pill: 999px;

  /* Movimiento */
  --d-fast: 120ms; --d-base: 220ms; --d-slow: 360ms;
  --ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);

  /* Elevación */
  --shadow-pop: 0 8px 24px rgba(0, 0, 0, 0.45);

  /* Interacción */
  --hit-min: 32px;          /* objetivo mínimo con puntero */
  --hit-primary: 40px;      /* acciones primarias */
  --focus-ring: 0 0 0 2px var(--c-island), 0 0 0 4px var(--c-accent);
}

@media (prefers-reduced-motion: reduce) {
  :root { --d-fast: 0ms; --d-base: 0ms; --d-slow: 0ms; }
}
```

- Las variables actuales (`--card`, `--ink`, `--indigo`, …) pasan a ser **alias** de las nuevas, para no romper el CSS existente. Migrar el resto del CSS a los tokens nuevos dentro de cada fase que toque ese archivo.
- **VERIFICAR** si la ventana de Ajustes es clara. Si lo es, crear el bloque `[data-surface="settings"]` con la versión clara de `--c-surface-*`, `--c-label-*` y `--c-separator`. La isla queda siempre oscura.
- Cifras (GB, %, MB): `font-variant-numeric: tabular-nums` siempre.

### 1.2 Componentes base: `src/ui/` (nuevo)

Todos son funciones que devuelven nodos del DOM con el helper existente, con estilos en `src/ui/ui.css`.

| Componente | Firma | Notas |
|---|---|---|
| `tile` | `tile({face, name, state, badge?, onSelect, onDetail})` | **Extraído de `views/integrations.ts` sin cambiar ni un píxel** (ver 3.1) |
| `segmented` | `segmented({items, value, onChange, size: 'sm'\|'md'})` | Control segmentado estilo iOS: fondo `--c-fill`, segmento activo `--c-surface-3` con `--shadow-pop` suave y movimiento `--d-base`. `sm` = 20 px de alto, `md` = 28 px. Flechas ←/→ para navegar |
| `button` | `button({label?, icon?, variant: 'primary'\|'secondary'\|'plain'\|'destructive', size})` | Alto mínimo `--hit-min`. Estados hover (+6 % de luz), pressed (escala 0.97), focus (`--focus-ring`) y disabled (40 % de opacidad) |
| `iconButton` | `iconButton({icon, label, onClick})` | 32×32, glifo de 16 px, `aria-label` obligatorio con `t()` |
| `chip` | `chip({label, icon?, tone})` | Alto 20 px, radio `--r-pill`, `--t-caption2` |
| `gauge` | `gauge({value, label, detail, tone})` | Anillo SVG, ver 6.3 |
| `listRow` | `listRow({leading, title, subtitle?, trailing, onClick?})` | Alto 32 px, separador interior desde el texto, como las listas de iOS |
| `inlineConfirm` | `inlineConfirm({message, confirmLabel, onConfirm, onCancel, destructive})` | Sustituye al contenido de una fila; Esc cancela |
| `sheet` | `sheet({title, body, footer, onClose})` | Sube desde abajo **dentro del área de la vista**, material vidrio, radio superior `--r-lg` y botón "Listo" o "Cancelar" |
| `toast` | `toast({message, tone, action?})` | Píldora de vidrio arriba del contenido, 2,5 s, con `aria-live="polite"` |
| `push` | `pushNav(container)` | Navegación con "‹ Atrás" dentro de una tarjeta, como `NavigationStack`: desliza 24 px con fundido, `--d-base` |

### 1.3 Iconos
Revisar el set SVG existente (Fase 2 del plan anterior) y completarlo con: `paperclip`, `arrow-up` (enviar), `stop`, `chevron-left`, `chevron-down`, `ellipsis`, `globe` (idioma), `cpu`, `memory`, `drive`, `broom` (limpiar), `lock`, `thermometer`, `heart-pulse` (salud), `doc`, `image`, `code`, `pdf`. Mismo estilo: trazo de 1.75, puntas redondeadas, `viewBox="0 0 24 24"` y `currentColor`.

### Aceptación de la Fase 1
- Test `node --test`: `tokens.css` define todas las variables usadas en el código. Hay que buscar `var\(--[a-z0-9-]+\)` en `src/` y comprobar que cada una existe.
- Test: ningún `.css` ni `.ts` fuera de `tokens.css` y `mochi/` contiene `#[0-9a-f]{3,8}`. Se permite una lista blanca de colores de marca, ver 3.2.
- Las capturas de **servicios** son idénticas a las de la línea base (diferencia de píxeles por debajo del 0,5 %).

---

## Fase 2: Idiomas (inglés y español)

### 2.1 Módulo `src/i18n/` (nuevo, sin dependencias)
- `en.ts`: **fuente de verdad**, `export const en = { … } as const`, anidado por área (`tabs`, `home`, `consoles`, `chat`, `files`, `system`, `health`, `settings`, `common`).
- `es.ts`: `export const es: Messages = { … }`, donde `type Messages = DeepStrings<typeof en>`. Así TypeScript **falla** si falta o sobra una clave.
- `index.ts`:
  - `type Locale = 'en' | 'es'`
  - `t(key: MessageKey, params?: Record<string, string | number>): string`, donde `MessageKey` es la unión tipada de rutas (`'chat.search.placeholder'`). Interpolación con `{nombre}`.
  - Plurales con `Intl.PluralRules(locale)` y claves `{ one, other }`, a través de `tn(key, count, params)`.
  - Formato: `fmtBytes(n)` (KB/MB/GB/TB con 1 decimal y `Intl.NumberFormat(locale)`, de modo que en español sale "9,8 GB"), `fmtPercent(n)` ("76 %" en ambos idiomas: el espacio fino lo pone `Intl`) y `fmtRelative(date)` con `Intl.RelativeTimeFormat`.
  - `resolveLocale(setting)`: `'system'` toma el primer idioma de `navigator.languages` que empiece por `es`, y si no hay, usa `en`.
- El idioma vive en `core/state.ts` (`state.locale`). Al cambiar: `document.documentElement.lang = locale` y se re-renderizan todas las vistas suscritas. **No se reinicia la app.**

### 2.2 Ajustes
- `settings.rs`: campo `language: "system" | "en" | "es"` con `#[serde(default = "system")]`, para que un `settings.json` viejo siga cargando.
- `settings/main.ts` → sección **General** → fila "Idioma / Language" con `segmented`: `Sistema | English | Español`. El cambio aplica **al instante en las dos ventanas** (el evento `settings-changed` ya existe).

### 2.3 Rust
- `src-tauri/src/i18n.rs` (nuevo): `pub fn tr(locale: Locale, key: Key) -> &'static str`, con `enum Key` para el menú de la bandeja, los títulos de los selectores nativos (carpeta y archivos) y las notificaciones.
- `tray.rs` reconstruye el menú cuando llega `settings-changed`.

### 2.4 Migración
- Reemplazar **todas** las cadenas visibles en `src/views/**`, `src/settings/**`, `src/island/**` (lo que se ve), `mochi/greeting.ts` (**VERIFICAR** si tiene texto) y `tray.rs`.
- Nombres propios que **no** se traducen: n8n, Vercel, GitHub, Stripe, Resend, Cal.com, Notion, Claude Code, Gemini, Codex, Copilot, Cursor, Qwen, OpenCode, PowerShell, Windows Terminal y Mochi.
- Las respuestas de los CLIs no se traducen.

### 2.5 Diccionario inicial (las claves de las fases 3 a 7 se añaden al implementarlas)

| Clave | en | es |
|---|---|---|
| `tabs.home` | Home | Inicio |
| `tabs.chat` | Chat | Chat |
| `tabs.system` | System | Sistema |
| `tabs.settings` | Settings | Ajustes |
| `tabs.soundOn` / `soundOff` | Sound on / Sound off | Sonido activado / Sonido desactivado |
| `home.pane.consoles` | Consoles | Consolas |
| `home.pane.services` | Services | Servicios |
| `consoles.count` | {n} console / {n} consoles | {n} consola / {n} consolas |
| `consoles.running` | Running now | En ejecución |
| `consoles.cap.streams` | Streams | Transmite |
| `consoles.cap.resumes` | Resumes | Retoma |
| `consoles.cap.approvable` | Approvable here | Se aprueba aquí |
| `consoles.unverified` | Not verified | Sin verificar |
| `consoles.use` | Use this console | Usar esta consola |
| `consoles.inUse` | In use | En uso |
| `consoles.rescan` | Search again | Volver a buscar |
| `consoles.empty` | No consoles found | No se encontraron consolas |
| `consoles.sessions` | {n} session / {n} sessions | {n} sesión / {n} sesiones |
| `chat.attachProject` | Attach project… | Adjuntar proyecto… |
| `chat.placeholder` | Message {agent}… | Escribe a {agent}… |
| `chat.send` | Send | Enviar |
| `chat.stop` | Stop | Detener |
| `chat.copy` / `copied` | Copy / Copied | Copiar / Copiado |
| `chat.newChat` | New chat | Nuevo chat |
| `chat.more` | More | Más |
| `chat.newMessages` | New messages | Mensajes nuevos |
| `chat.retry` | Retry | Reintentar |
| `chat.empty.title` | What can I help with? | ¿En qué te ayudo? |
| `chat.steps` | {n} step / {n} steps | {n} paso / {n} pasos |
| `chat.search.placeholder` | Search in chat | Buscar en el chat |
| `chat.search.count` | {current} of {total} | {current} de {total} |
| `chat.search.none` | No results | Sin resultados |
| `common.cancel` | Cancel | Cancelar |
| `common.done` | Done | Listo |
| `common.back` | Back | Atrás |
| `files.drop.title` | Drop to attach | Suelta para adjuntar |
| `files.kinds` | PDF · Images · Code · Docs | PDF · Imágenes · Código · Documentos |
| `files.attach` | Attach files | Adjuntar archivos |
| `files.remove` | Remove {name} | Quitar {name} |
| `files.tooLarge` | {name} is over {max} | {name} supera {max} |
| `files.tooMany` | Up to {max} files per message | Máximo {max} archivos por mensaje |
| `files.blocked` | {name} can't be attached | {name} no se puede adjuntar |
| `files.missing` | File no longer available | El archivo ya no está disponible |
| `files.promptHeader` | Attached files: | Archivos adjuntos: |
| `system.cpu` | CPU | CPU |
| `system.memory` | Memory | Memoria |
| `system.disk` | Disk {drive} | Disco {drive} |
| `system.free` | {size} free | {size} libres |
| `system.usedOf` | {used} of {total} | {used} de {total} |
| `system.cores` | {n} cores | {n} núcleos |
| `system.tab.processes` | Processes | Procesos |
| `system.tab.storage` | Storage | Almacenamiento |
| `system.topMemory` | Using the most memory | Lo que más memoria usa |
| `system.showMore` | Show more | Ver más |
| `system.end` | End | Cerrar |
| `system.endConfirm` | End {name}? Unsaved work will be lost. | ¿Cerrar {name}? Se perderá lo que no esté guardado. |
| `system.endConfirmGroup` | End {name} ({n} processes)? Unsaved work will be lost. | ¿Cerrar {name} ({n} procesos)? Se perderá lo que no esté guardado. |
| `system.agentWarning` | This is an active agent session | Es una sesión de agente activa |
| `system.protected` | Protected by the system | Protegido por el sistema |
| `system.freeUp` | Free up space… | Liberar espacio… |
| `system.scanning` | Scanning… | Analizando… |
| `system.cleanN` | Clean {size} | Limpiar {size} |
| `system.cleaning` | Cleaning… | Limpiando… |
| `system.freed` | Freed {size} | Se liberaron {size} |
| `system.skipped` | {n} file in use was skipped / {n} files in use were skipped | Se omitió {n} archivo en uso / Se omitieron {n} archivos en uso |
| `system.needsAdmin` | Requires administrator | Requiere administrador |
| `system.openCleanup` | Open Windows Disk Cleanup | Abrir el Liberador de espacio de Windows |
| `system.cat.temp` | Temporary files | Archivos temporales |
| `system.cat.recycle` | Recycle Bin | Papelera de reciclaje |
| `system.cat.thumbs` | Thumbnail cache | Caché de miniaturas |
| `system.cat.npm` | npm cache | Caché de npm |
| `system.cat.pip` | pip cache | Caché de pip |
| `system.cat.inbox` | Coucou files older than 7 days | Archivos de Coucou de más de 7 días |
| `system.cat.log` | Coucou log | Registro de Coucou |
| `health.ok` | All good | Todo bien |
| `health.strained` | Your computer is working hard | Tu equipo está trabajando duro |
| `health.sick` | Your computer is struggling | Tu equipo está al límite |
| `health.cause.cpu` | CPU at {value} | CPU al {value} |
| `health.cause.memory` | Memory at {value} | Memoria al {value} |
| `health.cause.disk` | Disk at {value} | Disco al {value} |
| `health.mochiSays.strained` | I feel dizzy: {cause} | Me siento mareado: {cause} |
| `health.mochiSays.sick` | I'm not feeling well: {cause} | No me siento bien: {cause} |
| `health.view` | View | Ver |
| `settings.language` | Language | Idioma |
| `settings.language.system` | System | Sistema |
| `settings.defaultFolder` | Default chat folder | Carpeta por defecto del chat |
| `settings.change` / `remove` | Change… / Remove | Cambiar… / Quitar |
| `settings.defaultConsole` | Default console | Consola predeterminada |
| `settings.health.title` | Computer health | Salud del equipo |
| `settings.health.enabled` | Mochi reacts to computer load | Mochi reacciona a la carga del equipo |
| `settings.health.threshold` | Feel sick above | Enfermarse por encima de |
| `settings.health.includeDisk` | Include disk usage | Incluir uso del disco |
| `settings.health.diskThreshold` | Disk threshold | Umbral del disco |
| `settings.health.notify` | Let me know when it gets worse | Avisarme cuando empeore |

### Aceptación de la Fase 2
- Test `i18n.test.ts`:
  1. `es` tiene exactamente las claves de `en`.
  2. Ninguna cadena está vacía.
  3. Los `{placeholders}` de cada clave coinciden entre los dos idiomas.
  4. `fmtBytes(9.8e9)` devuelve `9,8 GB` en `es` y `9.8 GB` en `en`.
- Test `no-hardcoded-strings.test.ts`: busca en `src/views`, `src/settings` y `src/island` llamadas al helper de texto del DOM, a `textContent =`, a `title:` y a `aria-label` con un literal que contenga letras, salvo la lista blanca de nombres propios. **VERIFICAR** el nombre real del helper de texto.
- Capturas en `es`: ningún texto truncado ni desbordado (el español es un 20–30 % más largo).
- Cambiar el idioma en Ajustes cambia la isla, los Ajustes y el menú de la bandeja sin reiniciar.

---

## Fase 3: Consolas con el mismo aspecto que los servicios

### 3.1 Un solo componente de ficha
- Extraer la ficha de `views/integrations.ts` a `src/ui/tile.ts`. **Las capturas de servicios no deben cambiar.**
- Medidas observadas como referencia: ficha de unos 28 px de alto, fondo más oscuro que la tarjeta, borde de 1 px `--c-separator`, radio de unos 10 px; a la izquierda una carita de unos 26×18 px de color con dos ojos; el nombre centrado en `--t-subhead`. **Se mide en el código, no se reinventa.**
- Servicios y consolas usan **el mismo** `tile()`.

### 3.2 Paleta de caritas por consola: `src/consoles/palette.ts`
Solo colores, sin logos ni marcas registradas.

| id | Nombre | Color de la carita |
|---|---|---|
| `claude` | Claude Code | `#d97757` |
| `gemini` | Gemini | `#4e8cf7` |
| `codex` | Codex | `#10a37f` |
| `copilot` | Copilot | `#8957e5` |
| `cursor-agent` | Cursor | `#a1a1aa` |
| `qwen` | Qwen | `#615ced` |
| `opencode` | OpenCode | `#f5a524` |
| `pwsh` / `powershell` | PowerShell | `#2f6fd6` |
| `cmd` | Símbolo del sistema | `#71717a` |
| `wsl` | WSL | `#e95420` |
| `gitbash` | Git Bash | `#f05033` |
| desconocido | — | `--c-fill` con ojos claros |

Esta tabla es la única lista blanca de hex fuera de `tokens.css` (junto con los colores de los servicios que ya existen).

### 3.3 Tarjeta derecha del Inicio: dos páginas en una
Distribución (alto total de unos 108 px, igual que hoy):

```
┌──────────────────────────────────────────────┐ padding 10px 12px
│ [Consolas|Servicios]                ● ●  ↻   │ cabecera de 20px: segmented 'sm' · puntos de página · re-escanear (solo en Consolas)
│                                              │ gap 6px
│ [●● Claude Code ✓] [●● Gemini       ]        │ fila de 28px, gap de columna 8px
│ [●● Codex        ] [●● PowerShell   ]        │ gap de fila 6px
└──────────────────────────────────────────────┘
```

- `segmented` en tamaño `sm`: `Consolas | Servicios`. Se recuerda en `settings.json` (`homeRightPane`, por defecto `consoles`).
- **Paginación:** 4 fichas por página (2×2). Si hay más de 4, aparecen puntos de página estilo iOS (6 px, el activo `--c-label`, los demás `--c-label-3`). Se pasa de página con la rueda horizontal o vertical, con ←/→ cuando la tarjeta tiene foco, o con clic en los puntos. Transición: deslizamiento con `--d-base`.
- Orden de las consolas: primero la seleccionada, luego las que tienen sesiones en vivo, luego las verificadas y al final las sin verificar. Dentro de cada grupo, alfabético.

### 3.4 Estados de la ficha de consola

| Estado | Aspecto |
|---|---|
| Normal | Igual que una ficha de servicio |
| **Seleccionada** (CLI activo) | Borde de 1,5 px del color de la carita al 70 %, fondo con ese color al 10 %. Los ojos de la carita parpadean cada 4–6 s (solo en esta ficha). Glifo ✓ de 12 px a la derecha del nombre |
| Con sesiones en vivo | Punto verde (`--c-green`) de 6 px en la esquina superior derecha de la carita. Si hay 2 o más, una insignia `--t-caption2` con el número |
| Sin verificar | Carita desaturada al 40 %, nombre en `--c-label-2` |
| No encontrada (estaba seleccionada y desapareció) | Carita gris con ojos en "– –", nombre tachado, tooltip "No se encontró" |
| Hover | +6 % de luz; tras 500 ms, tooltip con versión · capacidades · sesiones |
| Pressed | Escala 0.97 |
| Foco | `--focus-ring` |

### 3.5 Interacción
- **Clic:** selecciona la consola (`agent_set_cli`), se guarda en settings, Mochi (isla y chat) adopta el *outfit* o color correspondiente y suena el sonido de selección existente si el sonido está activo.
- **Clic derecho, Enter con Shift o mantener 500 ms:** abre el **detalle** con `pushNav` dentro de la misma tarjeta, sin ventana nueva:

```
‹ Consolas                                    
[cara] Claude Code          2.1.241          
[Transmite] [Retoma] [Se aprueba aquí]        ← chips; los que no aplica no se muestran
En ejecución                                  ← --t-caption, MAYÚSCULAS
 ● coucou            Windows Terminal         ← listRow por sesión (de hooks.ts)
 ● api-pagos         Windows Terminal         
[ Usar esta consola ]   (o "En uso", deshabilitado)
```

  Si el detalle no cabe en la altura de la tarjeta, la lista de sesiones se desplaza por dentro (`overflow:auto`). **La tarjeta no crece.**
- **↻ Re-escanear:** llama a `console_rescan` (si no existe, crearlo sobre el módulo de detección). El icono gira mientras escanea y aparece un *toast* con el resultado ("Se encontraron 2 consolas nuevas").
- **Estado vacío:** una ficha ancha con la carita gris, "No se encontraron consolas" y el botón "Volver a buscar".
- Quitar la vista actual de "3 CONSOLES" con la tarjeta grande y los chips cortados.

### Aceptación de la Fase 3
- Capturas `home-consoles` y `home-services`: mismas medidas de ficha (diferencia de 1 px como máximo en alto, padding y radio).
- Con 5 o más consolas en el mock aparecen los puntos de página, y la rueda y las flechas cambian de página.
- Elegir otra consola cambia el CLI del siguiente turno de chat (test con el mock que comprueba que `agent_set_cli` recibió el id).
- Tests TS: orden de las fichas, paginación (`pages(items, 4)`) y estado visual derivado de los datos (función pura `tileStateFor(console, selectedId, sessions)`).

---

## Fase 4: Chat (que no se salga de la pantalla y rediseño)

### 4.1 Corregir el desbordamiento (lo primero)
**Causa probable** (VERIFICAR en `core/layout.ts`, `island/island.ts` e `island.rs`): la altura deseada de la vista de chat no se limita al **área de trabajo** del monitor (pantalla menos la barra de tareas), y el contenedor no restringe su alto.

1. `island.rs`: calcular `max_height = work_area.bottom - island_top - 12` en píxeles lógicos, con el área de trabajo del monitor donde está la isla (`MonitorFromWindow` + `GetMonitorInfoW.rcWork`). Enviarlo en `boot` y en el evento `screen-changed`.
2. `core/layout.ts`: función **pura** `clampViewHeight(desired, maxHeight, minHeight)`, y aplicarla a **todas** las vistas, no solo al chat.
3. Altura deseada del chat: `clamp(320, 0.62 × workAreaHeight, 640)`.
4. CSS de la vista:

```css
.chat { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; height: 100%; min-height: 0; }
.chat__messages { overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; min-height: 0; }
```

5. Quitar el brillo morado de abajo, o reducirlo a un degradado sutil de 24 px **detrás del compositor** que sirva como borde de desvanecimiento del scroll.

### 4.2 Nueva estructura

```
┌────────────────────────────────────────────────────────────────┐
│ (•‿•) [●● Claude Code ⌄]          [📁 coucou ⌄]  [🔍]  [⋯]     │ cabecera 44px
├────────────────────────────────────────────────────────────────┤
│                                                  ┌──────────┐  │
│                                                  │   hola   │  │ burbuja del usuario
│                                                  └──────────┘  │
│ ¡Hola! ¿En qué te ayudo hoy?                                   │ respuesta sin burbuja
│ Veo que estás en el repo coucou, en la rama `windows/…`        │
│ ▸ 3 pasos                                                      │ pasos agrupados
│                                         [↓ Mensajes nuevos]    │ aparece solo si hiciste scroll arriba
├────────────────────────────────────────────────────────────────┤
│ [img][img][pdf]                                                │ bandeja de adjuntos (si hay)
│ (📎)  Escribe a Claude Code…                          (↑)      │ compositor de vidrio
└────────────────────────────────────────────────────────────────┘
```

- **Mochi sale de la columna izquierda**, que hoy desperdicia unos 100 px. En el chat pasa a ser un **avatar de 24 px** en la cabecera, con el mismo motor y a una escala menor: ojos mirando al texto mientras transmite, "pensando" mientras espera y el ánimo de salud de la Fase 7.

### 4.3 Cabecera (44 px, padding horizontal `--s-3`)
- **Chip de consola:** carita + nombre + `chevron-down`. Abre una lista desplegable dentro del chat (máximo 6 filas visibles) con las consolas en el mismo orden que la Fase 3. Es un atajo: lo mismo que la tarjeta del Inicio.
- **Chip de proyecto:** `folder` + nombre de la carpeta, o `t('chat.attachProject')` si no hay. Clic → `pick_project`. Menú: "Cambiar…" y "Quitar". Ancho máximo de 180 px con elipsis; la ruta completa va en el tooltip.
- `iconButton` de búsqueda (Ctrl+F) y `iconButton` "Más" (`ellipsis`), que abre un menú con: Nuevo chat (`agent_reset` + `chat_forget`, con confirmación en línea si hay mensajes), Copiar conversación y Abrir carpeta del proyecto en VS Code (`open_in_vscode`).
- **VERIFICAR** qué hace hoy el botón `>`. Si duplica algo de lo anterior, se elimina; si es otra función, se mueve al menú "Más".

### 4.4 Mensajes
- **Usuario:** burbuja alineada a la derecha, `max-width: 78%`, fondo `--c-accent`, texto `--c-on-accent`, `--t-body`, radio 18 px (16 en la esquina inferior derecha) y padding `8px 12px`.
- **Asistente:** sin burbuja, a todo el ancho, `--t-body` en `--c-label`, renderizado por `views/markdown.ts`.
  - Bloques de código: fondo `--c-surface-2`, radio `--r-md`, `--t-code`, scroll horizontal propio, botón "Copiar" en la esquina al pasar el ratón ("Copiado ✓" durante 1,5 s).
  - Tablas: scroll horizontal propio, nunca ensanchan el chat.
  - Enlaces: `--c-accent` y se abren con `open_url`.
- **Pasos** (`Turn::Step`): mientras transmite se mantiene `ticker.ts`. Al terminar el turno se pliegan en una línea "▸ 3 pasos" (`--t-footnote`, `--c-label-2`) que se despliega al hacer clic.
- **Espaciado:** 16 px entre turnos y 6 px entre mensajes consecutivos del mismo autor.
- **Streaming:** cursor parpadeante de 2×14 px al final del texto. El botón enviar se convierte en "Detener" (`stop`).
- **Errores:** fila con fondo `--c-red` al 12 %, icono, texto y botón "Reintentar".
- **Scroll:** se pega abajo solo si el usuario ya estaba a menos de 48 px del final. Si no, aparece la píldora "↓ Mensajes nuevos", que lleva al final con scroll suave.
- **Vacío:** Mochi a 64 px centrado, `t('chat.empty.title')` en `--t-title3` y el placeholder del compositor activo.
- **Acciones por mensaje** (hover): Copiar. La hora relativa va en el tooltip (`fmtRelative`).

### 4.5 Compositor
- Contenedor de vidrio: `background: var(--c-glass); backdrop-filter: var(--glass-blur); border-top: 1px solid var(--c-glass-border); padding: var(--s-2) var(--s-3)`.
- Fila: `iconButton(paperclip)` · `textarea` · botón enviar (círculo de 28 px, `--c-accent`, `arrow-up`; deshabilitado al 40 % si no hay texto ni adjuntos).
- `textarea` con altura automática de 1 a 6 líneas, y a partir de ahí scroll interno. Placeholder: `t('chat.placeholder', {agent})`.
- Teclas: Enter envía, Shift+Enter hace salto de línea, Esc detiene el turno (si transmite) o cierra la búsqueda, `↑` con el compositor vacío recupera el último mensaje enviado, y `/` abre el menú de comandos existente (`agent_commands`).

### 4.6 Búsqueda dentro del chat
- La lupa (o Ctrl+F) **transforma la cabecera** en barra de búsqueda (transición `--d-base`):
  `[🔍 Buscar en el chat______] 2 de 7  [⌃] [⌄]  Cancelar`
- La búsqueda es una función **pura** en `views/chat-search.ts`: `findMatches(messages, query)`. No distingue mayúsculas ni **tildes** (normaliza con NFD y quita los diacríticos, así "accion" encuentra "acción"). Se lanza con un *debounce* de 120 ms.
- Resaltado: `<mark>` con fondo `--c-yellow` al 35 %. La coincidencia actual va con `--c-yellow` al 70 % y `scrollIntoView({block:'center'})`.
- Enter va a la siguiente, Shift+Enter a la anterior y Esc cierra y quita el resaltado.
- Alcance: los **últimos 40 mensajes** que guarda `chat.json`. Si hay más historial en el CLI, no se busca allí (se avisa con un tooltip en la lupa: "Busca en los últimos 40 mensajes").

### Aceptación de la Fase 4
- A 1366×768 y 1920×1080, con escalas de 100 %, 125 % y 150 % (probar en Windows real y en el mock con `deviceScaleFactor`), la isla **nunca** pasa del área de trabajo, y la cabecera y el compositor **siempre** se ven.
- Con el mensaje de 20 000 caracteres, el scroll es interno y el ancho no cambia.
- Tests: `clampViewHeight` (casos límite), `findMatches` (tildes, mayúsculas, dentro de código y sin resultados), la altura automática (función pura con el número de líneas) y la regla de "pegado abajo".
- El revisor de diseño no reporta ningún hallazgo de severidad Alta.

---

## Fase 5: Archivos dentro del chat

### 5.1 Quitar la pestaña `+`
- La barra superior queda: **Inicio · Chat · Sistema** a la izquierda y Ajustes · Sonido a la derecha.
- La función "nuevo chat" que pudiera tener `+` queda en el menú "Más" del chat.
- Quitar la vista de la lista de vistas de `views.ts` y su estado en `fsm.ts`. Actualizar los tests de la máquina de estados.

### 5.2 Soltar archivos en cualquier lugar de la isla
- Arrastrar archivos sobre la isla:
  1. Si la isla está colapsada o en otra vista, **se abre el chat** (con la transición normal).
  2. Sobre el área de mensajes aparece la **capa de soltar**: material vidrio, borde discontinuo de 1,5 px `--c-accent` al 60 %, radio `--r-lg` e inset `--s-3`. Al centro, Mochi (reutilizando `upload/canvas.ts` y `upload/sequence.ts`, escalado para caber), `t('files.drop.title')` en `--t-title3` y los chips `PDF · Imágenes · Código · Documentos`.
  3. Al soltar: secuencia corta de Mochi "tragando" (máximo 600 ms, nada con movimiento reducido). Después los archivos aparecen en la **bandeja de adjuntos**. **No se envían solos.**
  4. Si el arrastre sale de la isla, la capa se va con un fundido de `--d-fast`.

### 5.3 Otras formas de adjuntar
- `📎` → comando nuevo `pick_files`: selector nativo multiselección (`IFileOpenDialog` con `FOS_ALLOWMULTISELECT`) en `platform/windows.rs`, y su equivalente en `linux.rs`. Título del diálogo con `i18n.rs`.
- **Pegar** (Ctrl+V) una imagen en el compositor → comando nuevo `ingest_bytes(name, bytes)`, que la guarda como PNG en el *inbox* con el mismo "nunca sobrescribir" de `files.rs`.

### 5.4 Reglas de archivos

| Regla | Valor |
|---|---|
| Máximo por mensaje | 10 archivos |
| Tamaño máximo | 20 MB por archivo |
| Bloqueados | `.exe .msi .bat .cmd .ps1 .vbs .lnk .scr` → toast `files.blocked` |
| Tipos con miniatura | `png jpg jpeg webp gif bmp` |
| Resto | Glifo por tipo: `pdf`, `code` (extensiones de código), `doc` (docx/xlsx/pptx/csv/md/txt) y genérico |

- Toda la validación se hace **en Rust**; la UI solo refleja el resultado.

### 5.5 Bandeja de adjuntos (sobre el `textarea`)
- Fichas de 56×56 px, radio `--r-sm`. Las imágenes muestran la miniatura; el resto, el glifo con la extensión debajo en `--t-caption2`.
- El botón "×" (círculo de 18 px) aparece al pasar el ratón. Con teclado: foco en la ficha y Supr. `aria-label`: `t('files.remove', {name})`.
- Si hay más de lo que cabe, la bandeja hace scroll horizontal.
- **Miniaturas sin que el webview toque rutas:** comando nuevo `inbox_thumb(id) -> data URL` (solo imágenes de 10 MB o menos), que usa el base64 propio que ya existe. El webview la reduce a 112×112 en un canvas y descarta la cadena grande.

### 5.6 Enviar con adjuntos
- El prompt que llega al CLI es:

```
<texto del usuario>

<t('files.promptHeader')>
- C:\Users\…\AppData\Local\Coucou\inbox\captura-1.png
- C:\Users\…\AppData\Local\Coucou\inbox\informe.pdf
```

- **Claude Code:** como el *inbox* está fuera del proyecto, añadir automáticamente `--add-dir <inbox>` al turno (con las "carpetas extra" que ya maneja `agents.rs`). Así Claude lee los archivos sin pedir permiso para una ruta externa. **VERIFICAR** con la suite *live* que `claude -p` lee la imagen con su herramienta Read.
- **Otros CLIs:** formato configurable en `agents/<cli>.json` → `attachments: "paths" | "none"` (por defecto `paths`). Si es `none`, el botón 📎 se deshabilita con un tooltip.
- El historial (`transcript.rs`) guarda por mensaje `attachments: [{id, name, kind, size}]`, **nunca** los bytes. Al recargar, las miniaturas se piden de nuevo; si el archivo ya no existe, aparece una ficha gris con `t('files.missing')`.
- En la burbuja del usuario, los adjuntos se ven **encima** del texto como miniaturas de 48 px.

### Aceptación de la Fase 5
- Soltar 2 imágenes y 1 PDF con el chat cerrado → se abre el chat → aparecen en la bandeja → al enviar, el prompt incluye las 3 rutas (test con el mock).
- Soltar un `.exe` → toast y no se adjunta (test Rust de validación).
- Pegar una captura con Ctrl+V → aparece en la bandeja.
- Prueba *live* opt-in: Claude describe una imagen de prueba de 16×16 adjuntada.
- Ya no existe la pestaña `+`, y los tests de `fsm.ts` siguen en verde.

---

## Fase 6: Pestaña Sistema (nuevo diseño de UX/UI)

### 6.1 Objetivo de UX
Responder en un vistazo a **"¿mi equipo está bien?"** y luego a **"¿qué lo está frenando y qué puedo hacer?"**. Hoy hay dos barras sueltas, un enlace y una lista con × peligrosa sin contexto.

### 6.2 Distribución

```
┌──────────┬──────────────────────────────────────────────────────┐
│          │ ● Tu equipo está trabajando duro                     │ estado (headline) con color
│  Mochi   │   Memoria al 76 % · CPU 32 %                         │ detalle (footnote, label-2)
│ (ánimo   │                                                      │
│  de      │   ◯ 32 %        ◯ 76 %          ◯ 78 %               │ 3 gauges de 64px
│  salud)  │   CPU          Memoria          Disco C:             │
│  96px    │   8 núcleos    11,4 de 15 GB    51 GB libres         │
│          │                                                      │
│          │ [ Procesos | Almacenamiento ]                         │ segmented 'md'
│          │ ─────────────────────────────────────────────────── │
│          │ ⓒ claude.exe   ×3  ▇▇▇▇▇▇▇▇▇▇▇▇▇        1,36 GB  ⋯   │ listRow
│          │ ⓜ msedge.exe       ▇▇▇▇                 315 MB  ⋯   │
│          │ …                                     Ver más        │
└──────────┴──────────────────────────────────────────────────────┘
```

- Mochi se queda en la columna izquierda **en esta vista**, porque aquí es el protagonista: muestra el ánimo de salud (Fase 7) a escala grande.
- La lista hace scroll interno. La vista respeta `clampViewHeight` (deseada: 380 px).

### 6.3 Gauges (`ui/gauge.ts`)
- Anillo SVG de 64 px, trazo de 6, fondo del anillo `--c-fill-2`, extremo redondeado. Empieza en las 12 y avanza en sentido horario.
- Al centro, el valor en `--t-title2` con `tabular-nums`. Debajo, la etiqueta (`--t-caption`) y el detalle (`--t-footnote`, `--c-label-2`).
- Color por umbral: menos de 70 % `--c-green`, de 70 a 84 % `--c-orange` y 85 % o más `--c-red`.
- **El color nunca es la única señal:** desde 70 % se añade un glifo `!` de 10 px junto al valor y el `aria-label` lo dice ("Memoria 76 por ciento, alto, 11,4 de 15 GB").
- Animación: el arco interpola con `--d-slow` y `--ease-out`. Con movimiento reducido, cambio directo.
- **Clic en un gauge:** CPU y Memoria llevan a "Procesos" ordenados por esa métrica (la columna cambia a % de CPU o a MB). Disco lleva a "Almacenamiento".
- Para el gauge de disco, usar `--c-orange` a partir de 90 % y `--c-red` desde 95 % (los discos casi llenos son normales y no deben verse alarmantes al 70 %).

### 6.4 Pestaña "Procesos"
- **Agrupar por ejecutable** (función pura `groupProcesses(list)` en TS): `claude.exe ×3 = 1,36 GB`. Se muestran los 8 grupos más grandes y "Ver más" amplía a 20.
- Cada fila (`listRow` de 32 px):
  - Inicial en un círculo de 20 px del color derivado del nombre (hash → uno de los colores de sistema). Los procesos conocidos de agentes usan la carita de su consola (paleta de la Fase 3).
  - Nombre, insignia `×N` si hay más de uno y una barra horizontal de 4 px proporcional al grupo más grande (`--c-fill` y relleno `--c-label-3`).
  - Valor a la derecha (`tabular-nums`) y botón `⋯` que aparece al pasar el ratón o con foco.
- `⋯` → menú: **Cerrar** (destructivo) y **Ver procesos (N)** (despliega los PID con su memoria individual).
- **Cerrar** → `inlineConfirm` dentro de la misma fila: `t('system.endConfirmGroup', …)` + [Cancelar] [Cerrar] en rojo. Si es un CLI de agente, se añade la línea `t('system.agentWarning')`.
- **Protegidos** (nunca muestran Cerrar, sino un glifo `lock` con tooltip `t('system.protected')`): `System`, `Registry`, `smss`, `csrss`, `wininit`, `winlogon`, `services`, `lsass`, `svchost`, `dwm`, `explorer`, `fontdrvhost`, `MsMpEng`, `SecurityHealthService`, el propio `coucou` y **su** árbol de procesos (incluido su `msedgewebview2` hijo).
- **Backend:** el comando `system_end_process(targets: [{pid, startTime}])` **revalida en Rust** la lista de protegidos y que el `startTime` coincida (para evitar reutilización de PID). Usa `OpenProcess(PROCESS_TERMINATE)` + `TerminateProcess`. Devuelve los que fallaron, y la UI muestra un toast ("No se pudo cerrar 1 proceso").
- Refresco: cada 3 s mientras la pestaña está visible. Si una fila cambia de posición, se mueve con un desplazamiento de `--d-base`; no salta.

### 6.5 Pestaña "Almacenamiento"
- Una fila por unidad **fija** (`GetLogicalDrives` + `GetDriveTypeW == DRIVE_FIXED`): glifo `drive`, "C:", barra de 6 px (usado en el color del umbral de disco, libre en `--c-fill-2`) y "51 GB libres de 237 GB".
- Botón primario **"Liberar espacio…"** → abre el `sheet` de limpieza:
  1. **Analizando:** filas *skeleton* (rectángulos `--c-fill-2` con pulso suave; estáticos con movimiento reducido) y Mochi a la izquierda con una animación de "barrer" (opcional, `broom`).
  2. **Resultados:** lista de categorías con checkbox, nombre, descripción corta y tamaño:
     - Archivos temporales (`%TEMP%`, solo de más de 2 días)
     - Papelera de reciclaje (`SHQueryRecycleBinW` / `SHEmptyRecycleBinW`)
     - Caché de miniaturas
     - Caché de npm
     - Caché de pip
     - Archivos de Coucou de más de 7 días (*inbox*)
     - Registro de Coucou
     - Deshabilitadas, con `t('system.needsAdmin')`: `C:\Windows\Temp` y Windows Update. Debajo, un enlace secundario `t('system.openCleanup')` (lanza `cleanmgr`).
  3. Pie fijo: total seleccionado + botón primario `t('system.cleanN', {size})`.
  4. **Limpiando:** barra de progreso determinada (por categoría) y botón deshabilitado.
  5. **Resultado:** check grande, `t('system.freed', {size})`, `t('system.skipped', …)` si aplica, Mochi feliz y "Listo". El gauge de disco se actualiza.
- **Seguridad (se aplica en Rust y tiene tests):** lista blanca de rutas; no seguir enlaces simbólicos ni *junctions* (comprobar `FILE_ATTRIBUTE_REPARSE_POINT`); omitir archivos en uso y los de menos de 2 días; escribir en `coucou.log` lo borrado y lo liberado; nunca nada fuera de la lista blanca, aunque lo pida la UI.
- Si `system_scan` y `system_clean` ya existen del plan anterior, reutilizarlos. Si no, crearlos con estas reglas.

### 6.6 Datos y frecuencia

| Dato | Comando o evento | Frecuencia |
|---|---|---|
| CPU % y RAM % | evento `health` (Fase 7) | Cada 2 s siempre; en la vista se interpola |
| Detalle de RAM (usado/total) y núcleos | `system_stats` | 1 s con la vista visible |
| Procesos | `system_processes` | 3 s con la pestaña Procesos visible |
| Unidades | `system_drives` | Al abrir la vista y cada 30 s |

Todo se detiene al ocultar la vista, salvo el monitor de salud de la Fase 7.

### Aceptación de la Fase 6
- Capturas `system-ok`, `system-strained` y `system-sick` en `en` y `es`: estado, colores y glifos correctos.
- Tests Rust:
  - Guardián de rutas: rechaza `..`, enlaces simbólicos, *junctions* y rutas fuera de la lista blanca.
  - `system_end_process` rechaza protegidos y PID con `startTime` distinto.
- Tests TS: `groupProcesses`, umbrales de color y el texto de `aria-label` de los gauges.
- Sin `alert` ni `confirm`, y toda acción destructiva pide confirmación en línea.

---

## Fase 7: Salud del equipo y Mochi enfermo

### 7.1 Monitor en el backend: `src-tauri/src/health.rs` (nuevo)
- **Hilo propio** que muestrea **cada 2 s**:
  - CPU del sistema. Windows: `GetSystemTimes` con deltas, `uso = 1 − Δidle / (Δkernel + Δuser)` (en Windows, *kernel* incluye *idle*). Linux: primera línea de `/proc/stat`.
  - RAM: `GlobalMemoryStatusEx` → `(total − disponible) / total`. Linux: `MemTotal` y `MemAvailable` de `/proc/meminfo`.
  - Disco de la unidad del sistema: cada 60 s.
- **Suavizado:** media móvil exponencial con N=5 muestras (unos 10 s), `α = 2/(N+1)`.
- **Niveles** (`métrica = max(CPU_ema, RAM_ema)`, más el disco si `includeDisk`):

| Nivel | Entra cuando | Sale cuando |
|---|---|---|
| `ok` | — | — |
| `strained` (mareado) | métrica ≥ **umbral** (por defecto **70 %**) durante 10 s seguidos | métrica < umbral − 5 durante 20 s |
| `sick` (enfermo) | métrica ≥ **85 %** durante 10 s seguidos | métrica < 80 durante 20 s (baja a `strained`) |

- La **histéresis** (−5 puntos y 20 s) evita que Mochi parpadee entre estados.
- **Disco:** por defecto **no** enferma a Mochi. Un disco por encima del 70 % es lo normal, y Mochi estaría enfermo casi siempre. Con `includeDisk = true` usa su propio umbral (por defecto 90 %). Siempre se muestra como aviso en la pestaña Sistema.
- La **causa** es la métrica que más supera su umbral: `cpu`, `memory` o `disk`.
- Emite el evento `health` **solo** al cambiar de nivel y, si no está en `ok`, cada 10 s con los valores (para el tooltip). Payload: `{ level, cause, cpu, memory, disk, since }`.
- También expone el comando `health_state` (para el arranque).
- Se pausa con `set_paused` y si `health.enabled = false`.
- Coste: dos llamadas Win32 baratas cada 2 s. Nada de WMI ni PowerShell.
- **Solo en builds de depuración:** comando `health_simulate(level | null)`, que fuerza un nivel para probar las animaciones sin cargar el equipo. **No** existe en release (`#[cfg(debug_assertions)]`).

### 7.2 Ajustes de salud
`settings.rs` → `health: { enabled: true, threshold: 70, includeDisk: false, diskThreshold: 90, notify: true }`, todos con `serde(default)`.

En Ajustes → **Salud del equipo**:
- Interruptor "Mochi reacciona a la carga del equipo".
- Deslizador "Enfermarse por encima de": de 50 a 95, paso 5, muestra el valor; por defecto 70.
- Interruptor "Incluir uso del disco" y, si está activo, deslizador del umbral del disco (de 70 a 98, por defecto 90).
- Interruptor "Avisarme cuando empeore".

### 7.3 Integración en la UI
- `island/health.ts`: escucha `health` y lo guarda en `state.health`.
- **La salud es una capa de ánimo, no un estado de la máquina de estados.** `fsm.ts` no cambia sus prioridades. La tarjeta de aprobación, el turno en curso y lo demás se muestran igual; solo cambia **cómo se dibuja Mochi**.
- **Aviso al empeorar** (si `notify`):
  - Al pasar de `ok` a `strained` o a `sick` con la isla **colapsada y en reposo**, la isla se asoma 2,5 s con Mochi enfermo, `t('health.mochiSays.<nivel>', {cause})` y el botón `t('health.view')`, que lleva a Sistema.
  - Máximo una vez cada 15 min por nivel.
  - **Nunca** con una aprobación pendiente, en pausa ni durante un turno en curso.
  - Sonido opcional: la tos (ver 7.5), solo si el sonido está activo y solo al entrar a `sick`.
- El icono de **Sistema** en la barra lleva un punto de 6 px naranja (`strained`) o rojo (`sick`).
- **Tooltip sobre Mochi** (si no está en `ok`): `t('health.mochiSays.<nivel>', {cause: t('health.cause.<causa>', {value})})`.

### 7.4 Animaciones de Mochi: `src/mochi/moods.ts` (nuevo) + `engine.ts`

Los ánimos se describen **como datos** y el motor interpola entre ellos:

```ts
export interface MoodParams {
  tint: string;            // color hacia el que se tiñe el cuerpo
  tintAmount: number;      // 0..1
  eyeLid: number;          // 0 = abiertos, 1 = cerrados (párpado superior)
  eyeStyle: 'normal' | 'tired' | 'closedArc';
  eyeLookY: number;        // px, positivo = mira abajo
  blinkEveryMs: [number, number];
  breathPeriodScale: number;
  swayAmpPx: number;
  swayHz: number;
  tiltDeg: number;         // rotación máxima del vaivén
  sweatEveryMs: number | null;
  sweatDrops: 1 | 2;
  blush: number;           // 0..1, mejillas rojas (fiebre)
  thermometer: boolean;
  shiver: { everyMs: number; durationMs: number; ampPx: number; hz: number } | null;
  coughEveryMs: [number, number] | null;
}
```

| Parámetro | `ok` | `strained` (mareado) | `sick` (enfermo) |
|---|---|---|---|
| `tint` / `tintAmount` | — / 0 | `#cfebd2` / 0.35 | `#bfe3c4` / 0.50 |
| `eyeLid` | 0 | 0.40 | 0.55 |
| `eyeStyle` | normal | tired | tired, con `closedArc` 1 de cada 3 parpadeos |
| `eyeLookY` | 0 | +1 | +2 |
| `blinkEveryMs` | [3000, 6000] | [5000, 8000] | [2500, 4000], parpadeos lentos de 280 ms |
| `breathPeriodScale` | 1 | 1.4 | 1.7 |
| `swayAmpPx` / `swayHz` / `tiltDeg` | 0 / 0 / 0 | 2 / 0.5 / 2.5 | 1.5 / 0.35 / 3.5 |
| `sweatEveryMs` / `sweatDrops` | null | 4000 / 1 | 2500 / 2 |
| `blush` | 0 | 0 | 0.45 |
| `thermometer` | no | no | sí |
| `shiver` | null | null | cada 3000 ms, 300 ms, ±0.8 px, 12 Hz |
| `coughEveryMs` | null | null | [12000, 20000] |

**Elementos de dibujo** (en el canvas 2D existente; todas las medidas son para el tamaño base de Mochi en la isla y escalan con él):
- **Tinte:** mezclar el color del cuerpo con `tint` en `tintAmount`. Al usar un *outfit* de consola, mezclar sobre ese color.
- **Párpados:** rectángulo redondeado del color del cuerpo (ya teñido) que tapa la parte superior de cada ojo en proporción `eyeLid`. Con `closedArc`, los ojos se dibujan como un arco de 3 px de grosor, cóncavo hacia abajo.
- **Gota de sudor:** forma de lágrima de 4×6 px, `#7cc4ff` al 90 % con un brillo blanco de 1 px. Nace arriba a la derecha de la cabeza, baja 10 px en 1,2 s (`ease-in`) y se desvanece en los últimos 300 ms. Con `sweatDrops: 2`, la segunda sale 600 ms después en el lado izquierdo.
- **Mejillas:** dos elipses de 8×4 px, `#ff6b6b` con alfa = `blush`, 3 px por debajo de cada ojo.
- **Termómetro:** palito de 12×3 px blanco con el bulbo rojo (`#ff453a`, 4 px de diámetro) en el extremo exterior. Sale de la parte inferior derecha de la cara con un ángulo de 20° y oscila ±3° al ritmo de la respiración.
- **Escalofrío:** desplazamiento horizontal sinusoidal durante `durationMs`.
- **Tos** (evento puntual): aplastar 120 ms (escala Y 0.90, X 1.06), volver con muelle (`anim.ts`, rigidez 300 y amortiguación 18) y soltar 3 círculos de "vaho" (`--c-label-3`, de 3 a 5 px) que se alejan 8 px y se desvanecen en 500 ms.
- **Recuperación** (transitorio al pasar a `ok` desde otro nivel, 900 ms): sacudida (rotación ±6° amortiguada en 3 ciclos), el tinte vuelve a 0 en 600 ms, 4 destellos `✦` en `#ffd60a` que salen en diagonal 12 px y se desvanecen, y los ojos se abren con un parpadeo.
- **Transiciones entre ánimos:** `lerpMood(a, b, t)` sobre todos los números y colores en 600 ms con `--ease-in-out`. Nada aparece de golpe, excepto los booleanos (`thermometer`), que hacen un fundido de 200 ms.
- **Composición con otros estados:** el ánimo **se suma** a los estados existentes del motor (trabajando, esperando aprobación, saludo). Durante una aprobación se dibujan el tinte, los párpados y las mejillas, pero **no** el vaivén, la tos ni el escalofrío, para que la tarjeta se lea sin distracciones.
- **Movimiento reducido:** solo tinte, párpados, mejillas y termómetro estáticos. Sin vaivén, sudor, escalofrío, tos ni destellos.
- **Rendimiento:** con la isla colapsada y un ánimo distinto de `ok`, el bucle baja a 20 fps; con la isla oculta, se detiene. Las gotas y los destellos usan un *pool* de partículas fijo (máximo 8), sin crear objetos en cada frame.
- **Aleatoriedad determinista:** los intervalos aleatorios (tos y parpadeos) salen de un PRNG con semilla (`mulberry32`) inyectable, para poder testearlos.
- El mismo ánimo se aplica a Mochi en la isla, al avatar del chat (24 px) y a Mochi en Sistema (96 px). A 24 px **no** se dibujan termómetro ni gotas; solo tinte, párpados y mejillas.

### 7.5 Sonido
- Se añade `cough` a los 29 sonidos existentes (`core/sound.ts`). Se genera igual que los demás (**VERIFICAR** si son archivos o síntesis), dura menos de 400 ms y tiene volumen bajo.
- Suena solo al **entrar** en `sick` y solo si el sonido está activo.

### 7.6 Galería de desarrollo
- `src/dev/gallery.ts` (solo en modo mock), con `?view=mochi-gallery`: muestra en fila Mochi en `ok`, `strained`, `sick`, la recuperación y cada ánimo combinado con "esperando aprobación". Cada uno a 96 px y a 24 px, con botones para reproducir la tos y la recuperación.
- `npm run shots` captura la galería en t=0 y t=1 s.

### Aceptación de la Fase 7
- Tests Rust:
  - La EMA.
  - Las transiciones de nivel con histéresis (con una secuencia de muestras inyectada: sube a 72 durante 10 s → `strained`; baja a 67 → sigue `strained`; 20 s a 64 → `ok`).
  - El disco no influye con `includeDisk=false`.
  - Ajustes viejos sin el bloque `health` cargan con los valores por defecto.
- Tests TS:
  - `lerpMood` (extremos y punto medio).
  - El calendario de gotas y tos con semilla fija.
  - Las reglas del aviso: no durante aprobación, máximo uno cada 15 min.
- En debug, `health_simulate('sick')` hace que Mochi se vea enfermo en menos de 1 s, y `health_simulate(null)` reproduce la recuperación.
- Prueba real: con un consumidor de memoria (por ejemplo, un script que reserve RAM hasta el 80 %), Mochi se marea en unos 10 s y se recupera en unos 20 s después de liberarla.
- Medición: frame de Mochi en `sick` por debajo de 4 ms (con `performance.now()` en dev) y CPU de Coucou en reposo con la isla colapsada por debajo de 0,5 %.

---

## Fase 8: Cierre y QA final

1. `npm run shots` completo y revisión de cada PNG contra este documento.
2. Correr el subagente `coucou-design-reviewer` sobre todo `src/` y resolver los hallazgos Alta y Media.
3. `npx hig-doctor .` (si analiza web): revisar los hallazgos, descartar los exclusivos de iOS y anotar los descartes en `docs/plan-v2-notas.md`.
4. **Accesibilidad:**
   - Toda la isla se recorre con el teclado (Tab, flechas en `segmented` y la paginación, Esc para cerrar).
   - Foco siempre visible.
   - Contraste de 4,5:1 en el texto y 3:1 en los controles.
   - Lector de pantalla: Narrador lee los gauges y las fichas.
5. **Rendimiento:** medir el consumo en reposo **sin** sesión de Claude Code activa (pendiente desde el mapa de arquitectura) con la isla colapsada durante 5 min, y con salud activa y desactivada. Anotar los resultados.
6. **Instalado:** generar el instalador y probar el autostart, el idioma y la salud en la build instalada, no desde `target/`.
7. Actualizar el mapa de arquitectura: nuevos módulos (`health.rs`, `i18n.rs`, `ui/`, `i18n/`, `consoles/`) y nuevos comandos y eventos.

### Comandos y eventos nuevos (resumen)

| Tipo | Nombre | Fase |
|---|---|---|
| comando | `console_rescan` (si no existe) | 3 |
| comando | `pick_files` | 5 |
| comando | `ingest_bytes` | 5 |
| comando | `inbox_thumb` | 5 |
| comando | `system_drives` | 6 |
| comando | `system_end_process` | 6 |
| comando | `system_scan`, `system_clean` (si no existen) | 6 |
| comando | `health_state` | 7 |
| comando | `health_simulate` (solo debug) | 7 |
| evento | `health` | 7 |

### Mapa de archivos

| Nuevos | Modificados |
|---|---|
| `src/styles/tokens.css`, `src/ui/*.ts`, `src/ui/ui.css` | `views/views.ts`, `views/integrations.ts`, `views/chat.ts`, `views/markdown.ts` (resaltado de búsqueda) |
| `src/i18n/{en,es,index}.ts` | `island/island.ts`, `island/fsm.ts`, `island/hooks.ts`, `island/agent.ts` |
| `src/consoles/palette.ts`, `views/consoles.ts` (si no existe) | `core/layout.ts`, `core/state.ts`, `core/bridge.ts`, `core/sound.ts` |
| `views/chat-search.ts`, `views/attachments.ts`, `views/system.ts` (rehecho) | `settings/main.ts`, `mochi/engine.ts`, `upload/*.ts` |
| `island/health.ts`, `mochi/moods.ts` | `src-tauri/src/{lib,settings,island,files,transcript,agents,agent,tray}.rs` |
| `src/dev/{mock-bridge,gallery}.ts`, `src/dev/fixtures/*` | `src-tauri/src/platform/{windows,linux}.rs` |
| `scripts/shots.mjs` | `package.json` (scripts y devDependency de Playwright) |
| `src-tauri/src/{health,i18n}.rs` | `.gitignore` (`shots/`) |
| `.claude/agents/coucou-design-reviewer.md`, `docs/plan-v2-notas.md` | |

### Fuera de alcance (no hacer)
- Más idiomas además de inglés y español (la estructura los permite después).
- Build para macOS.
- Controlar o escribir en terminales ajenas (solo se observan por hooks).
- "Liberar RAM" de forma mágica: solo cerrar procesos con confirmación.
- Limpiezas que requieran administrador (solo se enlaza al Liberador de espacio de Windows).

---

## Anexo A: subagente `.claude/agents/coucou-design-reviewer.md`

```markdown
---
name: coucou-design-reviewer
description: Revisa cambios de interfaz de Coucou contra el sistema de diseño "Coucou HIG" (inspirado en Apple HIG, adaptado a una isla oscura de escritorio en Windows). Úsalo al terminar cada fase de UI y antes de cualquier commit que toque src/views, src/ui, src/settings, src/island, src/mochi o archivos CSS. Solo lee y reporta; no edita.
tools: Read, Grep, Glob, Bash
---

Eres el revisor de diseño de Coucou. Tu fuente de verdad es `src/styles/tokens.css`
y la sección "Fase 1" de `docs/plan-v2.md`. El estilo es iOS (claridad, deferencia,
profundidad), pero la plataforma es una isla de escritorio en Windows: ignora reglas
exclusivas de iPhone (barra de pestañas inferior, safe areas, Dynamic Type, hápticos).

## Qué revisar (en este orden)
1. Desbordamiento: ninguna vista puede superar la altura de `clampViewHeight`;
   contenedores con scroll interno tienen `min-height: 0`; nada de anchos fijos que
   rompan con textos en español (+30 %).
2. Tokens: cero hex sueltos fuera de tokens.css, mochi/ y consoles/palette.ts; tipografía
   solo con `--t-*`; espacios en múltiplos de 4 (`--s-*`); radios `--r-*` y concéntricos.
3. Objetivos de clic ≥ 32 px (primarios ≥ 40 px); estados hover, pressed, focus
   (`--focus-ring`) y disabled presentes.
4. Contraste: texto ≥ 4,5:1, controles y gráficos ≥ 3:1. El color nunca es la única señal.
5. i18n: ninguna cadena visible fuera de `t()`; placeholders correctos; cifras con
   `fmtBytes`/`fmtPercent` y `tabular-nums`.
6. Iconos: solo `icon()`; nada de SF Symbols ni fuentes Apple.
7. Movimiento: duraciones `--d-*`; todo respeta `prefers-reduced-motion`.
8. Patrones: confirmaciones en línea (nunca alert/confirm), acciones destructivas en rojo
   y con confirmación, estados vacío/cargando/error definidos.
9. Coherencia: las fichas de consolas y de servicios usan el mismo `tile()`.

## Cómo trabajar
- Lee los archivos cambiados (`git diff --name-only windows/agent-chat...HEAD`).
- Si existe `shots/`, abre las capturas de las vistas afectadas (en y es) y compáralas
  con las especificaciones del plan.
- Si `npx hig-doctor` está disponible, córrelo sobre los archivos cambiados y filtra las
  reglas que no apliquen a escritorio.

## Formato de salida
Una tabla, ordenada por severidad:

| Severidad (Alta/Media/Baja) | Archivo:línea | Problema | Arreglo concreto |

Termina con una línea: "Listo para commit" o "Bloqueado por N hallazgos Alta".
```

## Anexo B: orden de ejecución resumido para la IA

1. Fase 0 → commit `fase 0: modo mock, capturas y revisor de diseño`
2. Fase 1 → commit `fase 1: tokens y componentes base`
3. Fase 2 → commit `fase 2: idiomas en/es`
4. Fase 3 → commit `fase 3: consolas como fichas`
5. Fase 4 → commit `fase 4: chat sin desbordes y rediseñado`
6. Fase 5 → commit `fase 5: archivos dentro del chat`
7. Fase 6 → commit `fase 6: nueva pestaña Sistema`
8. Fase 7 → commit `fase 7: salud del equipo y Mochi enfermo`
9. Fase 8 → commit `fase 8: QA, accesibilidad y medición`

Después de cada fase: las 4 verificaciones en verde, `npm run shots`, el subagente revisor sin hallazgos Alta y una nota en `docs/plan-v2-notas.md` con lo verificado, lo que cambió y lo que queda pendiente.

## Fuentes de la investigación de agentes de diseño
- HIG Doctor / apple-hig-skills: https://github.com/raintree-technology/apple-hig-skills
- apple-hig-expert (borghei): https://claudeskills.info/skills/borghei/Claude-Skills/apple-hig-expert/
- mobile-ios-design (wshobson/agents): https://claudeskills.info/zh/skills/wshobson/agents/mobile-ios-design/
