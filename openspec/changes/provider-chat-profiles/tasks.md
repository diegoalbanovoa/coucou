# Tasks

## 1. Secrets: per-profile key storage

- [x] 1.1 In `windows/src-tauri/src/secrets.rs`, extend `entry()` to also accept a key matching `provider-profile-<slug>-api-key` (slug: `^[a-z0-9-]{1,64}$`) alongside exact membership in `KNOWN_KEYS`, which stays untouched. Verify: 6 new unit tests (accepted profile key, bad characters, empty/oversized slug, missing prefix/suffix, all 9 `KNOWN_KEYS` still accepted) — all passing.

## 2. Provider profile storage (Rust)

- [x] 2.1 Created `windows/src-tauri/src/providers.rs`: `ProviderProfile` (on disk: id/label/baseUrl/model) and `ProviderProfileView` (adds `keySet`, computed from `secrets::present()`, never stored). Persisted one JSON file per profile under `config_dir()/providers/`, same atomic-write-via-temp-file pattern as `agents.rs`. Verify: 8 unit tests, all passing.
- [x] 2.2 Ids generated via `agent::uuid_v4()` (bumped to `pub(crate)` and reused rather than duplicated — hex+hyphens is already exactly the charset task 1.1 validates). Verify: covered by `creating_two_profiles_with_the_same_label_gives_distinct_ids`.

## 3. HTTP/SSE request + streaming (Rust)

- [x] 3.1 Implemented the request builder in `providers::send` (`client()` with a 120s timeout — a chat turn, not a poller — vs. `integrations.rs`'s shorter one), `.bearer_auth(key)` only when a key is stored. Verify: covered by the end-to-end synthetic-stream test; no separate request-building test since reqwest's `RequestBuilder` isn't inspectable without sending it.
- [x] 3.2 SSE loop via `resp.chunk().await` (no new Cargo feature) with `drain_complete_lines`/`parse_sse_line` splitting the parsing from the I/O so it's testable without a real connection. Verify: 4 unit tests (partial-line buffering, delta extraction, `[DONE]`/blank/malformed lines ignored, full multi-chunk reassembly) — all passing.
- [x] 3.3 Status→error mapping (401/403→`InvalidKey`, 429→`RateLimited`, connect/timeout→`NoNetwork`, other→`Endpoint`, refined from the response body's `error.message` when present) in `classify_status`/`classify_transport_error`/`refine_with_body`. **Not unit-tested** — doing so needs a mock HTTP server (`wiremock` or similar), a new dev-dependency this task's own "no new crate" framing didn't anticipate; covered instead by 7.4's manual end-to-end check. Flagging rather than silently skipping.
- [x] 3.4 **Deviates from the plan — no separate `provider_cancel`.** `agent::Cancel`'s `arm`/`disarm` were bumped to `pub(crate)` and reused directly (the *same* Tauri-managed state `agent_cancel` already stops) rather than mirrored into a second type. Since exactly one turn is ever in flight regardless of backend (the spec's own requirement), one shared `Cancel` is correct, not a shortcut — see design.md decision 5. `agent_cancel` now stops a provider turn too; no new command needed. Verify: the `stop.load(Ordering::SeqCst)` check in `providers::send`'s loop mirrors `agent::send`'s exactly — not separately unit-tested (needs a slow/blocking mock endpoint to race against), covered by 7.4.

## 4. Tauri commands + registration

- [x] 4.1 Added `provider_list`, `provider_save` (creates when `id` is absent/empty, else updates — no `apiKey` field, see 4.2's note), `provider_delete` in `lib.rs`, registered in `generate_handler!`. Verify: `cargo build` clean, `cargo test` 121/0/6.
- [x] 4.2 Added `provider_send(app, profile_id, prompt) -> Result<String, String>`, emitting `agent::Turn::Text` on `"agent-turn"`. **No `provider_cancel`** — see 3.4; the existing `agent_cancel` command covers it. **Also no key field on `provider_save`** — the existing generic `secret_present`/`secret_set`/`secret_clear` commands (already exposed, used for the 9 fixed `KNOWN_KEYS`) work unchanged for `providers::key_for(id)` once 1.1 shipped; building key handling into `provider_save` too would have duplicated a command that already does exactly this. Not yet manually tested against a real endpoint — folded into 7.4.
- [x] 4.3 Added `ollama_detect() -> Vec<OllamaModel>`, GET to `127.0.0.1:11434/api/tags` with a 2s timeout, empty list on any failure. Verify: covered by `empty_ollama_response_shape_has_no_models` (parse-shape unit test); the live "Ollama running vs. stopped" manual check is folded into 7.4 (not yet done — no Ollama installed on this machine, confirmed in the Fase 0/Still-open CLI check from an earlier session).

## 5. Frontend: picker, profile editor, routing

- [x] 5.1 Added `Bridge.providerList`/`providerSave`/`providerDelete`/`providerSend`/`ollamaDetect` (no `providerCancel` — see 3.4/4.2) plus a `ProviderProfile` interface and `providerKeyFor(id)` helper in `windows/src/core/bridge.ts`.
- [x] 5.2 Added `State.selectedProvider: string | null`. Mutual exclusion lives in `island/agent.ts`'s `chooseProvider` (now also clears `selectedProvider`) and the new `chooseProviderProfile` (clears `agentCli`) — the only two places either field is set. Verify: new test "picking an agent CLI and a provider profile are mutually exclusive" in `tests/agent.test.mjs`, passing (16/16 in that file).
- [ ] 5.3 Extend the chat's model/console picker (`chat.ts`) to also list provider profiles (and auto-detected Ollama models) alongside CLIs, visually distinguished (no tool badge, since provider profiles never get one). Verify manually in `npm run tauri dev`.
- [ ] 5.4 A profile editor (create/edit/delete a provider profile: label, base URL, model, key) — reachable from the picker's "add a provider" entry. Verify manually: create, edit, delete a profile; confirm the key field is write-only (never redisplayed).
- [ ] 5.5 Route `send()` in `chat.ts` to `Bridge.providerSend` instead of `Bridge.agentSend` when `State.selectedProvider` is set, and to `Bridge.providerCancel` for the stop button. Verify manually: a provider-profile turn streams and can be cancelled mid-reply.
- [ ] 5.6 Map the error cases from 3.3 to the chat's existing `role: "error"` bubble rendering, with readable Spanish/English text per case (invalid key, no network, unknown model, quota). Verify manually by forcing each case (bad key, unreachable URL, bad model name).

## 6. i18n

- [ ] 6.1 Add every new string (picker labels, profile editor fields and buttons, error-card text) to both `windows/src/i18n/en.ts` and `windows/src/i18n/es.ts`. Verify: the project's own "no literal UI string outside src/i18n" test and the "es has exactly the keys of en" test both pass.

## 7. Verification

- [ ] 7.1 `cargo test` in `windows/src-tauri`: all new tests from groups 1-4 pass, no regressions in existing `secrets`/`agent`/`consoles` tests.
- [ ] 7.2 `npm run test` in `windows/`: no regressions in existing chat/hooks/i18n tests.
- [ ] 7.3 `tsc --noEmit` and `cargo clippy --all-targets`: clean.
- [ ] 7.4 Manual end-to-end: chat with a local Ollama model (streaming, no key) and with one cloud provider via an API key (e.g. OpenRouter), switching the picker between them and an agent CLI, confirming exactly one backend answers each turn and no key ever appears in `config_dir()` on disk.

## Workflow follow-up

- Once the tasks above are complete and verified, run `/opsx:archive` to move this change's specs into `openspec/specs/island/provider-chat/spec.md`.
