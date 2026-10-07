# Spec Delta

## Purpose

Gives the user the same Allow/Deny/Always control over tool calls the agent-session chat makes that they already have over Claude Code CLI permission requests, so a tiny chat window never silently touches files or runs commands.

## ADDED Requirements

### Requirement: Every tool call is gated by a permission card
Before executing any file or command tool requested by the model, the island SHALL show a permission card naming the tool and its target (file path, or command text) and SHALL NOT execute the tool until the user responds.

#### Scenario: Model requests an edit
- **WHEN** the model's response includes a tool_use for editing a file
- **THEN** the island shows a card naming the file before any write happens

### Requirement: Card offers Allow, Deny, and (except for commands) Always
The permission card SHALL offer Allow and Deny for every tool, and SHALL additionally offer Always for file tools only — never for the command tool.

#### Scenario: Command permission card
- **WHEN** the model requests the command tool
- **THEN** the card offers only Allow and Deny, with no Always option

#### Scenario: File permission card
- **WHEN** the model requests a file tool (read, write, edit, or list)
- **THEN** the card offers Allow, Deny, and Always

### Requirement: Always is remembered only for the current session
Choosing Always SHALL apply automatically to later calls of that same tool within the same attached project, for the rest of the running session, and SHALL NOT persist after Coucou restarts or after the project is detached and reattached.

#### Scenario: Restarting the app forgets Always
- **WHEN** the user chose Always for the edit tool, then quits and relaunches Coucou
- **THEN** the next edit request in the same project shows a fresh permission card

#### Scenario: Detach and reattach forgets Always
- **WHEN** the user chose Always for a tool, then detaches and reattaches the same folder
- **THEN** the next matching tool request shows a fresh permission card

### Requirement: Denial is reported back to the model, not silently dropped
When the user denies a tool call, the chat SHALL continue the conversation with a tool error result explaining the denial, so the model can respond to the user instead of the turn stalling.

#### Scenario: User denies a command
- **WHEN** the user clicks Deny on a command permission card
- **THEN** the model receives a tool_result indicating denial and produces a reply the user can read

### Requirement: Command calls always require a fresh decision
Even when Always has been granted for file tools in the same project, every command-tool call SHALL still show its own permission card with no automatic approval path.

#### Scenario: Always granted for edits, command still asks
- **WHEN** the user previously chose Always for the edit tool in this project, and the model then requests the command tool
- **THEN** a permission card appears for the command and is not auto-approved
