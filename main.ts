import {
	App,
	ItemView,
	MarkdownRenderer,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	WorkspaceLeaf,
} from "obsidian";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Two card types, inspired by AnkiDroid. */
type CardType = "basic" | "basic_reversed";

/**
 * Rating given by the learner after reviewing a card.
 *   0 = Again  (complete blackout)
 *   1 = Hard   (significant difficulty)
 *   2 = Good   (correct with some effort)
 *   3 = Easy   (perfect, immediate recall)
 */
type Rating = 0 | 1 | 2 | 3;

/** Persistent record for one "side" of a flashcard. */
interface CardRecord {
	/** Path of the source note file. */
	path: string;
	cardType: CardType;
	/** true when this record represents the reversed side of a basic_reversed card. */
	isReversed: boolean;
	/** Number of successful consecutive reviews. */
	repetitions: number;
	/** SM-2 ease factor (starts at 2.5). */
	easeFactor: number;
	/** Current review interval in days. */
	interval: number;
	/** Timestamp (ms) when the card is next due. */
	dueDate: number;
}

/** Shape of the persisted data.json. */
interface PluginStoredData {
	settings: FlashcardsSettings;
	cards: Record<string, CardRecord>;
}

interface FlashcardsSettings {
	deckFolder: string;
	newCardsPerDay: number;
	maxReviewsPerDay: number;
}

const DEFAULT_SETTINGS: FlashcardsSettings = {
	deckFolder: "",
	newCardsPerDay: 20,
	maxReviewsPerDay: 100,
};

const DEFAULT_EASE = 2.5;
const MIN_EASE = 1.3;
const MS_PER_DAY = 86_400_000;

/** View type identifier. */
const VIEW_TYPE_FLASHCARD = "flashcard-study-view";

// ─────────────────────────────────────────────────────────────────────────────
// SM-2 Spaced-Repetition Algorithm
// ─────────────────────────────────────────────────────────────────────────────

/** Maps Rating 0–3 to SM-2 quality 0–5. */
const QUALITY: readonly number[] = [1, 3, 4, 5];

/**
 * Compute the next interval (days) without mutating the record.
 * Used both for scheduling and for the "preview" labels on rating buttons.
 */
function nextInterval(rating: Rating, rec: CardRecord): number {
	const q = QUALITY[rating];
	if (q < 3) return 1; // failed → reset to 1 day
	if (rec.repetitions === 0) return 1;
	if (rec.repetitions === 1) return 6;
	return Math.round(rec.interval * rec.easeFactor);
}

/** Apply a rating to a card record and return the updated record. */
function applyRating(rec: CardRecord, rating: Rating): CardRecord {
	const q = QUALITY[rating];
	const interval = nextInterval(rating, rec);
	const repetitions = q < 3 ? 0 : rec.repetitions + 1;

	let easeFactor = rec.easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
	if (easeFactor < MIN_EASE) easeFactor = MIN_EASE;

	const dueDate = Date.now() + interval * MS_PER_DAY;
	return { ...rec, repetitions, easeFactor, interval, dueDate };
}

/** Human-readable interval label shown above each rating button. */
function formatInterval(rating: Rating, rec: CardRecord): string {
	const d = nextInterval(rating, rec);
	if (d < 2) return "1d";
	if (d < 7) return `${d}d`;
	if (d < 30) return `${Math.round(d / 7)}w`;
	if (d < 365) return `${Math.round(d / 30)}mo`;
	return `${Math.round(d / 365)}y`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Remove YAML frontmatter block from raw markdown content. */
function stripFrontmatter(raw: string): string {
	if (!raw.startsWith("---")) return raw;
	const end = raw.indexOf("\n---", 3);
	if (end === -1) return raw;
	return raw.slice(end + 4).trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Flashcard View
// ─────────────────────────────────────────────────────────────────────────────

/** A card scheduled for the current study session. */
interface StudyCard {
	/** Storage key in plugin.cardData (path or path+"::rev"). */
	id: string;
	file: TFile;
	cardType: CardType;
	isReversed: boolean;
	isNew: boolean;
}

export class FlashcardView extends ItemView {
	private plugin: FlashcardsPlugin;
	private queue: StudyCard[] = [];
	private idx = 0;
	private revealed = false;

	constructor(leaf: WorkspaceLeaf, plugin: FlashcardsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_FLASHCARD;
	}
	getDisplayText(): string {
		return "Flashcards";
	}
	getIcon(): string {
		return "brain";
	}

	async onOpen(): Promise<void> {
		await this.startSession();
	}

	/** (Re-)build the study queue and render the first card. */
	async startSession(): Promise<void> {
		await this.buildQueue();
		this.idx = 0;
		this.revealed = false;
		this.render();
	}

	// ── Queue building ─────────────────────────────────────────────────────

	private async buildQueue(): Promise<void> {
		const { deckFolder, newCardsPerDay, maxReviewsPerDay } =
			this.plugin.settings;

		if (!deckFolder) {
			this.queue = [];
			return;
		}

		const folder = this.app.vault.getAbstractFileByPath(deckFolder);
		if (!(folder instanceof TFolder)) {
			this.queue = [];
			return;
		}

		const files = this.collectMdFiles(folder);
		const now = Date.now();
		const due: StudyCard[] = [];

		for (const file of files) {
			const cardType = this.resolveCardType(file);

			// ── Forward card ──────────────────────────────────────────────
			const id = file.path;
			if (!this.plugin.cardData[id]) {
				this.plugin.cardData[id] = this.makeRecord(
					file.path,
					cardType,
					false,
					now,
				);
			} else {
				this.plugin.cardData[id].cardType = cardType;
			}
			if (this.plugin.cardData[id].dueDate <= now) {
				due.push({
					id,
					file,
					cardType,
					isReversed: false,
					isNew: this.plugin.cardData[id].repetitions === 0,
				});
			}

			// ── Reversed card (only for basic_reversed) ───────────────────
			if (cardType === "basic_reversed") {
				const revId = file.path + "::rev";
				if (!this.plugin.cardData[revId]) {
					this.plugin.cardData[revId] = this.makeRecord(
						file.path,
						cardType,
						true,
						now,
					);
				} else {
					this.plugin.cardData[revId].cardType = cardType;
				}
				if (this.plugin.cardData[revId].dueDate <= now) {
					due.push({
						id: revId,
						file,
						cardType,
						isReversed: true,
						isNew: this.plugin.cardData[revId].repetitions === 0,
					});
				}
			}
		}

		await this.plugin.persistData();

		// Apply daily limits (new cards first, then reviews by due date).
		const newCards = due
			.filter((c) => c.isNew)
			.slice(0, newCardsPerDay);
		const reviews = due
			.filter((c) => !c.isNew)
			.sort(
				(a, b) =>
					this.plugin.cardData[a.id].dueDate -
					this.plugin.cardData[b.id].dueDate,
			)
			.slice(0, maxReviewsPerDay);

		this.queue = [...newCards, ...reviews];
	}

	private makeRecord(
		path: string,
		cardType: CardType,
		isReversed: boolean,
		now: number,
	): CardRecord {
		return {
			path,
			cardType,
			isReversed,
			repetitions: 0,
			easeFactor: DEFAULT_EASE,
			interval: 1,
			dueDate: now,
		};
	}

	private collectMdFiles(folder: TFolder): TFile[] {
		const files: TFile[] = [];
		for (const child of folder.children) {
			if (child instanceof TFile && child.extension === "md") {
				files.push(child);
			} else if (child instanceof TFolder) {
				files.push(...this.collectMdFiles(child));
			}
		}
		return files;
	}

	/** Read card_type from YAML frontmatter, default to "basic". */
	private resolveCardType(file: TFile): CardType {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return fm?.card_type === "basic_reversed" ? "basic_reversed" : "basic";
	}

	/** Return the front and back strings for a note. */
	private async getContent(
		file: TFile,
	): Promise<{ front: string; back: string }> {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const raw = await this.app.vault.read(file);
		const front = fm?.card_front ? String(fm.card_front) : file.basename;
		const back = stripFrontmatter(raw);
		return { front, back };
	}

	// ── Rendering ─────────────────────────────────────────────────────────

	private render(): void {
		const el = this.contentEl;
		el.empty();
		el.addClass("flashcard-container");

		if (!this.plugin.settings.deckFolder) {
			this.renderMessage(
				el,
				"⚙️ No deck folder configured",
				"Open Settings → Flashcards and set the Deck Folder path.",
			);
			return;
		}

		if (this.queue.length === 0) {
			this.renderMessage(
				el,
				"🎉 All caught up!",
				"No cards are due for review right now.",
			);
			return;
		}

		if (this.idx >= this.queue.length) {
			this.renderComplete(el);
			return;
		}

		// Fire-and-forget; DOM updates happen asynchronously.
		void this.renderCard(el);
	}

	private renderMessage(
		el: HTMLElement,
		title: string,
		body: string,
	): void {
		const wrap = el.createDiv({ cls: "flashcard-state" });
		wrap.createEl("div", { cls: "flashcard-state-icon", text: title });
		wrap.createEl("p", { cls: "flashcard-state-body", text: body });
		const btn = wrap.createEl("button", {
			cls: "flashcard-btn flashcard-btn-primary",
			text: "Refresh",
		});
		btn.addEventListener("click", () => void this.startSession());
	}

	private renderComplete(el: HTMLElement): void {
		const wrap = el.createDiv({ cls: "flashcard-state" });
		wrap.createEl("div", { cls: "flashcard-state-icon", text: "🎉" });
		wrap.createEl("h2", { cls: "flashcard-state-title", text: "Session Complete!" });
		wrap.createEl("p", {
			cls: "flashcard-state-body",
			text: `You reviewed ${this.queue.length} card(s).`,
		});
		const btn = wrap.createEl("button", {
			cls: "flashcard-btn flashcard-btn-primary",
			text: "Start New Session",
		});
		btn.addEventListener("click", () => void this.startSession());
	}

	private async renderCard(el: HTMLElement): Promise<void> {
		const card = this.queue[this.idx];
		const rec = this.plugin.cardData[card.id];
		const { front, back } = await this.getContent(card.file);

		// ── Header ──────────────────────────────────────────────────────
		const header = el.createDiv({ cls: "flashcard-header" });

		// Progress text + bar
		const progRow = header.createDiv({ cls: "flashcard-progress-row" });
		progRow.createSpan({
			cls: "flashcard-progress-text",
			text: `${this.idx + 1} / ${this.queue.length}`,
		});

		const bar = header.createDiv({ cls: "flashcard-progress-bar" });
		bar.createDiv({
			cls: "flashcard-progress-fill",
			attr: {
				style: `width:${(this.idx / this.queue.length) * 100}%`,
			},
		});

		// Meta row: card type + new/review badge
		const meta = header.createDiv({ cls: "flashcard-meta" });
		const typeLabel = card.isReversed
			? "Basic (Reversed)"
			: card.cardType === "basic_reversed"
			? "Basic + Reversed"
			: "Basic";
		meta.createSpan({ cls: "flashcard-type-label", text: typeLabel });
		if (rec.repetitions === 0) {
			meta.createSpan({ cls: "flashcard-badge flashcard-badge-new", text: "New" });
		} else {
			meta.createSpan({
				cls: "flashcard-badge flashcard-badge-review",
				text: `${rec.interval}d`,
			});
		}

		// ── Card face ────────────────────────────────────────────────────
		const cardEl = el.createDiv({ cls: "flashcard-card" });

		// Front (or Back if reversed)
		const frontSide = cardEl.createDiv({ cls: "flashcard-side" });
		frontSide.createDiv({
			cls: "flashcard-side-label",
			text: card.isReversed ? "Back" : "Front",
		});
		const frontContent = frontSide.createDiv({ cls: "flashcard-content" });
		await this.renderMarkdown(
			card.isReversed ? back : front,
			frontContent,
			card.file.path,
		);

		// Revealed answer
		if (this.revealed) {
			cardEl.createDiv({ cls: "flashcard-divider" });
			const backSide = cardEl.createDiv({ cls: "flashcard-side" });
			backSide.createDiv({
				cls: "flashcard-side-label",
				text: card.isReversed ? "Front" : "Back",
			});
			const backContent = backSide.createDiv({ cls: "flashcard-content" });
			await this.renderMarkdown(
				card.isReversed ? front : back,
				backContent,
				card.file.path,
			);
		}

		// ── Footer ───────────────────────────────────────────────────────
		const footer = el.createDiv({ cls: "flashcard-footer" });

		if (!this.revealed) {
			const showBtn = footer.createEl("button", {
				cls: "flashcard-btn flashcard-btn-show",
				text: "Show Answer",
			});
			showBtn.addEventListener("click", () => {
				this.revealed = true;
				this.render();
			});
		} else {
			const ratingBar = footer.createDiv({ cls: "flashcard-rating-bar" });
			const ratings: [string, Rating, string][] = [
				["Again", 0, "flashcard-btn-again"],
				["Hard", 1, "flashcard-btn-hard"],
				["Good", 2, "flashcard-btn-good"],
				["Easy", 3, "flashcard-btn-easy"],
			];
			for (const [label, rating, cls] of ratings) {
				const wrap = ratingBar.createDiv({ cls: "flashcard-rating-cell" });
				wrap.createDiv({
					cls: "flashcard-interval-label",
					text: formatInterval(rating, rec),
				});
				const btn = wrap.createEl("button", {
					cls: `flashcard-btn ${cls}`,
					text: label,
				});
				btn.addEventListener("click", () => void this.submitRating(card.id, rating));
			}
		}
	}

	private async renderMarkdown(
		markdown: string,
		el: HTMLElement,
		sourcePath: string,
	): Promise<void> {
		try {
			await MarkdownRenderer.render(this.app, markdown, el, sourcePath, this);
		} catch (err) {
			// Fallback for unexpected rendering errors
			console.error("Flashcards: MarkdownRenderer failed", err);
			el.createEl("pre", { text: markdown });
		}
	}

	private async submitRating(cardId: string, rating: Rating): Promise<void> {
		const rec = this.plugin.cardData[cardId];
		if (rec) {
			this.plugin.cardData[cardId] = applyRating(rec, rating);
			await this.plugin.persistData();
		}
		this.idx++;
		this.revealed = false;
		this.render();
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings Tab
// ─────────────────────────────────────────────────────────────────────────────

class FlashcardsSettingTab extends PluginSettingTab {
	plugin: FlashcardsPlugin;

	constructor(app: App, plugin: FlashcardsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Flashcards Settings" });

		// Deck folder
		new Setting(containerEl)
			.setName("Deck Folder")
			.setDesc(
				'Path to the folder whose notes become flashcards (e.g. "Flashcards" or "Notes/Vocab").',
			)
			.addText((text) =>
				text
					.setPlaceholder("Flashcards")
					.setValue(this.plugin.settings.deckFolder)
					.onChange(async (value) => {
						this.plugin.settings.deckFolder = value.trim();
						await this.plugin.persistData();
					}),
			);

		// New cards per day
		new Setting(containerEl)
			.setName("New Cards Per Day")
			.setDesc("Maximum number of new (unseen) cards shown per session.")
			.addSlider((slider) =>
				slider
					.setLimits(1, 100, 1)
					.setValue(this.plugin.settings.newCardsPerDay)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.newCardsPerDay = value;
						await this.plugin.persistData();
					}),
			);

		// Max reviews per day
		new Setting(containerEl)
			.setName("Max Reviews Per Day")
			.setDesc("Maximum number of due review cards shown per session.")
			.addSlider((slider) =>
				slider
					.setLimits(1, 500, 1)
					.setValue(this.plugin.settings.maxReviewsPerDay)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxReviewsPerDay = value;
						await this.plugin.persistData();
					}),
			);

		// Help section
		containerEl.createEl("h3", { text: "Card Format" });
		const desc = containerEl.createEl("p", {
			cls: "setting-item-description",
		});
		desc.textContent =
			"Every .md file in the deck folder is one flashcard. " +
			"Use optional YAML frontmatter to customise the card:";

		const ul = containerEl.createEl("ul");
		ul.createEl("li", {
			text: "card_front: \"Question text\" — overrides the filename as the front.",
		});
		ul.createEl("li", {
			text: "card_type: basic_reversed — creates two cards (Front→Back and Back→Front).",
		});

		containerEl.createEl("h4", { text: "Example" });
		containerEl.createEl("pre").createEl("code", {
			text: [
				"---",
				"card_type: basic_reversed",
				"card_front: What is the capital of France?",
				"---",
				"Paris",
			].join("\n"),
		});
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Plugin Class
// ─────────────────────────────────────────────────────────────────────────────

export default class FlashcardsPlugin extends Plugin {
	settings: FlashcardsSettings = { ...DEFAULT_SETTINGS };
	/** In-memory card records, kept in sync with data.json. */
	cardData: Record<string, CardRecord> = {};

	async onload(): Promise<void> {
		// Load persisted data
		const stored = (await this.loadData()) as Partial<PluginStoredData> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored?.settings ?? {});
		this.cardData = stored?.cards ?? {};

		// Register the study view
		this.registerView(
			VIEW_TYPE_FLASHCARD,
			(leaf) => new FlashcardView(leaf, this),
		);

		// Ribbon icon for quick access
		this.addRibbonIcon("brain", "Open Flashcards", () =>
			void this.openStudyView(),
		);

		// Command palette entry
		this.addCommand({
			id: "open-flashcard-deck",
			name: "Open Flashcard Deck",
			callback: () => void this.openStudyView(),
		});

		// Right-click a folder → "Set as Flashcard Deck"
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFolder) {
					menu.addItem((item) =>
						item
							.setTitle("Set as Flashcard Deck")
							.setIcon("layers")
							.onClick(async () => {
								this.settings.deckFolder = file.path;
								await this.persistData();
								new Notice(`Flashcard deck → ${file.path}`);
							}),
					);
				}
			}),
		);

		// Settings tab
		this.addSettingTab(new FlashcardsSettingTab(this.app, this));
	}

	onunload(): void {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_FLASHCARD);
	}

	/** Save both settings and card data atomically. */
	async persistData(): Promise<void> {
		await this.saveData({
			settings: this.settings,
			cards: this.cardData,
		} as PluginStoredData);
	}

	/** Open (or reveal) the flashcard study panel. */
	async openStudyView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_FLASHCARD);
		if (existing.length > 0) {
			workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE_FLASHCARD, active: true });
		workspace.revealLeaf(leaf);
	}
}
