# Obsidian Flashcards

An Obsidian plugin for spaced repetition (SM-2) with deck schemas driven by per-folder config files.

## Features

- Config-file based deck discovery using `<deck_dir>.flashcards`.
- Required section schema per deck (default section parsing uses H1 headings like `# A`).
- Multiple study modes from one card schema (for example `A -> B`, `B -> C`).
- Separate memory history per mode, even for the same note.
- Deck picker and mode picker before each review session.
- Navigator context menu action `New Flashcard` for deck folders.
- Navigator context menu action `Batch Create Flashcards` for deck folders.
- AI completion button for card editing using Ollama or Volcano Engine.
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
  ],
  "ai": {
    "provider": "ollama",
    "model": "qwen2.5:latest",
    "prompts": {
      "A": {
        "B": "Generate section B from the content above. Output only the final section content."
      },
      "B": {
        "C": "Generate section C from the content above. Output only the final section content."
      }
    }
  }
}
```

Rules:

- `requiredSections` must be a non-empty string array.
- Every card note in this deck must include all required sections.
- `instances` must be a non-empty array.
- Each instance can be either `["PromptSection", "AnswerSection"]` or an object with `promptSection` and `answerSection` (optional `name`).
- `promptSection` and `answerSection` must exist in `requiredSections`.
- `ai` is optional.
- `ai.provider` supports `ollama` and `volcengine`.
- `ai.model` is the model name for the selected provider.
- `ai.prompts[source][target]` defines the prompt suffix used to generate one target section from one source section.

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
7. Use the bottom `Card Font` slider in the Flashcards view to set font size for the current deck (saved as that deck's default).
8. Optionally adjust `Default Card Font Size` in Settings -> Flashcards as a fallback for decks without a saved size.

Keyboard shortcuts in study view:

- `Space`: Show Answer
- `1`: Again
- `2`: Hard
- `3`: Good
- `4`: Easy

Editing while reviewing:

- Use `Edit Card` in the Flashcards footer to open the current card note in an editor tab.
- After editing, return to the Flashcards tab to continue review.

Quick note creation:

- In navigator, right-click a deck folder (one that has `<deck_dir>.flashcards`) and choose `New Flashcard`.
- The plugin creates a new note template with all required sections as empty H1 blocks.
- Default note name is `deckName.####` (four-digit index), for example `Swedish.0007`.

Batch note creation:

- Run command `Batch Create Flashcards` (or right-click a deck folder and choose `Batch Create Flashcards`).
- Select one section from the deck `requiredSections` as the input field to seed.
- Paste source text and set a delimiter. Default delimiter is `\n` (one new card per line).
- Confirm creation, then the plugin splits your input and creates one new card per segment.
- Each new card gets all required sections; only the selected section is pre-filled with that segment.

AI completion while editing:

- Open a flashcard note inside a configured deck.
- Use the status bar button `AI Complete` to batch-fill all incomplete cards in the current deck.
- Deck progress only counts eligible cards (cards that actually have a valid AI completion plan).
- Cards that are not eligible are skipped silently (not included in progress totals and not logged as skipped).
- Click `AI Complete` again while it is running to cancel remaining deck operations.
- `AI Complete Retry Count` in Settings controls retry attempts per card on AI failure (default: 3).
- Use command `AI Complete Current Flashcard` when you only want to fill the current note.
- The plugin finds the first required section that already has content and uses that as the source prompt.
- It then looks for the first empty required section that has an `ai.prompts[source][target]` mapping.
- The note content plus that configured prompt suffix is sent to the configured AI provider, and the returned text is written into the target section.

Volcano Engine example:

```json
{
  "requiredSections": ["Swedish", "Chinese"],
  "instances": [
    ["Swedish", "Chinese"]
  ],
  "ai": {
    "provider": "volcengine",
    "model": "ep-20250427000000-xxxx",
    "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
    "apiKey": "YOUR_VOLCENGINE_API_KEY",
    "prompts": {
      "Swedish": {
        "Chinese": "Translate the Swedish text above into natural Chinese. Output only the Chinese section content."
      }
    }
  }
}
```

Notes:

- `provider` supports `ollama` and `volcengine`.
- `volcengine` uses the OpenAI-compatible `chat/completions` interface.
- `apiKey` is required for `volcengine`.

## Development

```bash
npm install
npm run build
npm run dev
```
