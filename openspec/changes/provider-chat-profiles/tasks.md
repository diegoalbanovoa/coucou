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
- [x] 5.3 Extended the provider button's click handler (now async) to call `reloadProviders()` then list CLI rows (unchanged), saved-profile rows, and not-yet-saved Ollama rows (an already-saved Ollama model shows once, as a profile, not twice), plus an always-present "Add a provider…" row. Visually distinguished by a `globe` icon face instead of the CLI rows' mini-bot. **Not manually verified in a running window** — no GUI available in this environment; covered by `tsc --noEmit` and the full test suite instead.
- [x] 5.4 **Deviates from the plan's own framing — one click target per row, not an edit icon nested in a clickable row.** Clicking a saved profile's row opens the editor sheet (label/base URL/model/key fields, built with plain `h("input", …)` — no dedicated text-field component exists in `ui/`) pre-filled, with a destructive "Eliminar" and a primary "Guardar" that both saves and selects (`chooseProviderProfile`) in one action. A nested icon-button inside a `<button class="chat-menu-row">` would have been invalid HTML with two click handlers racing on one click; this avoids that entirely. The key field is write-only (never pre-filled, even when one is stored — `providerKeyPlaceholder` says so instead) and goes through the pre-existing generic `secret_set`, not a new command. Same verification caveat as 5.3.
- [x] 5.5 `submit()` now branches `agentCli → Bridge.agentSend`, else `selectedProvider → Bridge.providerSend`, else the existing "no agent CLI" rejection. **No `Bridge.providerCancel`** — the stop button already calls the shared `Bridge.agentCancel()` unconditionally (see 3.4/4.2), so this needed zero changes for cancellation. Also fixed `placeholder()`, which previously demanded an attached project even for a provider profile that has no tools and so needs no project at all. Same verification caveat as 5.3 for the live streaming/cancel behavior specifically.
- [x] 5.6 Added `providerErrorMessage()` in `chat.ts`, splitting providers.rs's stable `"<kind>:<detail>"` string (see 3.3's updated note) on its first `:` and mapping the three fixed kinds to i18n strings; an agent-CLI error is never in that shape and passes through unchanged (verified: it only narrows a provider error's display, never changes a CLI error's). Same verification caveat as 5.3 for seeing the three cases live.

## 6. i18n

- [x] 6.1 Added `chat.addProvider`/`editProvider`/`deleteProvider`/`deleteProviderConfirm`/`providerLabelField`/`providerUrlField`/`providerModelField`/`providerKeyField`/`providerKeyPresent`/`providerKeyPlaceholder`/`save`/`providerErrorInvalidKey`/`providerErrorNoNetwork`/`providerErrorRateLimited` to both `en.ts` and `es.ts`. Verify: `tests/i18n.test.mjs` 7/7 passing ("es has exactly the keys of en", no empty string, placeholder sets match).

## 7. Verification

- [x] 7.1 `cargo test` in `windows/src-tauri`: **122 passed, 0 failed, 6 ignored.** No regressions.
- [x] 7.2 `npm run test` in `windows/`: **188 passed, 0 failed** (includes the project's own "no literal UI string outside src/i18n" test, which would have caught an un-i18n'd string in the new picker/editor code). No regressions.
- [x] 7.3 `tsc --noEmit` and `cargo clippy --all-targets`: both clean.
- [ ] 7.4 **Not done — requires a human.** Manual end-to-end: chat with a local Ollama model (streaming, no key) and with one cloud provider via an API key (e.g. OpenRouter), switching the picker between them and an agent CLI, confirming exactly one backend answers each turn and no key ever appears in `config_dir()` on disk. This environment has no Ollama installed (confirmed in an earlier session) and no GUI access — the logic underneath is covered by the automated tests above, but nobody has looked at the actual picker, editor, or a real streamed reply yet.

## Workflow follow-up

- Once the tasks above are complete and verified, run `/opsx:archive` to move this change's specs into `openspec/specs/island/provider-chat/spec.md`.
