import {
	App,
	ItemView,
	MarkdownView,
	MarkdownRenderer,
	Notice,
	Plugin,
	PluginSettingTab,
	requestUrl,
	Setting,
	SuggestModal,
	TAbstractFile,
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
	ai?: DeckAiConfig;
}

interface DeckAiConfig {
	provider: "ollama" | "volcengine";
	model: string;
	baseUrl?: string;
	apiKey?: string;
	prompts: Record<string, Record<string, string>>;
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
	cardFontSizePx: number;
	deckFontSizePxByPath: Record<string, number>;
}

const DEFAULT_SETTINGS: FlashcardsSettings = {
	newCardsPerDay: 20,
	maxReviewsPerDay: 100,
	cardFontSizePx: 22,
	deckFontSizePxByPath: {},
};

const DEFAULT_EASE = 2.5;
const MIN_EASE = 1.3;
const MS_PER_DAY = 86_400_000;
const DEBUG_PREFIX = "[Flashcards]";
const MIN_CARD_FONT_SIZE_PX = 14;
const MAX_CARD_FONT_SIZE_PX = 48;
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_VOLCENGINE_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

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

function extractJsonPayload(raw: string): string {
	const trimmed = raw.trim();

	const fullFence = trimmed.match(/^```(?:json)?\s*[\r\n]+([\s\S]*?)\r?\n```\s*$/i);
	if (fullFence) {
		return fullFence[1].trim();
	}

	const firstFence = raw.match(/```(?:json)?\s*[\r\n]+([\s\S]*?)\r?\n```/i);
	if (firstFence) {
		return firstFence[1].trim();
	}

	return trimmed;
}

function parseDeckConfig(raw: string): { config: DeckConfig | null; error: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(extractJsonPayload(raw));
	} catch {
		return {
			config: null,
			error:
				"Invalid config JSON. Use a JSON object with requiredSections and instances (raw JSON or wrapped in ```json ... ```).",
		};
	}

	if (!parsed || typeof parsed !== "object") {
		return { config: null, error: "Config must be a JSON object." };
	}

	const obj = parsed as {
		requiredSections?: unknown;
		instances?: unknown;
		ai?: unknown;
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

	let ai: DeckAiConfig | undefined;
	if (typeof obj.ai !== "undefined") {
		if (!obj.ai || typeof obj.ai !== "object") {
			return {
				config: null,
				error: "ai must be an object when provided.",
			};
		}

		const aiObj = obj.ai as {
			provider?: unknown;
			model?: unknown;
			baseUrl?: unknown;
			apiKey?: unknown;
			prompts?: unknown;
		};

		if (aiObj.provider !== "ollama" && aiObj.provider !== "volcengine") {
			return {
				config: null,
				error: "ai.provider must be \"ollama\" or \"volcengine\".",
			};
		}

		const model = normalizeSectionName(aiObj.model);
		if (!model) {
			return {
				config: null,
				error: "ai.model must be a non-empty string.",
			};
		}

		const baseUrl =
			normalizeSectionName(aiObj.baseUrl) ||
			(aiObj.provider === "volcengine"
				? DEFAULT_VOLCENGINE_BASE_URL
				: DEFAULT_OLLAMA_BASE_URL);
		const apiKey = normalizeSectionName(aiObj.apiKey) || undefined;

		if (aiObj.provider === "volcengine" && !apiKey) {
			return {
				config: null,
				error: "ai.apiKey must be a non-empty string when ai.provider is \"volcengine\".",
			};
		}

		if (!aiObj.prompts || typeof aiObj.prompts !== "object" || Array.isArray(aiObj.prompts)) {
			return {
				config: null,
				error: "ai.prompts must be an object keyed by source section and target section.",
			};
		}

		const prompts: Record<string, Record<string, string>> = {};
		for (const [sourceRaw, targetMapRaw] of Object.entries(aiObj.prompts as Record<string, unknown>)) {
			const source = normalizeSectionName(sourceRaw);
			if (!requiredSet.has(source)) {
				return {
					config: null,
					error: `ai.prompts source section \"${source}\" must exist in requiredSections.`,
				};
			}

			if (!targetMapRaw || typeof targetMapRaw !== "object" || Array.isArray(targetMapRaw)) {
				return {
					config: null,
					error: `ai.prompts.${source} must be an object keyed by target section.`,
				};
			}

			const targetMap: Record<string, string> = {};
			for (const [targetRaw, promptRaw] of Object.entries(targetMapRaw as Record<string, unknown>)) {
				const target = normalizeSectionName(targetRaw);
				const prompt = normalizeSectionName(promptRaw);

				if (!requiredSet.has(target)) {
					return {
						config: null,
						error: `ai.prompts target section \"${target}\" must exist in requiredSections.`,
					};
				}

				if (!prompt) {
					return {
						config: null,
						error: `ai.prompts.${source}.${target} must be a non-empty string.`,
					};
				}

				targetMap[target] = prompt;
			}

			prompts[source] = targetMap;
		}

		ai = {
			provider: aiObj.provider,
			model,
			baseUrl,
			apiKey,
			prompts,
		};
	}

	return {
		config: {
			requiredSections,
			instances,
			ai,
		},
		error: "",
	};
}

function buildPromptFromSource(sourceContent: string, instruction: string): string {
	return `${sourceContent.trim()}\n\n${instruction.trim()}`;
}

function replaceTopLevelSectionContent(
	markdown: string,
	sectionName: string,
	newContent: string,
): { updatedMarkdown: string; updated: boolean } {
	const lines = markdown.split("\n");
	const headingPattern = /^#\s+(.+)$/;
	let start = -1;
	let end = lines.length;

	for (let index = 0; index < lines.length; index++) {
		const match = lines[index].match(headingPattern);
		if (!match) continue;

		const title = match[1].trim();
		if (start === -1 && title === sectionName) {
			start = index + 1;
			continue;
		}

		if (start !== -1) {
			end = index;
			break;
		}
	}

	if (start === -1) {
		return { updatedMarkdown: markdown, updated: false };
	}

	const body = newContent.trim();
	const replacement = body ? ["", ...body.split("\n"), ""] : [""];
	const updatedLines = [
		...lines.slice(0, start),
		...replacement,
		...lines.slice(end),
	];

	return {
		updatedMarkdown: updatedLines.join("\n").replace(/\n{3,}/g, "\n\n"),
		updated: true,
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
	private queueBuildErrorFilePath = "";
	private activeSelection: DeckInstanceSelection | null = null;
	private keydownRegistered = false;

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
		this.registerKeyboardShortcuts();
		await this.startSession();
	}

	private registerKeyboardShortcuts(): void {
		if (this.keydownRegistered) return;
		this.keydownRegistered = true;

		this.registerDomEvent(document, "keydown", (evt: KeyboardEvent) => {
			if (!this.isActiveView()) return;
			if (this.shouldIgnoreShortcut(evt.target)) return;

			if (evt.code === "Space" && !this.revealed && this.canOperateOnCurrentCard()) {
				evt.preventDefault();
				this.revealed = true;
				this.render();
				return;
			}

			if (!this.revealed || !this.canOperateOnCurrentCard()) return;

			const rating = this.keyToRating(evt);
			if (rating === null) return;

			evt.preventDefault();
			const card = this.queue[this.idx];
			void this.submitRating(card.id, rating);
		});
	}

	private isActiveView(): boolean {
		const active = this.app.workspace.getActiveViewOfType(FlashcardView);
		return active === this;
	}

	private shouldIgnoreShortcut(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		if (target.isContentEditable) return true;
		const tag = target.tagName;
		return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
	}

	private canOperateOnCurrentCard(): boolean {
		return !this.queueBuildError && this.queue.length > 0 && this.idx < this.queue.length;
	}

	private keyToRating(evt: KeyboardEvent): Rating | null {
		switch (evt.code) {
			case "Digit1":
			case "Numpad1":
				return 0;
			case "Digit2":
			case "Numpad2":
				return 1;
			case "Digit3":
			case "Numpad3":
				return 2;
			case "Digit4":
			case "Numpad4":
				return 3;
			default:
				return null;
		}
	}

	/** (Re-)build the study queue and render the first card. */
	async startSession(): Promise<void> {
		this.queueBuildError = "";
		this.queueBuildErrorFilePath = "";
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
			if (this.plugin.isDeckConfigFile(file)) {
				continue;
			}

			const raw = await this.app.vault.read(file);
			const sections = parseTopLevelSections(raw);

			for (const required of selection.deck.config.requiredSections) {
				if (!sections.has(required)) {
					this.queueBuildError =
						`Missing required section \"${required}\". ` +
						"Every flashcard note in this deck must include all required sections.";
					this.queueBuildErrorFilePath = file.path;
					this.queue = [];
					return;
				}
			}

			const front = sections.get(selection.instance.promptSection)?.trim() ?? "";
			const back = sections.get(selection.instance.answerSection)?.trim() ?? "";
			if (!front || !back) {
				this.queueBuildError =
					"Cannot build card: " +
					`section \"${selection.instance.promptSection}\" or \"${selection.instance.answerSection}\" is empty.`;
				this.queueBuildErrorFilePath = file.path;
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
		this.refreshFontSizeVariable();

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

		if (this.queueBuildErrorFilePath) {
			const link = wrap.createEl("a", {
				cls: "flashcard-error-link",
				text: `Open note: ${this.queueBuildErrorFilePath}`,
			});
			link.href = "#";
			link.addEventListener("click", (evt) => {
				evt.preventDefault();
				void this.openQueueErrorFile();
			});
		}

		if (this.activeSelection) {
			const createBtn = wrap.createEl("button", {
				cls: "flashcard-btn flashcard-btn-show",
				text: "New Flashcard",
			});
			createBtn.addEventListener("click", () =>
				void this.createFlashcardInActiveDeck(),
			);
		}

		const btn = wrap.createEl("button", {
			cls: "flashcard-btn flashcard-btn-primary",
			text: "Refresh",
		});
		btn.addEventListener("click", () => void this.startSession());

		this.renderDeckFontSizeControl(el);
	}

	private async createFlashcardInActiveDeck(): Promise<void> {
		if (!this.activeSelection) return;
		await this.plugin.createFlashcardFromDeckFolder(this.activeSelection.deck.folder);
	}

	private async openQueueErrorFile(): Promise<void> {
		if (!this.queueBuildErrorFilePath) return;
		const target = this.app.vault.getAbstractFileByPath(this.queueBuildErrorFilePath);
		if (!(target instanceof TFile)) {
			new Notice(`Could not find note: ${this.queueBuildErrorFilePath}`);
			return;
		}

		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.openFile(target);
		this.app.workspace.revealLeaf(leaf);
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

		this.renderDeckFontSizeControl(el);
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
		if (this.activeSelection) {
			const newBtn = footer.createEl("button", {
				cls: "flashcard-btn flashcard-btn-primary flashcard-btn-new-note",
				text: "New Flashcard",
			});
			newBtn.addEventListener("click", () =>
				void this.createFlashcardInActiveDeck(),
			);
		}

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

		this.renderDeckFontSizeControl(el);
	}

	getActiveDeckPath(): string | null {
		return this.activeSelection?.deck.folder.path ?? null;
	}

	refreshFontSizeVariable(): void {
		const deckPath = this.getActiveDeckPath();
		const sizePx = this.plugin.getDeckFontSizePx(deckPath);
		this.contentEl.style.setProperty("--flashcard-font-size", `${sizePx}px`);
	}

	private renderDeckFontSizeControl(parent: HTMLElement): void {
		const deckPath = this.getActiveDeckPath();
		if (!deckPath) return;

		const sizePx = this.plugin.getDeckFontSizePx(deckPath);
		const wrap = parent.createDiv({ cls: "flashcard-font-control" });
		wrap.createSpan({ cls: "flashcard-font-control-label", text: "Card Font" });

		const slider = wrap.createEl("input", {
			type: "range",
			cls: "flashcard-font-control-slider",
		});
		slider.min = String(MIN_CARD_FONT_SIZE_PX);
		slider.max = String(MAX_CARD_FONT_SIZE_PX);
		slider.step = "1";
		slider.value = String(sizePx);

		const valueLabel = wrap.createSpan({
			cls: "flashcard-font-control-value",
			text: `${sizePx}px`,
		});

		slider.addEventListener("input", () => {
			const current = Number(slider.value);
			valueLabel.setText(`${current}px`);
			this.contentEl.style.setProperty("--flashcard-font-size", `${current}px`);
		});

		slider.addEventListener("change", () => {
			const current = Number(slider.value);
			void this.plugin.setDeckFontSizePx(deckPath, current);
		});
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

		// Card font size
		new Setting(containerEl)
			.setName("Default Card Font Size")
			.setDesc(
				"Fallback font size for decks that don't have a deck-specific size set in the Flashcards view.",
			)
			.addSlider((slider) =>
				slider
					.setLimits(MIN_CARD_FONT_SIZE_PX, MAX_CARD_FONT_SIZE_PX, 1)
					.setValue(this.plugin.settings.cardFontSizePx)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.cardFontSizePx = value;
						this.plugin.applyCardFontSizeToOpenViews();
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
	private aiStatusBarEl: HTMLElement | null = null;

	private logDebug(message: string, meta?: unknown): void {
		if (typeof meta === "undefined") {
			console.info(`${DEBUG_PREFIX} ${message}`);
			return;
		}
		console.info(`${DEBUG_PREFIX} ${message}`, meta);
	}

	private registerDeckFolderMenuHook(): void {
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				this.logDebug("file-menu fired", {
					path: file.path,
					type: file instanceof TFolder ? "folder" : "file",
				});
				this.tryAddNewFlashcardMenuItem(menu, file, "file-menu");
			}),
		);

		// Some Obsidian versions use files-menu for navigator context menus.
		const workspaceAny = this.app.workspace as unknown as {
			on: (eventName: string, cb: (...args: unknown[]) => void) => unknown;
		};
		this.registerEvent(
			workspaceAny.on("files-menu", (menu: unknown, files: unknown) => {
				if (!Array.isArray(files)) return;
				const first = files[0];
				const cast = first as TAbstractFile | undefined;
				this.logDebug("files-menu fired", {
					count: files.length,
					firstPath: cast?.path,
					firstType: cast instanceof TFolder ? "folder" : "file",
				});
				if (!cast || files.length !== 1) return;
				this.tryAddNewFlashcardMenuItem(menu, cast, "files-menu");
			}) as any,
		);
	}

	private registerAiCompletionUi(): void {
		this.aiStatusBarEl = this.addStatusBarItem();
		this.aiStatusBarEl.addClass("mod-clickable");
		this.aiStatusBarEl.setText("AI Complete");
		this.aiStatusBarEl.addEventListener("click", () => void this.completeCurrentDeckWithAi());

		this.addCommand({
			id: "ai-complete-current-flashcard",
			name: "AI Complete Current Flashcard",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const canRun = file instanceof TFile && file.extension === "md" && !this.isDeckConfigFile(file);
				if (!checking && canRun) {
					void this.completeCurrentFlashcardWithAi();
				}
				return canRun;
			},
		});

		this.addCommand({
			id: "ai-complete-current-deck",
			name: "AI Complete Current Deck",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const canRun = file instanceof TFile && file.extension === "md" && !this.isDeckConfigFile(file);
				if (!checking && canRun) {
					void this.completeCurrentDeckWithAi();
				}
				return canRun;
			},
		});

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => this.updateAiStatusBarVisibility()),
		);
		this.registerEvent(
			this.app.workspace.on("file-open", () => this.updateAiStatusBarVisibility()),
		);

		this.updateAiStatusBarVisibility();
	}

	private updateAiStatusBarVisibility(): void {
		if (!this.aiStatusBarEl) return;
		const activeFile = this.app.workspace.getActiveFile();
		const visible = activeFile instanceof TFile && activeFile.extension === "md" && !this.isDeckConfigFile(activeFile);
		this.aiStatusBarEl.style.display = visible ? "" : "none";
	}

	private tryAddNewFlashcardMenuItem(
		menu: unknown,
		file: TAbstractFile,
		sourceEvent: string,
	): void {
		if (!(file instanceof TFolder)) {
			return;
		}

		const configFile = this.getDeckConfigFileForFolder(file);
		this.logDebug("folder context detected", {
			sourceEvent,
			folder: file.path,
			configFile: configFile?.path ?? null,
		});

		const menuAny = menu as any;

		menuAny.addItem((item: any) =>
			item
				.setTitle("New Flashcard")
				.setIcon("plus-circle")
				.onClick(() => {
					this.logDebug("New Flashcard clicked", {
						folder: file.path,
						configFile: configFile?.path ?? null,
					});
					void this.createFlashcardFromDeckFolder(file);
				}),
		);
	}

	async onload(): Promise<void> {
		// Load persisted data
		const stored = (await this.loadData()) as Partial<PluginStoredData> | null;
		const merged = Object.assign({}, DEFAULT_SETTINGS, stored?.settings ?? {});
		this.settings = {
			newCardsPerDay: merged.newCardsPerDay,
			maxReviewsPerDay: merged.maxReviewsPerDay,
			cardFontSizePx: Math.max(
				MIN_CARD_FONT_SIZE_PX,
				Math.min(MAX_CARD_FONT_SIZE_PX, Number(merged.cardFontSizePx) || DEFAULT_SETTINGS.cardFontSizePx),
			),
			deckFontSizePxByPath:
				typeof merged.deckFontSizePxByPath === "object" && merged.deckFontSizePxByPath
					? Object.fromEntries(
						Object.entries(merged.deckFontSizePxByPath)
							.map(([path, size]) => [path, Number(size)])
							.filter(
								([path, size]) =>
									typeof path === "string" &&
									path.length > 0 &&
									Number.isFinite(size) &&
									size >= MIN_CARD_FONT_SIZE_PX &&
									size <= MAX_CARD_FONT_SIZE_PX,
							),
					)
					: {},
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

		this.logDebug("plugin loaded", { version: this.manifest.version });
		this.registerDeckFolderMenuHook();
		this.registerAiCompletionUi();
		this.applyCardFontSizeToOpenViews();

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
			this.applyCardFontSizeToOpenViews();
			workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE_FLASHCARD, active: true });
		this.applyCardFontSizeToOpenViews();
		workspace.revealLeaf(leaf);
	}

	applyCardFontSizeToOpenViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_FLASHCARD)) {
			const view = leaf.view;
			if (view instanceof FlashcardView) {
				view.refreshFontSizeVariable();
			}
		}
	}

	private async getDeckDefinitionForNote(
		file: TFile,
	): Promise<{ deck: DeckDefinition | null; error: string }> {
		if (this.isDeckConfigFile(file)) {
			return {
				deck: null,
				error: "Deck config files cannot be AI-completed as flashcard notes.",
			};
		}

		const discovered = await this.discoverDeckDefinitions();
		if (discovered.error) {
			return { deck: null, error: discovered.error };
		}

		const deck = discovered.decks
			.filter((candidate) => file.path.startsWith(`${candidate.folder.path}/`))
			.sort((a, b) => b.folder.path.length - a.folder.path.length)[0];

		if (!deck) {
			return {
				deck: null,
				error: `The active note is not inside a configured flashcards deck: ${file.path}`,
			};
		}

		return { deck, error: "" };
	}

	private async generateWithOllama(ai: DeckAiConfig, prompt: string): Promise<string> {
		const baseUrl = (ai.baseUrl || DEFAULT_OLLAMA_BASE_URL).replace(/\/$/, "");
		const response = await fetch(`${baseUrl}/api/generate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: ai.model,
				prompt,
				stream: false,
			}),
		});

		if (!response.ok) {
			throw new Error(`Ollama request failed with status ${response.status}`);
		}

		const payload = (await response.json()) as { response?: unknown };
		const output = typeof payload.response === "string" ? payload.response.trim() : "";
		if (!output) {
			throw new Error("Ollama returned empty content.");
		}

		return output;
	}

	private async generateWithVolcEngine(ai: DeckAiConfig, prompt: string): Promise<string> {
		const baseUrl = (ai.baseUrl || DEFAULT_VOLCENGINE_BASE_URL).replace(/\/$/, "");
		if (!ai.apiKey) {
			throw new Error("VolcEngine API key is missing.");
		}

		const response = await requestUrl({
			url: `${baseUrl}/chat/completions`,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${ai.apiKey}`,
			},
			body: JSON.stringify({
				model: ai.model,
				messages: [
					{
						role: "user",
						content: prompt,
					},
				],
			}),
		});

		if (response.status < 200 || response.status >= 300) {
			const errorText = typeof response.text === "string" ? response.text : "";
			throw new Error(
				`VolcEngine request failed with status ${response.status}${errorText ? `: ${errorText}` : ""}`,
			);
		}

		const payload = response.json as {
			choices?: Array<{
				message?: {
					content?: unknown;
				};
			}>;
		};
		const output =
			typeof payload.choices?.[0]?.message?.content === "string"
				? payload.choices[0].message.content.trim()
				: "";
		if (!output) {
			throw new Error("VolcEngine returned empty content.");
		}

		return output;
	}

	private async generateAiOutput(ai: DeckAiConfig, prompt: string): Promise<string> {
		this.logDebug("AI request start", {
			provider: ai.provider,
			model: ai.model,
			baseUrl: ai.baseUrl,
			promptLength: prompt.length,
		});
		switch (ai.provider) {
			case "ollama":
				return this.generateWithOllama(ai, prompt);
			case "volcengine":
				return this.generateWithVolcEngine(ai, prompt);
			default:
				throw new Error(`Unsupported AI provider: ${(ai as DeckAiConfig).provider}`);
		}
	}

	private findAiCompletionPlan(
		deck: DeckDefinition,
		sections: Map<string, string>,
	):
		| {
				sourceSection: string;
				sourceContent: string;
				targetSection: string;
				instruction: string;
				aI: DeckAiConfig;
			}
		| { error: string } {
		if (!deck.config.ai) {
			this.logDebug("AI completion skipped: deck has no ai config", {
				deckPath: deck.folder.path,
			});
			return { error: `Deck ${deck.folder.path} has no ai configuration.` };
		}

		let sourceSection = "";
		let sourceContent = "";
		for (const section of deck.config.requiredSections) {
			const content = sections.get(section)?.trim() ?? "";
			if (content) {
				sourceSection = section;
				sourceContent = content;
				break;
			}
		}

		if (!sourceSection) {
			this.logDebug("AI completion skipped: no source section content", {
				deckPath: deck.folder.path,
			});
			return { error: "No source section has content yet. Fill the first source section before using AI Complete." };
		}

		const targetPrompts = deck.config.ai.prompts[sourceSection];
		if (!targetPrompts) {
			this.logDebug("AI completion skipped: no source->target mapping", {
				deckPath: deck.folder.path,
				sourceSection,
			});
			return {
				error: `No AI prompt mapping is configured from section \"${sourceSection}\".`,
			};
		}

		for (const targetSection of deck.config.requiredSections) {
			if (targetSection === sourceSection) continue;
			const targetContent = sections.get(targetSection)?.trim() ?? "";
			if (targetContent) continue;
			const instruction = targetPrompts[targetSection]?.trim();
			if (instruction) {
				return {
					sourceSection,
					sourceContent,
					targetSection,
					instruction,
					aI: deck.config.ai,
				};
			}
			}

		return {
			error:
				`No AI prompt mapping found from section \"${sourceSection}\" to an empty target section.`,
		};
	}

	private logAiPlan(filePath: string, sourceSection: string, targetSection: string): void {
		this.logDebug("AI completion plan", {
			filePath,
			sourceSection,
			targetSection,
		});
	}

	private async completeSingleFlashcardWithAi(
		file: TFile,
		deck: DeckDefinition,
	): Promise<"filled" | "skipped" | "failed"> {
		this.logDebug("AI single start", {
			filePath: file.path,
			deckPath: deck.folder.path,
		});

		const raw = await this.app.vault.read(file);
		const sections = parseTopLevelSections(raw);
		const plan = this.findAiCompletionPlan(deck, sections);

		if ("error" in plan) {
			this.logDebug("AI single skipped", {
				filePath: file.path,
				reason: plan.error,
			});
			return "skipped";
		}

		this.logAiPlan(file.path, plan.sourceSection, plan.targetSection);

		const prompt = buildPromptFromSource(plan.sourceContent, plan.instruction);

		try {
			const output = await this.generateAiOutput(plan.aI, prompt);
			const updated = replaceTopLevelSectionContent(raw, plan.targetSection, output);
			if (!updated.updated) {
				this.logDebug("AI single failed: target section not found", {
					filePath: file.path,
					targetSection: plan.targetSection,
				});
				return "failed";
			}

			await this.app.vault.modify(file, updated.updatedMarkdown);
			this.logDebug("AI single filled", {
				filePath: file.path,
				targetSection: plan.targetSection,
				outputLength: output.length,
			});
			return "filled";
		} catch (error) {
			console.error(`${DEBUG_PREFIX} AI completion failed`, { file: file.path, error });
			return "failed";
		}
	}

	async completeCurrentFlashcardWithAi(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile) || file.extension !== "md") {
			new Notice("Open a markdown flashcard note before using AI Complete.");
			return;
		}

		const deckResult = await this.getDeckDefinitionForNote(file);
		if (!deckResult.deck) {
			new Notice(deckResult.error);
			return;
		}

		this.logDebug("AI current note command", {
			filePath: file.path,
			deckPath: deckResult.deck.folder.path,
		});

		new Notice("AI completing current flashcard...");
		const status = await this.completeSingleFlashcardWithAi(file, deckResult.deck);
		if (status === "filled") {
			new Notice("Filled one section with AI output.");
		} else if (status === "skipped") {
			new Notice("No eligible empty target section found for current flashcard.");
		} else {
			new Notice("AI completion failed for current flashcard.");
		}
	}

	async completeCurrentDeckWithAi(): Promise<void> {
		const active = this.app.workspace.getActiveFile();
		if (!(active instanceof TFile) || active.extension !== "md") {
			new Notice("Open a flashcard note inside the deck first.");
			return;
		}

		const deckResult = await this.getDeckDefinitionForNote(active);
		if (!deckResult.deck) {
			new Notice(deckResult.error);
			return;
		}

		this.logDebug("AI deck command", {
			activeFile: active.path,
			deckPath: deckResult.deck.folder.path,
		});

		const files = this.collectDeckMarkdownFiles(deckResult.deck.folder);
		if (files.length === 0) {
			new Notice("No flashcard notes found in this deck.");
			return;
		}

		new Notice(`AI completing deck: ${deckResult.deck.folder.path} (${files.length} notes)...`);

		let filled = 0;
		let skipped = 0;
		let failed = 0;

		for (const file of files) {
			const status = await this.completeSingleFlashcardWithAi(file, deckResult.deck);
			if (status === "filled") filled++;
			else if (status === "skipped") skipped++;
			else failed++;
		}

		this.logDebug("AI deck command done", {
			deckPath: deckResult.deck.folder.path,
			total: files.length,
			filled,
			skipped,
			failed,
		});

		new Notice(
			`AI deck completion done: filled ${filled}, skipped ${skipped}, failed ${failed}.`,
			8000,
		);
	}

	getDeckFontSizePx(deckPath: string | null | undefined): number {
		if (!deckPath) return this.settings.cardFontSizePx;
		return this.settings.deckFontSizePxByPath[deckPath] ?? this.settings.cardFontSizePx;
	}

	async setDeckFontSizePx(deckPath: string, sizePx: number): Promise<void> {
		const clamped = Math.max(
			MIN_CARD_FONT_SIZE_PX,
			Math.min(MAX_CARD_FONT_SIZE_PX, Math.round(sizePx)),
		);
		this.settings.deckFontSizePxByPath[deckPath] = clamped;
		this.applyCardFontSizeToOpenViews();
		await this.persistData();
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

	private isDeckConfigFileName(fileName: string, folderName: string): boolean {
		const lowerName = fileName.toLowerCase();
		const lowerFolder = folderName.toLowerCase();
		return (
			lowerName === `${lowerFolder}.flashcards` ||
			lowerName === `${lowerFolder}.flashcards.md`
		);
	}

	isDeckConfigFile(file: TFile): boolean {
		if (!file.parent) return false;
		return this.isDeckConfigFileName(file.name, file.parent.name);
	}

	private getDeckConfigFileForFolder(folder: TFolder): TFile | null {
		for (const child of folder.children) {
			if (!(child instanceof TFile)) continue;
			if (this.isDeckConfigFileName(child.name, folder.name)) {
				return child;
			}
		}
		return null;
	}

	private async getDeckDefinitionForFolder(
		folder: TFolder,
	): Promise<{ deck: DeckDefinition | null; error: string }> {
		const configFile = this.getDeckConfigFileForFolder(folder);
		if (!configFile) {
			return {
				deck: null,
				error: `Missing config file ${folder.name}.flashcards in ${folder.path}`,
			};
		}

		const raw = await this.app.vault.read(configFile);
		const parsed = parseDeckConfig(raw);
		if (!parsed.config) {
			return {
				deck: null,
				error: `Config error in ${configFile.path}: ${parsed.error}`,
			};
		}

		return {
			deck: {
				folder,
				configFile,
				config: parsed.config,
			},
			error: "",
		};
	}

	private createFlashcardTemplate(requiredSections: string[]): string {
		return requiredSections.map((section) => `# ${section}\n`).join("\n");
	}

	private collectDeckMarkdownFiles(folder: TFolder): TFile[] {
		const files: TFile[] = [];
		for (const child of folder.children) {
			if (child instanceof TFile && child.extension === "md") {
				if (!this.isDeckConfigFile(child)) {
					files.push(child);
				}
			} else if (child instanceof TFolder) {
				files.push(...this.collectDeckMarkdownFiles(child));
			}
		}
		return files;
	}

	private buildDefaultFlashcardBaseName(folder: TFolder): string {
		const existingCount = this.collectDeckMarkdownFiles(folder).length;
		const nextIndex = existingCount + 1;
		return `${folder.name}.${String(nextIndex).padStart(4, "0")}`;
	}

	private getUniqueNewFlashcardPath(folder: TFolder): string {
		const baseName = this.buildDefaultFlashcardBaseName(folder);
		const base = `${folder.path}/${baseName}`;
		let candidate = `${base}.md`;
		let n = Number(baseName.split(".").pop() || "1");

		while (this.app.vault.getAbstractFileByPath(candidate)) {
			n++;
			candidate = `${folder.path}/${folder.name}.${String(n).padStart(4, "0")}.md`;
		}

		return candidate;
	}

	async createFlashcardFromDeckFolder(folder: TFolder): Promise<void> {
		const deckResult = await this.getDeckDefinitionForFolder(folder);
		if (!deckResult.deck) {
			new Notice(deckResult.error);
			return;
		}

		const notePath = this.getUniqueNewFlashcardPath(folder);
		const content = this.createFlashcardTemplate(
			deckResult.deck.config.requiredSections,
		);

		try {
			const created = await this.app.vault.create(notePath, content);
			const leaf = this.app.workspace.getLeaf("tab");
			await leaf.openFile(created);
			new Notice(`Created flashcard: ${created.path}`);
		} catch (error) {
			console.error("Flashcards: failed to create note", error);
			new Notice("Failed to create flashcard note.");
		}
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
