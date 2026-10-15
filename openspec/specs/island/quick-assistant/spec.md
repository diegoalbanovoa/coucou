# island/quick-assistant Specification

## Purpose
Lets the user reach a small set of approved actions — searching files, reading one allow-listed folder, opening an app, checking the Obsidian vault — from anywhere, via a global shortcut, without an agent CLI or an attached project in the loop.

## Requirements

### Requirement: Exactly four tools exist, and nothing else
The quick assistant SHALL expose only `search_files`, `read_approved_folder`, `open_app`, and `query_vault`. No write, delete, or execute action SHALL be reachable through it.

#### Scenario: Asking for something outside the four
- **WHEN** the user's request would need an action other than the four (for example, editing a file or running a command)
- **THEN** the quick assistant does not perform it and says it cannot, rather than approximating it with one of the four tools

### Requirement: Reading the allow-listed folder needs no per-call approval
A call to `read_approved_folder` targeting a folder the user has explicitly added to the allow-list SHALL run without a permission prompt.

#### Scenario: Reading inside the allow-listed folder
- **WHEN** `read_approved_folder` targets a path inside a folder on the allow-list
- **THEN** it runs immediately, no approval card appears

#### Scenario: Reading outside the allow-listed folder
- **WHEN** `read_approved_folder` targets a path outside every allow-listed folder
- **THEN** the call is refused outright — not routed to the approval card, since approving it would not make the target any more inside the allow-list

### Requirement: Every other tool call asks every time
`search_files`, `open_app`, and `query_vault` SHALL show an approval card and wait for a decision on every call — there is no "always allow" shortcut for any of the three.

#### Scenario: The same app opened twice
- **WHEN** `open_app` is called for the same app a second time in the same session
- **THEN** a new approval card appears for the second call too

### Requirement: The approval card names the tool and its target
A quick-assistant approval card SHALL show which tool is asking and what it would act on (a path, a search query, an app name), using the same visual component the island's hook-originated approval card already uses.

#### Scenario: A folder read request
- **WHEN** `read_approved_folder` requires approval (its target turned out to be outside the allow-list, so it was refused, or a future tool with no auto-approve path asks)
- **THEN** the card names the exact path, not just "read a folder"

### Requirement: The pause switch disables every quick-assistant tool at once
When the island is paused (`State.paused`, the existing tray "Pause" item), every quick-assistant tool call SHALL be refused without running, the same way a paused island already declines a hook permission request.

#### Scenario: A call made while paused
- **WHEN** any of the four tools is called while the island is paused
- **THEN** it is refused immediately, with no approval card and no action taken

### Requirement: Every tool call is recorded in a local action log
Each quick-assistant tool call SHALL be appended to a local, append-only log with what ran, when, its target, and whether it was approved, denied, or auto-approved. The log SHALL NOT leave the machine.

#### Scenario: Reviewing recent activity
- **WHEN** the user opens the action log from within the app
- **THEN** it shows the calls in order, including ones that were denied, not only the approved ones

### Requirement: A global-shortcut conflict is reported, not silent
If the configured shortcut cannot be registered because another app already holds it, the app SHALL tell the user, not fail silently.

#### Scenario: Another app owns the shortcut
- **WHEN** the chosen shortcut is already registered to another application
- **THEN** the settings UI shows that the shortcut could not be registered, naming the shortcut

### Requirement: The quick assistant never touches agent-CLI or provider-chat state
Opening or using the quick assistant SHALL NOT change `State.agentCli` or `State.selectedProvider`, and SHALL NOT route through `agent::send` or any agent-CLI subprocess.

#### Scenario: Using the quick assistant mid-CLI-conversation
- **WHEN** the quick assistant is used while an agent-CLI conversation is in progress in the main chat
- **THEN** the CLI conversation's state (its selected CLI, its history) is unchanged afterward
