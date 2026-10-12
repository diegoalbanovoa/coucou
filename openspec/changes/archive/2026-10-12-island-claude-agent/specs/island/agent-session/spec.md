# Spec Delta

## Purpose

Lets the user turn the island's chat into a working Claude Code agent — reading, editing, and running commands in one project folder they explicitly attach — without opening a terminal.

## ADDED Requirements

### Requirement: No tool access without an attached project
The chat SHALL behave exactly as plain Q&A (text and the existing `web_search` tool only, no file or command tools offered to the model) whenever no project folder is attached.

#### Scenario: Fresh chat, nothing attached
- **WHEN** the user sends a message and no project is attached
- **THEN** the request includes no file or command tool definitions and no tool can be invoked

### Requirement: Exactly one attached project at a time
The user SHALL be able to attach a single project folder to the chat from the island, and attaching a new one SHALL replace any previously attached folder.

#### Scenario: Attaching a second folder replaces the first
- **WHEN** a project is already attached and the user attaches a different folder
- **THEN** the chat's tools now resolve only inside the new folder, and the old folder is no longer reachable by any tool

### Requirement: Detaching clears tool access immediately
The user SHALL be able to detach the current project, after which the chat SHALL return to the no-tools behavior from the very next message, even mid-conversation.

#### Scenario: Detach mid-conversation
- **WHEN** the user detaches the project while a chat history already exists
- **THEN** the next message is sent with no file or command tools, regardless of what was attached earlier in the same conversation

### Requirement: File tools are confined to the attached folder
Every file tool (read, write, edit, list) SHALL resolve paths only inside the attached project folder and SHALL fail with a tool error, not partial access, for any path that escapes it (including `..` traversal and absolute paths outside the folder).

#### Scenario: Path escape attempt
- **WHEN** the model requests a file tool with a path that resolves outside the attached folder
- **THEN** the tool returns an error result to the model and performs no filesystem access

### Requirement: Commands run inside the attached folder
The command tool SHALL execute with the attached project folder as its working directory and SHALL be unavailable when no project is attached.

#### Scenario: Command tool with nothing attached
- **WHEN** the model attempts to use the command tool while no project is attached
- **THEN** no command tool is offered in the request, so the model has nothing to call

### Requirement: Tool-use loop continues until the model is done
After executing a tool, the chat SHALL send the result back to the model and continue the conversation automatically, repeating for as many tool calls as the model makes in one turn, until the model responds without requesting another tool.

#### Scenario: Multi-step task in one user turn
- **WHEN** the user's message requires the model to read a file and then edit it
- **THEN** both tool calls happen within the same turn without the user sending another message, and the final reply reflects the result of both

### Requirement: Transcript shows tool activity
The island's chat view SHALL show, for each tool the model used, which tool ran and its target (file path or command), visible in the conversation alongside the model's text.

#### Scenario: User reviews what happened
- **WHEN** the model edits a file as part of answering
- **THEN** the chat transcript displays that an edit happened and which file, not just the model's final text
