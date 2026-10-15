// Fixture conversation for mock mode (see plan-v2.md § 0.2).
//
// Shaped like `KeptMessage` from `core/bridge.ts` (role/content/at/steps),
// typed locally for the same reason as fixtures/consoles.ts: nothing under
// `src/dev/` imports "../core/bridge", because that specifier is exactly what
// the mock-mode alias rewrites.
//
// 25 messages: one long enough to force internal scroll (20 000 chars), code
// blocks, a list, a table, a turn with recorded tool steps, and one failed
// turn — the shapes Fase 4's redesign has to hold without the chat growing
// past the screen.

/** Local copy of `KeptMessage` (minus attachments); see the header for why it is not imported. */
export interface MockMessage {
  role: "user" | "assistant" | "error";
  content: string;
  at: number;
  steps: string[];
}

const now = Date.now();
const minutesAgo = (n: number) => now - n * 60_000;

const LONG_MESSAGE = [
  "Aquí está el resumen completo que pediste. Voy a repasar cada módulo del plan v2 con el detalle suficiente para que no haga falta volver a preguntar — una sección por fase, en orden, con lo que cambia y por qué.\n",
  ...Array.from({ length: 48 }, (_, i) =>
    `## Sección ${i + 1}\n\nEsto es texto de relleno para forzar un mensaje largo de verdad: el chat tiene que hacer scroll por dentro sin que la isla crezca más allá del área de trabajo, sin ensanchar nada y sin que el compositor deje de verse. Línea de prueba número ${i + 1} con algo de \`código en línea\` y una palabra en **negrita** para ejercitar el renderizado de Markdown dentro de un bloque largo.\n`,
  ),
].join("\n");
// Pad/trim to exactly ~20 000 characters, per the plan's fixture spec.
const LONG_MESSAGE_20K = LONG_MESSAGE.length >= 20_000
  ? LONG_MESSAGE.slice(0, 20_000)
  : LONG_MESSAGE.padEnd(20_000, " ·");

/** The seeded conversation returned by the mock `chatLoad`. */
export const MOCK_CHAT_MESSAGES: MockMessage[] = [
  { role: "user", content: "hola", at: minutesAgo(180), steps: [] },
  {
    role: "assistant",
    content:
      "¡Hola! ¿En qué te ayudo hoy?\nVeo que estás en el repo `coucou`, en la rama `windows/correcciones-v2`. Dime qué quieres hacer.",
    at: minutesAgo(179),
    steps: [],
  },
  { role: "user", content: "revisa el estado del build y dime si hay algo roto", at: minutesAgo(175), steps: [] },
  {
    role: "assistant",
    content: "Todo en verde: 89 tests Rust, 121 TS, clippy y tsc limpios. Nada roto.",
    at: minutesAgo(174),
    steps: ["Ran cargo test --workspace", "Ran cargo clippy --all-targets", "Ran npm run test", "Ran tsc --noEmit"],
  },
  { role: "user", content: "¿puedes mostrarme un ejemplo de bloque de código?", at: minutesAgo(170), steps: [] },
  {
    role: "assistant",
    content:
      "Claro, aquí tienes uno en Rust:\n\n```rust\npub fn guard(root: &Path, candidate: &Path, now: SystemTime) -> bool {\n    match std::fs::symlink_metadata(candidate) {\n        Ok(meta) if meta.file_type().is_symlink() => return false,\n        Ok(meta) if !meta.is_file() => return false,\n        Err(_) => return false,\n        Ok(_) => {}\n    }\n    true\n}\n```\n\nY uno en TypeScript, para comparar:\n\n```ts\nexport function clampViewHeight(desired: number, max: number, min: number): number {\n  return Math.min(max, Math.max(min, desired));\n}\n```",
    at: minutesAgo(169),
    steps: [],
  },
  { role: "user", content: "dame una lista de lo que falta", at: minutesAgo(160), steps: [] },
  {
    role: "assistant",
    content:
      "Lo que queda del plan v2:\n\n- Fase 1: tokens y componentes base\n- Fase 2: idiomas en/es\n- Fase 3: consolas como fichas\n- Fase 4: chat sin desbordes\n- Fase 5: archivos dentro del chat\n- Fase 6: nueva pestaña Sistema\n- Fase 7: salud del equipo\n- Fase 8: QA final",
    at: minutesAgo(159),
    steps: [],
  },
  { role: "user", content: "¿y una tabla con los comandos nuevos?", at: minutesAgo(150), steps: [] },
  {
    role: "assistant",
    content:
      "| Comando | Fase |\n|---|---|\n| `console_rescan` | 3 |\n| `pick_files` | 5 |\n| `ingest_bytes` | 5 |\n| `inbox_thumb` | 5 |\n| `system_drives` | 6 |\n| `system_end_process` | 6 |\n| `health_state` | 7 |\n| `health_simulate` | 7 |",
    at: minutesAgo(149),
    steps: [],
  },
  { role: "user", content: "corre los tests del sistema", at: minutesAgo(140), steps: [] },
  {
    role: "assistant",
    content: "Listo, 12 tests de `system.rs` en verde, incluido el guard de procesos protegidos.",
    at: minutesAgo(139),
    steps: ["Ran cargo test --lib system::", "Read src-tauri/src/system.rs"],
  },
  { role: "user", content: "intenta algo que vaya a fallar, quiero ver un error", at: minutesAgo(130), steps: [] },
  {
    role: "error",
    content: "El turno falló: el CLI salió con código distinto de 0 antes de escribir una respuesta.",
    at: minutesAgo(129),
    steps: [],
  },
  { role: "user", content: "ok, reintenta", at: minutesAgo(128), steps: [] },
  {
    role: "assistant",
    content: "Reintentado — esta vez terminó bien.",
    at: minutesAgo(127),
    steps: [],
  },
  { role: "user", content: "mándame el resumen largo que tenías preparado", at: minutesAgo(90), steps: [] },
  { role: "assistant", content: LONG_MESSAGE_20K, at: minutesAgo(89), steps: [] },
  { role: "user", content: "gracias, con eso basta", at: minutesAgo(30), steps: [] },
  { role: "assistant", content: "Cuando quieras seguimos.", at: minutesAgo(29), steps: [] },
  { role: "user", content: "una última cosa: ¿accion con tilde se encuentra si busco sin tilde?", at: minutesAgo(10), steps: [] },
  {
    role: "assistant",
    content: "Sí — la búsqueda del chat normaliza y quita diacríticos, así que \"accion\" encuentra \"acción\".",
    at: minutesAgo(9),
    steps: [],
  },
  { role: "user", content: "perfecto", at: minutesAgo(5), steps: [] },
  { role: "assistant", content: "👍", at: minutesAgo(4), steps: [] },
  { role: "user", content: "eso es todo por ahora", at: minutesAgo(1), steps: [] },
];
