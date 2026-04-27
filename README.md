# Obsidian Flashcards

An Obsidian plugin for spaced repetition (SM-2) with deck schemas driven by per-folder config files.

## Features

- Config-file based deck discovery using `<deck_dir>.flashcards`.
- Required section schema per deck (default section parsing uses H1 headings like `# A`).
- Multiple study modes from one card schema (for example `A -> B`, `B -> C`).
- Separate memory history per mode, even for the same note.
- Deck picker and mode picker before each review session.
- Navigator context menu action `New Flashcard` for deck folders.
- Nested deck protection (parent/child deck directories are rejected).
- Daily limits for new cards and review cards.

## Deck Config

If a deck folder is named `deck_dir`, the config file must be named:

`deck_dir/deck_dir.flashcards`

Config format is JSON:

```json
{
  "requiredSections": ["A", "B", "C"],
  "instances": [
    ["A", "B"],
    { "name": "B-to-C", "promptSection": "B", "answerSection": "C" }
  ]
}
```

Rules:

- `requiredSections` must be a non-empty string array.
- Every card note in this deck must include all required sections.
- `instances` must be a non-empty array.
- Each instance can be either `["PromptSection", "AnswerSection"]` or an object with `promptSection` and `answerSection` (optional `name`).
- `promptSection` and `answerSection` must exist in `requiredSections`.

## Card Notes

Every markdown file under the deck directory is treated as a card note.

Example note:

```markdown
# A
Prompt content

# B
Answer content

# C
Extra context
```

## History Isolation

For one note `X`, different instances maintain separate SM-2 records.

- `A -> B` history is independent.
- `B -> C` history is independent.

## Nested Deck Rule

Deck directories cannot be nested. If `parent/parent.flashcards` exists, then `parent/child/child.flashcards` is not allowed.

## Installation

1. Copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/obsidian-flashcards/`.
2. Enable the plugin in Settings -> Community plugins.

## Usage

1. Create `<deck_dir>/<deck_dir>.flashcards`.
2. Prepare card notes with all required H1 sections.
3. Run Open Flashcard Deck (or click the ribbon icon).
4. Choose a deck directory.
5. Choose one configured deck mode.
6. Review cards with Again/Hard/Good/Easy.

Quick note creation:

- In navigator, right-click a deck folder (one that has `<deck_dir>.flashcards`) and choose `New Flashcard`.
- The plugin creates a new note template with all required sections as empty H1 blocks.

## Development

```bash
npm install
npm run build
npm run dev
```
