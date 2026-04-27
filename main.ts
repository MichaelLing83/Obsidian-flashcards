import {
	App,
	ItemView,
	MarkdownRenderer,
	Plugin,
	PluginSettingTab,
	Setting,
	SuggestModal,
	TFile,
	TFolder,
	WorkspaceLeaf,
} from "obsidian";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

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

interface DeckInstanceConfig {
	name?: string;
	promptSection: string;
	answerSection: string;
}

interface DeckConfig {
	requiredSections: string[];
	instances: DeckInstanceConfig[];
}

interface DeckDefinition {
	folder: TFolder;
	configFile: TFile;
	config: DeckConfig;
}

interface DeckInstanceSelection {
	deck: DeckDefinition;
	instance: DeckInstanceConfig;
	instanceKey: string;
}

interface DeckSelectionResult {
	selection: DeckInstanceSelection | null;
	error: string;
}

interface FlashcardsSettings {
	newCardsPerDay: number;
	maxReviewsPerDay: number;
}

const DEFAULT_SETTINGS: FlashcardsSettings = {
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

/** Parse top-level markdown sections (H1 headings) into a map. */
function parseTopLevelSections(markdown: string): Map<string, string> {
	const sections = new Map<string, string>();
	const lines = stripFrontmatter(markdown).split("\n");

	let currentTitle = "";
	let buffer: string[] = [];

	for (const line of lines) {
		const h1 = line.match(/^#\s+(.+)$/);
		if (h1) {
			if (currentTitle) {
				sections.set(currentTitle, buffer.join("\n").trim());
			}
			currentTitle = h1[1].trim();
			buffer = [];
			continue;
		}
		if (currentTitle) {
			buffer.push(line);
		}
	}

	if (currentTitle) {
		sections.set(currentTitle, buffer.join("\n").trim());
	}

	return sections;
}

function normalizeSectionName(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function parseDeckConfig(raw: string): { config: DeckConfig | null; error: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			config: null,
			error:
				"Invalid config JSON. Use a JSON object with requiredSections and instances.",
		};
	}

	if (!parsed || typeof parsed !== "object") {
		return { config: null, error: "Config must be a JSON object." };
	}

	const obj = parsed as {
		requiredSections?: unknown;
		instances?: unknown;
	};

	if (!Array.isArray(obj.requiredSections) || obj.requiredSections.length === 0) {
		return {
			config: null,
			error: "requiredSections must be a non-empty string array.",
		};
	}

	const requiredSections = obj.requiredSections
		.map((v) => normalizeSectionName(v))
		.filter((v) => v.length > 0);

	if (requiredSections.length === 0) {
		return {
			config: null,
			error: "requiredSections must contain at least one non-empty section name.",
		};
	}

	if (!Array.isArray(obj.instances) || obj.instances.length === 0) {
		return {
			config: null,
			error: "instances must be a non-empty array.",
		};
	}

	const requiredSet = new Set(requiredSections);
	const instances: DeckInstanceConfig[] = [];

	for (const item of obj.instances) {
		let name = "";
		let promptSection = "";
		let answerSection = "";

		if (Array.isArray(item) && item.length === 2) {
			promptSection = normalizeSectionName(item[0]);
			answerSection = normalizeSectionName(item[1]);
		} else if (item && typeof item === "object") {
			const cast = item as {
				name?: unknown;
				promptSection?: unknown;
				answerSection?: unknown;
			};
			name = normalizeSectionName(cast.name);
			promptSection = normalizeSectionName(cast.promptSection);
			answerSection = normalizeSectionName(cast.answerSection);
		}

		if (!promptSection || !answerSection) {
			return {
				config: null,
				error:
					"Each instance must define promptSection and answerSection (or use [\"A\", \"B\"] format).",
			};
		}

		if (!requiredSet.has(promptSection) || !requiredSet.has(answerSection)) {
			return {
				config: null,
				error:
					`Instance (${promptSection} -> ${answerSection}) must reference sections from requiredSections.`,
			};
		}

		instances.push({
			name: name || undefined,
			promptSection,
			answerSection,
		});
	}

	return {
		config: {
			requiredSections,
			instances,
		},
		error: "",
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Flashcard View
// ─────────────────────────────────────────────────────────────────────────────

/** A card scheduled for the current study session. */
interface StudyCard {
	/** Storage key in plugin.cardData, scoped to selected deck instance. */
	id: string;
	file: TFile;
	isNew: boolean;
	front: string;
	back: string;
}

class SelectionModal<T> extends SuggestModal<T> {
	private readonly items: T[];
	private readonly toLabel: (item: T) => string;
	private readonly toInfo?: (item: T) => string;
	private readonly onChoose: (item: T) => void;

	constructor(
		app: App,
		items: T[],
		placeholder: string,
		toLabel: (item: T) => string,
		toInfo: ((item: T) => string) | undefined,
		onChoose: (item: T) => void,
	) {
		super(app);
		this.items = items;
		this.toLabel = toLabel;
		this.toInfo = toInfo;
		this.onChoose = onChoose;
		this.setPlaceholder(placeholder);
	}

	getSuggestions(query: string): T[] {
		const q = query.trim().toLowerCase();
		if (!q) return this.items;
		return this.items.filter((item) =>
			this.toLabel(item).toLowerCase().includes(q),
		);
	}

	renderSuggestion(item: T, el: HTMLElement): void {
		el.createDiv({ text: this.toLabel(item) });
		if (this.toInfo) {
			el.createDiv({ cls: "suggestion-note", text: this.toInfo(item) });
		}
	}

	onChooseSuggestion(item: T): void {
		this.onChoose(item);
	}
}

export class FlashcardView extends ItemView {
	private plugin: FlashcardsPlugin;
	private queue: StudyCard[] = [];
	private idx = 0;
	private revealed = false;
	private queueBuildError = "";
	private activeSelection: DeckInstanceSelection | null = null;

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
		this.queueBuildError = "";
		this.activeSelection = null;
		const selected = await this.plugin.selectDeckInstanceForReview();
		if (selected.error) {
			this.queueBuildError = selected.error;
			this.queue = [];
			this.idx = 0;
			this.revealed = false;
			this.render();
			return;
		}

		this.activeSelection = selected.selection;
		if (!this.activeSelection) {
			this.queueBuildError = "No deck mode selected.";
			this.queue = [];
			this.idx = 0;
			this.revealed = false;
			this.render();
			return;
		}

		await this.buildQueue(this.activeSelection);
		this.idx = 0;
		this.revealed = false;
		this.render();
	}

	// ── Queue building ─────────────────────────────────────────────────────

	private async buildQueue(selection: DeckInstanceSelection): Promise<void> {
		const { newCardsPerDay, maxReviewsPerDay } = this.plugin.settings;
		const files = this.collectMdFiles(selection.deck.folder);
		if (files.length === 0) {
			this.queue = [];
			return;
		}

		const now = Date.now();
		const due: StudyCard[] = [];

		for (const file of files) {
			const raw = await this.app.vault.read(file);
			const sections = parseTopLevelSections(raw);

			for (const required of selection.deck.config.requiredSections) {
				if (!sections.has(required)) {
					this.queueBuildError =
						`Missing required section \"${required}\" in ${file.path}. ` +
						"Every flashcard note in this deck must include all required sections.";
					this.queue = [];
					return;
				}
			}

			const front = sections.get(selection.instance.promptSection)?.trim() ?? "";
			const back = sections.get(selection.instance.answerSection)?.trim() ?? "";
			if (!front || !back) {
				this.queueBuildError =
					`Cannot build card from ${file.path}: ` +
					`section \"${selection.instance.promptSection}\" or \"${selection.instance.answerSection}\" is empty.`;
				this.queue = [];
				return;
			}

			const id = this.plugin.buildCardId(selection.instanceKey, file.path);
			if (!this.plugin.cardData[id]) {
				this.plugin.cardData[id] = this.makeRecord(file.path, now);
			}

			if (this.plugin.cardData[id].dueDate <= now) {
				due.push({
					id,
					file,
					isNew: this.plugin.cardData[id].repetitions === 0,
					front,
					back,
				});
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
		now: number,
	): CardRecord {
		return {
			path,
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

	// ── Rendering ─────────────────────────────────────────────────────────

	private render(): void {
		const el = this.contentEl;
		el.empty();
		el.addClass("flashcard-container");

		if (this.queueBuildError) {
			this.renderMessage(
				el,
				"⚠️ Deck configuration error",
				this.queueBuildError,
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
		const front = card.front;
		const back = card.back;

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
		const typeLabel = this.activeSelection
			? this.plugin.getInstanceLabel(this.activeSelection.instance)
			: "Deck";
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
			text: this.activeSelection?.instance.promptSection ?? "Front",
		});
		const frontContent = frontSide.createDiv({ cls: "flashcard-content" });
		await this.renderMarkdown(front, frontContent, card.file.path);

		// Revealed answer
		if (this.revealed) {
			cardEl.createDiv({ cls: "flashcard-divider" });
			const backSide = cardEl.createDiv({ cls: "flashcard-side" });
			backSide.createDiv({
				cls: "flashcard-side-label",
				text: this.activeSelection?.instance.answerSection ?? "Back",
			});
			const backContent = backSide.createDiv({ cls: "flashcard-content" });
			await this.renderMarkdown(back, backContent, card.file.path);
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
		containerEl.createEl("h3", { text: "Deck Config File" });
		const desc = containerEl.createEl("p", {
			cls: "setting-item-description",
		});
		desc.textContent =
			"Each deck folder must contain a config file named <deck_dir>.flashcards in JSON format.";

		const ul = containerEl.createEl("ul");
		ul.createEl("li", {
			text: "Config filename must match folder name, e.g. deck_dir/deck_dir.flashcards.",
		});
		ul.createEl("li", {
			text: "requiredSections defines mandatory H1 sections in every card note.",
		});
		ul.createEl("li", {
			text: "instances define prompt/answer section pairs, each becoming a study mode.",
		});
		ul.createEl("li", {
			text: "Nested decks are not allowed: if a deck folder has a child deck folder, the plugin will stop and show an error.",
		});

		containerEl.createEl("h4", { text: "Example" });
		containerEl.createEl("pre").createEl("code", {
			text: [
				"{",
				"  \"requiredSections\": [\"A\", \"B\", \"C\"],",
				"  \"instances\": [",
				"    [\"A\", \"B\"],",
				"    { \"name\": \"B-to-C\", \"promptSection\": \"B\", \"answerSection\": \"C\" }",
				"  ]",
				"}",
			].join("\n"),
		});

		containerEl.createEl("h4", { text: "Card Note Example" });
		containerEl.createEl("pre").createEl("code", {
			text: [
				"# A",
				"Prompt content",
				"",
				"# B",
				"Expected answer",
				"",
				"# C",
				"Extra context",
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
		const merged = Object.assign({}, DEFAULT_SETTINGS, stored?.settings ?? {});
		this.settings = {
			newCardsPerDay: merged.newCardsPerDay,
			maxReviewsPerDay: merged.maxReviewsPerDay,
		};
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

	buildCardId(instanceKey: string, notePath: string): string {
		return `${instanceKey}::${notePath}`;
	}

	private isDescendantFolder(parentPath: string, childPath: string): boolean {
		if (parentPath === childPath) return false;
		if (parentPath === "") return childPath !== "";
		return childPath.startsWith(`${parentPath}/`);
	}

	getInstanceLabel(instance: DeckInstanceConfig): string {
		return instance.name || `${instance.promptSection} -> ${instance.answerSection}`;
	}

	private getInstanceKey(deckPath: string, instance: DeckInstanceConfig): string {
		return `${deckPath}::${instance.promptSection}->${instance.answerSection}`;
	}

	private isDeckConfigFile(file: TFile): boolean {
		if (!file.parent) return false;
		if (file.extension !== "flashcards") return false;
		return file.basename === file.parent.name;
	}

	private async discoverDeckDefinitions(): Promise<{
		decks: DeckDefinition[];
		error: string;
	}> {
		const configFiles = this.app.vault
			.getFiles()
			.filter((f) => this.isDeckConfigFile(f));

		if (configFiles.length === 0) {
			return {
				decks: [],
				error:
					"No deck config found. Add <deck_dir>.flashcards in your deck folder.",
			};
		}

		const decks: DeckDefinition[] = [];
		for (const configFile of configFiles) {
			if (!(configFile.parent instanceof TFolder)) continue;
			const raw = await this.app.vault.read(configFile);
			const parsed = parseDeckConfig(raw);
			if (!parsed.config) {
				return {
					decks: [],
					error: `Config error in ${configFile.path}: ${parsed.error}`,
				};
			}

			decks.push({
				folder: configFile.parent,
				configFile,
				config: parsed.config,
			});
		}

		decks.sort((a, b) => a.folder.path.length - b.folder.path.length);
		for (let i = 0; i < decks.length; i++) {
			for (let j = i + 1; j < decks.length; j++) {
				if (this.isDescendantFolder(decks[i].folder.path, decks[j].folder.path)) {
					return {
						decks: [],
						error:
							`Nested deck folders are not allowed: "${decks[i].folder.path}" contains child deck "${decks[j].folder.path}".`,
					};
				}
			}
		}

		return { decks, error: "" };
	}

	private async pickOne<T>(
		items: T[],
		placeholder: string,
		toLabel: (item: T) => string,
		toInfo?: (item: T) => string,
	): Promise<T | null> {
		if (items.length === 0) return null;
		if (items.length === 1) return items[0];

		return await new Promise<T | null>((resolve) => {
			let resolved = false;
			const modal = new SelectionModal<T>(
				this.app,
				items,
				placeholder,
				toLabel,
				toInfo,
				(item) => {
					resolved = true;
					resolve(item);
				},
			);
			const close = modal.onClose.bind(modal);
			modal.onClose = () => {
				close();
				if (!resolved) resolve(null);
			};
			modal.open();
		});
	}

	async selectDeckInstanceForReview(): Promise<DeckSelectionResult> {
		const discovered = await this.discoverDeckDefinitions();
		if (discovered.error) {
			return { selection: null, error: discovered.error };
		}

		const deck = await this.pickOne(
			discovered.decks,
			"Select a deck folder",
			(item) => item.folder.path,
			(item) => item.configFile.name,
		);
		if (!deck) {
			return { selection: null, error: "Deck selection cancelled." };
		}

		const instance = await this.pickOne(
			deck.config.instances,
			"Select a deck mode",
			(item) => this.getInstanceLabel(item),
			(item) => `${item.promptSection} -> ${item.answerSection}`,
		);
		if (!instance) {
			return { selection: null, error: "Deck mode selection cancelled." };
		}

		return {
			selection: {
				deck,
				instance,
				instanceKey: this.getInstanceKey(deck.folder.path, instance),
			},
			error: "",
		};
	}
}
