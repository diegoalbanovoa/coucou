# Design

## Context

Today's chat path: `windows/src/views/chat.ts` calls `Bridge.agentSend(cli, prompt)` → Tauri command `agent_send` (`lib.rs:523`) → `agent::send()` (`agent.rs`), which spawns the chosen CLI as a subprocess, parses its `stream-json` stdout line by line via `Stream::line()`, and emits `agent::Turn` values (`Text { text }` or `Step { label }`) on the `"agent-turn"` event as they arrive. The final full reply is also the command's resolved return value. `agent_cancel` sets an `AtomicBool` the running turn's loop checks.

CLI identity and capability live in `consoles.rs`'s fixed `CLIS: &[Cli]` table (compiled in) plus a per-CLI JSON file in `agents.rs` (`AgentConfig`, user-editable extras like `extraArgs`/`extraDirs`). Neither has a concept of "no tools" or "HTTP endpoint" — they're built entirely around spawning a local executable.

API keys live in `secrets.rs`, gated by a **fixed, compiled-in** `KNOWN_KEYS: &[&str]` of 9 exact names (`anthropic-api-key`, `n8n-url`, etc.) — `entry()` returns `None` for anything not in that list, so nothing outside it can be read, written, or even checked for presence.

`reqwest` is already a dependency (`json`, `rustls-tls` features, no `stream` feature). `integrations.rs` shows the house pattern for a configured client (`Client::builder().timeout(TIMEOUT)`).

See proposal.md for motivation and explicit scope boundaries (no tools, not reviving the old Claude-API chat, no new crate).

## Goals / Non-Goals

**Goals:**
- Chat through any OpenAI-compatible HTTP endpoint, streaming, with a saved profile (base URL + model + optional key).
- Keys never leave the OS keychain.
- Reuse the existing streaming event shape and chat rendering rather than building a parallel UI.
- Zero new crates, zero new Cargo feature flags.

**Non-Goals:**
- Tool access of any kind for a provider-profile turn (Fase 2's job, later, for both CLI and provider profiles alike — out of this change entirely).
- Images beyond what the plan's "Listo cuando" asks (text and images in, text out) — no file attachments beyond what the chat already supports for CLI turns.
- Multi-turn tool loops, function calling, or any OpenAI "tools" API field — a provider profile never sends one.
- Reasoning/thinking-token display — pass through as plain text if an endpoint sends it mixed into content; no special UI for it.

## Decisions

**1. A new `providers.rs` module, not an extension of `agents.rs`.**
`AgentConfig` is built entirely around spawning an executable (`exe`, `promptArgs`, `extraDirs` for a CLI's filesystem reach). A provider profile has none of that — base URL, model, key-presence flag. Bolting it onto `AgentConfig` with those fields left empty would make every reader of `AgentConfig` need to ask "is this actually a CLI?" forever.
- *Alternative considered*: add an `is_provider: bool` flag and HTTP fields to `AgentConfig`. Rejected — exactly the kind of conflation the plan's own proposal explicitly warns against, and it would make `consoles.rs`'s `CLIS` table (compiled-in, CLI-only) and the user-editable provider list two different lifecycles pretending to be one type.

**2. Extend `secrets.rs`'s validation, not its fixed list.**
Add a second acceptance path in `entry()`: a key matching `^provider-profile-[a-z0-9-]{1,64}-api-key$` (profile id restricted to a safe slug charset at creation time) is accepted alongside exact membership in `KNOWN_KEYS`. `KNOWN_KEYS` itself — the 9 fixed names — is not touched.
- *Why*: profiles are created by the user at runtime with arbitrary ids; a compile-time list can't enumerate them. A regex-gated prefix keeps the same safety property (`entry()` still refuses anything outside a known shape) without needing a recompile per profile.
- *Alternative considered*: a single shared key (`provider-api-key`) covering all profiles. Rejected — the plan asks for multiple simultaneous profiles (e.g. one OpenRouter, one LM Studio), each needing its own key remembered independently.

**3. SSE read loop via `Response::chunk()`, not `bytes_stream()`.**
`reqwest::Response::chunk()` is available without the `stream` Cargo feature (that feature only adds the `futures_core::Stream` trait impl for `.bytes_stream()`). A manual `while let Some(chunk) = resp.chunk().await?` loop, buffering partial lines and splitting on `\n\n`-delimited SSE events, parsing `data: {...}` JSON per the OpenAI streaming shape (`choices[0].delta.content`), is enough.
- *Why*: ties with the proposal's own "no new feature flag" constraint, and is a small, self-contained parser rather than pulling in `eventsource`-style crates for a format this simple.
- *Alternative considered*: add the `stream` feature and use `bytes_stream()` combinators. Rejected only for this change's size — revisit if a second streaming consumer appears and the manual loop starts feeling duplicated.

**4. Emit `agent::Turn::Text` on the existing `"agent-turn"` event, not a new event.**
`provider_send`'s streaming callback emits the same `agent::Turn::Text { text }` shape `agent_send` already does. `Turn::Step` is never emitted for a provider profile (no tools, nothing to label as a step).
- *Why*: `chat.ts`'s existing per-chunk rendering already listens for `"agent-turn"` and switches on `Turn`'s `kind` tag — reusing it means the rendering path needs zero new branches for "where did this text come from," only a routing decision at *send* time (which command to call), not at *render* time.
- *Alternative considered*: a separate `"provider-turn"` event. Rejected — would duplicate the streaming-text rendering logic in `chat.ts` for no behavioral difference.

**5. `State.selectedProvider: string | null`, mutually exclusive with `State.agentCli`.**
Selecting a provider profile clears `agentCli` (and vice versa) — never both set. The chat's send button checks whichever is non-null to decide `Bridge.providerSend` vs `Bridge.agentSend`.
- *Why*: matches the spec's "never both active for one turn" requirement directly, and mirrors the existing single-`agentCli` field rather than inventing a tagged-union type for what is, today, a binary choice.

**6. Ollama auto-detection is a plain GET, on demand, not a background poller.**
`ollama_detect` hits `http://127.0.0.1:11434/api/tags` with a short timeout (1-2s) only when the model picker opens, not on a timer. If it fails (not running, or blocked), the picker simply doesn't show Ollama models — not an error state (per the spec's own "absence, not a failure" scenario).
- *Why*: a background poller would be one more always-on timer for a picker that opens rarely; matches the project's general discipline of polling only while the relevant tab/picker is open (see `system.ts`'s `STATS_POLL_MS` pattern, which only runs while that pane is visible).

## Risks / Trade-offs

- **[Risk]** Not every OpenAI-compatible endpoint formats streaming chunks identically (some omit the final `[DONE]` marker, some send `finish_reason` differently). → **Mitigation**: treat stream end as "the connection closed" OR "`[DONE]` seen," whichever comes first; don't depend on `finish_reason` for anything the UI needs.
- **[Risk]** A key-validation regex that's too loose could let a crafted profile id collide with one of the 9 fixed `KNOWN_KEYS` names or something unexpected in the keychain namespace. → **Mitigation**: the profile id itself is generated by Coucou at creation time (not user-typed), from a restricted slug charset, and the `provider-profile-` prefix can't collide with any existing fixed key name.
- **[Trade-off]** No tool access means a provider-profile turn can't use the vault or the attached project the way a CLI turn can. Accepted explicitly — that's Fase 2's job, and conflating it here is exactly what the proposal rules out.

## Migration Plan

Purely additive. No existing provider/profile data exists yet to migrate. Rollback is deleting `providers.rs`, its Tauri commands, the `secrets.rs` regex addition, and the picker UI — `agent.rs`/`agents.rs`/`consoles.rs` are never touched, so rollback carries no risk to the existing CLI chat path.
