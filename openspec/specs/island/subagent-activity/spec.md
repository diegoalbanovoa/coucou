# island/subagent-activity Specification

## Purpose
Lets Diego see, inside the island's `system` view, which Claude Code subagent (e.g. `planificador`, `constructor`, `mecanico`) has been active recently and what it last did, without reading terminal scrollback.

## Requirements

### Requirement: Subagent activity is shown in the system view
The `system` view SHALL include a section listing recent Claude Code subagent activity, sourced from hook events the island already receives while running.

#### Scenario: A subagent's tool call appears live
- **WHEN** a hook event carrying a recognized subagent identity arrives while the island is running and the `system` view is open
- **THEN** that subagent's entry in the section updates to reflect the new action within the same render pass, with no page reload or manual refresh

#### Scenario: Opening the view after missing earlier activity
- **WHEN** the user opens the `system` view after subagent activity already happened earlier in the current app session
- **THEN** the section shows that earlier activity, not just activity from the moment the view was opened

### Requirement: One card per distinct subagent
The section SHALL render one card per distinct subagent identity seen, not a single merged list.

#### Scenario: Two subagents active in the same session
- **WHEN** both `constructor` and `mecanico` have reported activity
- **THEN** the section shows two separate cards, each labeled with its own subagent name and showing only that subagent's own recent actions

### Requirement: Bounded history per subagent
The section SHALL retain only a bounded, recent window of activity per subagent, so a long-running session does not grow this history without limit.

#### Scenario: A subagent is very active
- **WHEN** a single subagent reports more than 20 actions within the current app session
- **THEN** its card still shows at least its 20 most recent actions, and does not retain unbounded history for that subagent

### Requirement: Hook events without a subagent identity are tolerated
An event with no subagent identity (for example, from a Claude Code version older than 2.1.296, or from the main conversation rather than a subagent) SHALL NOT be treated as an error and SHALL NOT affect the island's existing per-CLI pill behavior.

#### Scenario: Older Claude Code version
- **WHEN** a hook event arrives with no subagent identity field present
- **THEN** the subagent-activity section simply does not add an entry for it, and every other island behavior (pills, approvals, chat) continues exactly as before this change

### Requirement: No new on-disk read for this view
This feature SHALL populate the subagent-activity section only from hook events the island already receives while running, and SHALL NOT read any file from disk to do so.

#### Scenario: Coucou was not running when a subagent ran
- **WHEN** a subagent ran at some point while Coucou's island was not open
- **THEN** that activity does not retroactively appear in the section once the island opens later — only activity that happened while the island was running is shown
