# Spec Delta

## Purpose

Lets the chat talk to any OpenAI-compatible model endpoint — a local server like Ollama or LM Studio, or a cloud router like OpenRouter or LiteLLM — through a saved profile, with streaming and no tool access, independent of the agent-CLI chat path.

## ADDED Requirements

### Requirement: A provider profile has no tool access
A chat turn sent through a provider profile SHALL NOT read files, run commands, or reach any tool. It is text (and, where the plan allows, images) in and text out, nothing else.

#### Scenario: A turn asks for something only a tool could do
- **WHEN** the user asks the chat (while a provider profile is selected) to read a file or run a command
- **THEN** the reply is plain text from the model — no file is read, no command runs, and no permission card appears, because none was requested

### Requirement: A provider profile's API key is never exposed outside the OS keychain
A provider profile's API key SHALL be stored only in the OS credential store (via the existing `secrets.rs` mechanism) and SHALL NOT appear in `settings.json`, any config file on disk, or any value returned to the frontend.

#### Scenario: Reading back a saved profile
- **WHEN** the frontend asks for the list of saved provider profiles
- **THEN** each profile reports whether a key is set (a boolean), never the key's value

#### Scenario: Deleting a profile
- **WHEN** a provider profile is deleted
- **THEN** its stored key is removed from the OS keychain, not just from the profile list

### Requirement: Chatting through a provider profile streams the reply
The reply from a provider profile SHALL arrive incrementally as it is generated, not only once the full response is ready.

#### Scenario: A long reply
- **WHEN** a provider profile answers with a multi-paragraph reply
- **THEN** the chat shows text arriving progressively, the same way an agent-CLI turn already streams

### Requirement: Ollama is detected automatically when present
If a local Ollama server answers on its default port, its installed models SHALL be offered without the user typing a URL.

#### Scenario: Ollama is running locally
- **WHEN** Ollama is installed and running on this machine
- **THEN** its models appear as selectable without any manual profile setup

#### Scenario: Ollama is not running
- **WHEN** no local Ollama server answers
- **THEN** no Ollama models are offered, and nothing in the chat reports this as an error — it's an absence, not a failure

### Requirement: Recognizable errors show a plain-language card
An invalid key, an unknown model, no network reachability, or a quota/rate-limit response from the endpoint SHALL be shown as a readable error in the chat, not a raw error string or a silent failure.

#### Scenario: An invalid key
- **WHEN** a provider profile's stored key is rejected by its endpoint
- **THEN** the chat shows an error card naming the problem (invalid key), using the chat's existing error-bubble presentation

#### Scenario: No network
- **WHEN** a provider profile's endpoint cannot be reached at all
- **THEN** the chat shows an error card saying so, distinct from an invalid-key error

### Requirement: A CLI profile and a provider profile are never both active for one turn
Exactly one backend — an agent CLI or a provider profile — SHALL answer a given chat turn; selecting one SHALL deselect the other.

#### Scenario: Switching from a CLI to a provider profile
- **WHEN** the user switches the chat's picker from an agent CLI to a provider profile
- **THEN** the next turn goes to the provider profile only, and the agent CLI's own project/tool context does not apply to it
