# Outcome

The goal of this change shipped. The design in `design.md` did not, and the
tasks in `tasks.md` were never worked through, so neither should be read as a
description of the code.

Not archived: `tasks.md` gates that on the user reviewing the diff, and this
note is here so that review starts from what is true.

## What shipped instead

The island's chat runs the **agent CLI already installed on the machine** —
`claude -p` first among them — rather than an agent loop built inside
`claude.rs` against the Anthropic API.

The reasoning is in the header of `windows/src-tauri/src/agent.rs`, and it is
the short version of why `design.md` was abandoned: an own loop needs an API
key, reimplements a worse version of tools the CLI already ships, and knows
nothing about the user's CLAUDE.md, skills or MCP servers. Shelling out gets
the real agent, on the user's own subscription.

Permissions came for free, which was the deciding argument. The session Coucou
spawns runs the hooks in `~/.claude/settings.json`, so its PreToolUse and
PermissionRequest events reach the island through `coucou-hook` and the named
pipe exactly as any terminal session's do, and the island's existing
Allow/Deny card answers them. Headless mode has no terminal to fall back on,
so the island is the only thing that *can* answer.

Commits, oldest first:

| Commit | What |
|---|---|
| `76f658b` | The chat runs a CLI; folder picker and its E2E suite |
| `06c4b87` | The project and session survive a restart; attach resolves to the project root |
| `c380664` | The reply streams as it is written; Markdown; stop; errors in the log |
| `16f32c2` | The start screen lists the CLIs found; the API-key mode goes |
| `dda8f68` | The Obsidian vault is detected, not hard-coded; the conversation is kept |
| `65a59f2` | A turn the CLI reports as failed is no longer shown as a reply |
| `8db0f0c` | Live tests that run real turns, `#[ignore]`d |
| `64684a2` | `claude.rs` and the API chat removed |
| `03169d4` | A debug build must not own the Windows login entry |

## The spec deltas, requirement by requirement

`specs/island/agent-session` — the user-visible requirements hold, by a
different mechanism:

- *Exactly one attached project at a time*, and *attaching a second replaces
  the first*: `agent::Project`, tested. Attaching now also resolves to the
  project root, so pointing at `windows/src` attaches the repo.
- *Detaching clears tool access immediately*: the CLI is spawned with the
  project as its working directory, so with nothing attached there is no turn
  to run at all — the chat says so instead of answering without tools.
- *File tools confined to the attached folder*: now Claude Code's own
  boundary, not ours. It refuses writes outside its working directory unless
  the directory is named with `--add-dir`, which is how the Obsidian vault is
  reached and the only thing that is.
- *No tool access without an attached project*: moot in the stronger sense
  above. The `web_search`-only plain Q&A case it describes no longer exists:
  the API chat is gone (`64684a2`).

`specs/island/agent-permissions` — delivered by the hook relay rather than by
a second permission broker. One consequence worth stating plainly: the
Allow/Deny card, and the Always set, are **Claude Code's**, not ours. So

- the card names the tool and its target, and nothing runs until the user
  answers — as specified, because these are the same cards the hooks already
  drive;
- *Always for file tools, never for commands* is Claude Code's own policy, not
  a rule this code enforces;
- and the requirement cannot be met at all for the other CLIs in the table:
  Coucou installs Claude Code's hooks only, so a `gemini` or `codex` turn has
  no way to ask. The agent picker says which CLIs stream and resume; it does
  not yet say which can be approved from the island.

## Still open

- Permission cards for agent CLIs other than Claude Code.
- Of the seven CLIs in `agent::CLIS`, only `claude`, `gemini` and `copilot`
  have been run from Coucou on a real machine; `codex`, `cursor-agent`, `qwen`
  and `opencode` are driven the way their own documentation says.
