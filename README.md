# Obsidian Flashcards

An Obsidian plugin that turns any vault folder into a flashcard deck with **spaced-repetition** (SM-2 algorithm), inspired by AnkiDroid.

## Features

- **Automatic deck discovery** — any folder with at least one configured Markdown file becomes a deck.
- **Two card types**
  - **Basic** — Front → Back (one direction).
  - **Basic + Reversed** — generates two cards per note (Front→Back *and* Back→Front).
- **SM-2 spaced repetition** — four rating buttons (Again / Hard / Good / Easy) with next-due-date previews.
- **Daily limits** — configure max new cards and max reviews per session.
- **Clean study UI** — progress bar, card-type badge, rendered Markdown on both sides.
- **Folder context menu** — right-click any folder → *Set as Flashcard Deck*.
- **Persistent data** — review history saved automatically in `data.json`.
- **Nested deck protection** — parent/child deck folders are rejected to avoid scheduling conflicts.

## Card Format

Each `.md` file is one card. The default front is the **filename** and the default back is the **file content**.

Any folder that contains at least one file with flashcard frontmatter is treated as a deck.

Use YAML frontmatter to customise:

```yaml
---
flashcards: true
card_type: basic_reversed      # omit or "basic" for one-way cards
card_front: What is the capital of France?
---
Paris
```

| Frontmatter key | Values | Default |
|---|---|---|
| `flashcards` | `true` | Not set |
| `card_type` | `basic` \| `basic_reversed` | `basic` |
| `card_front` | Any string | Filename (no extension) |

Rules:
- A deck folder can contain nested note folders.
- A deck folder cannot contain another deck folder (no parent/child deck markers).

## Installation

1. Copy `main.js`, `manifest.json`, and `styles.css` into your vault's `.obsidian/plugins/obsidian-flashcards/` folder.
2. Enable the plugin in **Settings → Community Plugins**.

## Usage

1. Add frontmatter to at least one note in the folder you want as a deck (`flashcards: true`, `card_type`, or `card_front`).
2. Click the 🧠 ribbon icon (or run the *Open Flashcard Deck* command) to start a study session.
3. Press **Show Answer**, then rate your recall:
   - **Again** — didn't remember; repeats in 1 day.
   - **Hard** — remembered with difficulty.
   - **Good** — correct with some effort.
   - **Easy** — instant recall; longest interval.

## Development

```bash
npm install
npm run build   # production bundle → main.js
npm run dev     # watch mode
```
