# Obsidian Flashcards

An Obsidian plugin that turns any vault folder into a flashcard deck with **spaced-repetition** (SM-2 algorithm), inspired by AnkiDroid.

## Features

- **Directory as deck** — every Markdown file in the configured folder is one flashcard.
- **Two card types**
  - **Basic** — Front → Back (one direction).
  - **Basic + Reversed** — generates two cards per note (Front→Back *and* Back→Front).
- **SM-2 spaced repetition** — four rating buttons (Again / Hard / Good / Easy) with next-due-date previews.
- **Daily limits** — configure max new cards and max reviews per session.
- **Clean study UI** — progress bar, card-type badge, rendered Markdown on both sides.
- **Folder context menu** — right-click any folder → *Set as Flashcard Deck*.
- **Persistent data** — review history saved automatically in `data.json`.

## Card Format

Each `.md` file is one card. The default front is the **filename** and the default back is the **file content**.

Use YAML frontmatter to customise:

```yaml
---
card_type: basic_reversed      # omit or "basic" for one-way cards
card_front: What is the capital of France?
---
Paris
```

| Frontmatter key | Values | Default |
|---|---|---|
| `card_type` | `basic` \| `basic_reversed` | `basic` |
| `card_front` | Any string | Filename (no extension) |

## Installation

1. Copy `main.js`, `manifest.json`, and `styles.css` into your vault's `.obsidian/plugins/obsidian-flashcards/` folder.
2. Enable the plugin in **Settings → Community Plugins**.

## Usage

1. Open **Settings → Flashcards** and set the *Deck Folder* path.
   - Or right-click any folder in the file explorer and choose **Set as Flashcard Deck**.
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
