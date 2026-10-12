# Proposal

## Why

Coucou's chat only runs through an installed **agent CLI** (`agent::send` in `agent.rs`, driving `claude`/`gemini`/`copilot`/etc. as subprocesses). That's the right default for tool-capable work, but it means chatting with a model needs an agent CLI installed and running locally — there's no way to just talk to a model through an API key or a local server like Ollama, LM Studio, or an OpenRouter-routed model, without an agent CLI in between. Plan v3 (Diego's own plan, Fase 1) asks for a chat-only path: any OpenAI-compatible endpoint, selectable per message, with its own model and key, and explicitly **no tools** — kept separate from the CLI profiles so the two concepts never get conflated.

## What Changes

- New **provider profile**: id, label, base URL, model name, and whether an API key is set (never the key itself) — one config shape covering OpenRouter, Ollama, LM Studio, LiteLLM, or any OpenAI-compatible endpoint.
- New Tauri commands to create/update/delete/list provider profiles and to send a chat turn through one, streaming via Server-Sent Events.
- Keys stored in the OS keychain through `secrets.rs`, under a new per-profile key naming scheme — **extends** `secrets.rs`'s fixed `KNOWN_KEYS` allowlist (today a hardcoded list of 9 exact names) to also accept a validated `provider-profile-<id>-api-key` pattern, since profiles are created by the user at runtime and can't be enumerated at compile time.
- A model picker in the chat, alongside the existing CLI picker — **not merged into it**: `consoles.rs`'s `CLIS` table stays exactly as it is; provider profiles live in their own list and their own Rust module, reusing only the streaming event shape (`agent::Turn::Text`) so the chat's existing rendering code doesn't need to branch on which kind of backend is replying.
- Automatic Ollama detection: if `http://127.0.0.1:11434` answers, its installed models are listed without the user typing a URL.
- Error cards (invalid key, unknown model, no network, quota exceeded) reusing the chat's existing error-bubble rendering (`role: "error"` messages), not a new UI pattern.
- i18n for every new string, in `en.ts` and `es.ts`.
- **BREAKING**: none. Chat with no provider profile configured, and no CLI running, behaves exactly as today (nothing to send to).

## Explicitly Out of Scope

- **No tools for provider profiles.** No file access, no shell, no permission cards. That's the CLI profiles' job (`agent.rs`/`consoles.rs`), untouched by this change. A later phase (Fase 2 of the same plan) adds tool access with approval — to its own capability, not this one.
- **Not reviving the old "Claude API" chat mode.** That mode (its own API key, no tools) was deliberately removed (`64684a2`, see the archived `island-claude-agent` change's `OUTCOME.md`). This is a different, broader concept — any OpenAI-compatible endpoint, not hardcoded to Anthropic — and does not reinstate the old code path.
- **No new crate, no new `reqwest` feature flag.** SSE can be read with `Response::chunk()` in a loop, already available in the `reqwest` version and feature set this project already depends on (`json`, `rustls-tls`) — streaming does not require the `stream` feature.

## Capabilities

### New Capabilities
- `island/provider-chat`: chat-only provider profiles (OpenRouter, Ollama, LM Studio, LiteLLM, or any OpenAI-compatible endpoint) — creating, selecting, and chatting through one, with streaming and no tool access.

### Modified Capabilities
_(none — greenfield OpenSpec project; no archived main specs exist yet)_

## Impact

- `windows/src-tauri/src/secrets.rs`: extend the key-validation logic to also accept `provider-profile-<id>-api-key` alongside the existing fixed `KNOWN_KEYS` list. `KNOWN_KEYS` itself is untouched.
- New `windows/src-tauri/src/providers.rs`: the `ProviderProfile` config shape (parallel to, not reusing, `agents.rs`'s `AgentConfig` — provider profiles have no `exe`/`promptArgs`/tool concepts at all), persisted under `config_dir()/providers/`, plus the HTTP/SSE request logic and Ollama auto-detection.
- `windows/src-tauri/src/lib.rs`: new Tauri commands (`provider_list`, `provider_save`, `provider_delete`, `provider_send`, `provider_cancel`, `ollama_detect`), registered in `generate_handler!`. `provider_send` emits `agent::Turn::Text` on the same `"agent-turn"` event `agent_send` already uses, so `chat.ts` needs minimal new event-handling.
- `windows/src/views/chat.ts`: a provider/model picker alongside the existing CLI picker; routes a send to `Bridge.providerSend` instead of `Bridge.agentSend` when a provider profile (not a CLI) is selected.
- `windows/src/core/bridge.ts`: new `Bridge` methods mirroring the new Tauri commands.
- `windows/src/core/state.ts`: a `selectedProvider` (or similar) alongside the existing `agentCli`, mutually exclusive — exactly one backend is active per turn.
- `windows/src/i18n/en.ts`, `es.ts`: new strings for the picker, the profile editor, and the error cards.
- No change to `agents.rs`, `consoles.rs`, or anything under the CLI-profile path.
