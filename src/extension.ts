import * as vscode from 'vscode';
import * as crypto from 'crypto';

const CONFIG_SECTION = 'petScreensaver';

/** Animation cadence. 15fps is smooth enough for a crawling pet and cheap enough to leave running. */
const FPS = 15;
const TICK_MS = Math.round(1000 / FPS);

const DOWNLOAD_TIMEOUT_MS = 10_000;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

/** Document schemes that are machine-generated, not the user typing. */
const IGNORED_SCHEMES = new Set(['output', 'log', 'vscode-scm', 'git', 'search-editor-result', 'vscode-chat-code-block']);

type Timer = ReturnType<typeof setTimeout>;

interface PetConfig {
	cleanPetUrl: string;
	idleTimeout: number;
	enabled: boolean;
	petSize: number;
	speed: number;
	sweepWidth: number;
	wipeEffect: boolean;
	wipeOpacity: number;
	lineHeightOverride: number;
}

function readConfig(): PetConfig {
	const c = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return {
		cleanPetUrl: c.get<string>('cleanPetUrl', '').trim(),
		idleTimeout: c.get<number>('idleTimeout', 60),
		enabled: c.get<boolean>('enabled', true),
		petSize: c.get<number>('petSize', 28),
		speed: c.get<number>('speed', 28),
		sweepWidth: c.get<number>('sweepWidth', 100),
		wipeEffect: c.get<boolean>('wipeEffect', true),
		wipeOpacity: c.get<number>('wipeOpacity', 0.12),
		lineHeightOverride: c.get<number>('lineHeightOverride', 0)
	};
}

function isUserDocument(doc: vscode.TextDocument): boolean {
	return !IGNORED_SCHEMES.has(doc.uri.scheme);
}

/**
 * The editor's line height in pixels. `TextEditor.options` does not expose it, so we mirror
 * the editor's own resolution rules: 0 means "derive from font size", and any value below 8
 * is treated as a multiplier rather than a pixel count.
 */
function resolveLineHeight(override: number): number {
	if (override > 0) {
		return override;
	}
	const cfg = vscode.workspace.getConfiguration('editor');
	const fontSize = cfg.get<number>('fontSize') ?? 14;
	const raw = cfg.get<number>('lineHeight') ?? 0;
	if (raw === 0) {
		return Math.round(fontSize * 1.5);
	}
	if (raw < 8) {
		return Math.round(fontSize * raw);
	}
	return Math.round(raw);
}

// ---------------------------------------------------------------------------
// Asset resolution
// ---------------------------------------------------------------------------

/**
 * Turns the `cleanPetUrl` setting into something a decoration can actually render.
 *
 * `contentIconPath` silently ignores http(s) URLs (microsoft/vscode#11055 — open since 2016,
 * even though `gutterIconPath` does follow them), so a remote asset has to be downloaded once
 * and handed to the decoration as a local file URI. Anything that fails falls back to the
 * bundled pet with an explanation, so the user never gets an invisible pet and no reason why.
 */
class AssetResolver {
	private cached?: { key: string; uri: vscode.Uri };

	constructor(private readonly ctx: vscode.ExtensionContext) {}

	invalidate(): void {
		this.cached = undefined;
	}

	private get bundled(): vscode.Uri {
		return vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'pet-default.svg');
	}

	async resolve(rawValue: string): Promise<vscode.Uri> {
		const key = rawValue.trim();
		if (this.cached?.key === key) {
			return this.cached.uri;
		}
		const uri = await this.resolveUncached(key);
		this.cached = { key, uri };
		return uri;
	}

	private async resolveUncached(value: string): Promise<vscode.Uri> {
		if (!value) {
			return this.bundled;
		}

		if (!/^https?:\/\//i.test(value)) {
			const local = vscode.Uri.file(value);
			try {
				await vscode.workspace.fs.stat(local);
				return local;
			} catch {
				void vscode.window.showWarningMessage(
					`Pet Screensaver: could not read "${value}". Using the bundled pet instead.`
				);
				return this.bundled;
			}
		}

		try {
			return await this.download(value);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			void vscode.window.showWarningMessage(
				`Pet Screensaver: could not download the pet (${reason}). Using the bundled pet instead.`
			);
			return this.bundled;
		}
	}

	private async download(url: string): Promise<vscode.Uri> {
		const dir = this.ctx.globalStorageUri;
		await vscode.workspace.fs.createDirectory(dir);

		const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
		const target = vscode.Uri.joinPath(dir, `pet-${hash}${guessExtension(url)}`);

		try {
			await vscode.workspace.fs.stat(target);
			return target; // already cached — works offline from here on
		} catch {
			// not cached yet, fall through and fetch
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
		try {
			const res = await fetch(url, { signal: controller.signal });
			if (!res.ok) {
				throw new Error(`HTTP ${res.status} ${res.statusText}`);
			}
			const bytes = new Uint8Array(await res.arrayBuffer());
			if (bytes.byteLength === 0) {
				throw new Error('the server returned an empty file');
			}
			if (bytes.byteLength > MAX_ASSET_BYTES) {
				throw new Error(`the image is larger than ${MAX_ASSET_BYTES / 1024 / 1024} MB`);
			}
			await vscode.workspace.fs.writeFile(target, bytes);
			return target;
		} finally {
			clearTimeout(timeout);
		}
	}

	async clearCache(): Promise<void> {
		this.invalidate();
		try {
			await vscode.workspace.fs.delete(this.ctx.globalStorageUri, { recursive: true, useTrash: false });
		} catch {
			// nothing cached — nothing to do
		}
	}
}

function guessExtension(url: string): string {
	const allowed = ['.gif', '.png', '.svg', '.webp', '.jpg', '.jpeg', '.apng'];
	try {
		const path = new URL(url).pathname.toLowerCase();
		const match = allowed.find(ext => path.endsWith(ext));
		if (match) {
			return match;
		}
	} catch {
		// unparseable URL — fetch will surface the real error
	}
	return '.gif';
}

// ---------------------------------------------------------------------------
// The animation engine
// ---------------------------------------------------------------------------

/**
 * Draws the pet into the editor using decorations, and moves it a step at a time.
 *
 * Two things make this work, and both are worth knowing before editing:
 *
 * 1. An inline `after` decoration normally occupies layout space and shoves the surrounding
 *    code sideways. We take it out of flow by injecting `position:absolute` through
 *    `textDecoration`, which VS Code interpolates into the generated CSS rule verbatim
 *    (unlike `contentText`, which is escaped). This is undocumented internal behaviour: it
 *    broke in VS Code 1.88 and was restored in 1.100, hence the `^1.100.0` engine floor.
 *    If a future release starts escaping it, the pet will still render but will push code
 *    around — `buildPetDecoration` is the only place to repair.
 *
 * 2. Horizontal position comes from CSS (`left: <n>ch`), not from the decoration's column.
 *    The decoration is always anchored at column 0. Because the editor font is monospace,
 *    1ch is exactly one column, so the pet glides the full sweep width even over blank or
 *    very short lines. Anchoring to real character positions would make it stutter and stop
 *    short at the end of every short line.
 */
class Screensaver implements vscode.Disposable {
	private timer?: Timer;
	private editor?: vscode.TextEditor;

	/** Decoration types keyed by `${direction}:${column}`, built lazily and dropped on stop. */
	private pool = new Map<string, vscode.TextEditorDecorationType>();
	private active?: vscode.TextEditorDecorationType;
	private wipeType?: vscode.TextEditorDecorationType;

	/** Bumped by every stop() so an in-flight async start() knows to abandon itself. */
	private generation = 0;

	private cfg: PetConfig = readConfig();
	private petUri?: vscode.Uri;
	private lineHeight = 19;

	// Path state
	private line = 0;
	private col = 0;
	private dirX: 1 | -1 = 1;
	private dirY: 1 | -1 = 1;
	private topLine = 0;
	private bottomLine = 0;
	private sweepWidth = 100;

	constructor(private readonly assets: AssetResolver) {}

	get isRunning(): boolean {
		return this.timer !== undefined;
	}

	async start(editor: vscode.TextEditor): Promise<void> {
		this.stop();
		const generation = this.generation;

		const cfg = readConfig();
		const visible = editor.visibleRanges[0];
		if (!visible) {
			return;
		}

		const petUri = await this.assets.resolve(cfg.cleanPetUrl);

		// The user may have typed, or the editor closed, while the asset was resolving.
		if (generation !== this.generation || !vscode.window.visibleTextEditors.includes(editor)) {
			return;
		}

		this.cfg = cfg;
		this.petUri = petUri;
		this.lineHeight = resolveLineHeight(cfg.lineHeightOverride);
		this.editor = editor;

		this.topLine = visible.start.line;
		this.bottomLine = Math.min(visible.end.line, editor.document.lineCount - 1);
		this.sweepWidth = this.measureSweepWidth(editor.document);

		this.line = this.topLine;
		this.col = 0;
		this.dirX = 1;
		this.dirY = 1;

		if (cfg.wipeEffect) {
			this.wipeType = vscode.window.createTextEditorDecorationType({
				rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
				opacity: String(cfg.wipeOpacity)
			});
		}

		this.timer = setInterval(() => this.tick(), TICK_MS);
		this.render();
	}

	/**
	 * Synchronous by design — this is what makes the pet vanish the instant a key is pressed.
	 * Safe to call repeatedly.
	 */
	stop(): void {
		this.generation++;

		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}

		// Disposing a decoration type removes its decorations, but clear explicitly first so
		// nothing lingers if the editor is mid-render.
		const editor = this.editor;
		if (editor) {
			try {
				for (const deco of this.pool.values()) {
					editor.setDecorations(deco, []);
				}
				if (this.wipeType) {
					editor.setDecorations(this.wipeType, []);
				}
			} catch {
				// editor already disposed — the dispose() calls below still clean up
			}
		}

		for (const deco of this.pool.values()) {
			deco.dispose();
		}
		this.pool.clear();
		this.wipeType?.dispose();
		this.wipeType = undefined;
		this.active = undefined;
		this.editor = undefined;
	}

	dispose(): void {
		this.stop();
	}

	/** Sweep across the code that is actually there, not across empty space to the right of it. */
	private measureSweepWidth(doc: vscode.TextDocument): number {
		let longest = 0;
		for (let line = this.topLine; line <= this.bottomLine; line++) {
			longest = Math.max(longest, doc.lineAt(line).text.length);
		}
		return Math.max(40, Math.min(this.cfg.sweepWidth, longest + 8));
	}

	private tick(): void {
		const editor = this.editor;
		if (!editor || editor.document.isClosed || !vscode.window.visibleTextEditors.includes(editor)) {
			this.stop();
			return;
		}

		this.col += (this.cfg.speed / FPS) * this.dirX;

		if (this.dirX > 0 && this.col >= this.sweepWidth) {
			this.col = this.sweepWidth;
			this.dirX = -1;
			this.advanceLine();
		} else if (this.dirX < 0 && this.col <= 0) {
			this.col = 0;
			this.dirX = 1;
			this.advanceLine();
		}

		this.render();
	}

	/** Serpentine: drop a line at each end of a sweep, and bounce at the top and bottom. */
	private advanceLine(): void {
		this.line += this.dirY;
		if (this.line > this.bottomLine) {
			this.line = this.bottomLine;
			this.dirY = -1;
		} else if (this.line < this.topLine) {
			this.line = this.topLine;
			this.dirY = 1;
		}
	}

	private render(): void {
		const editor = this.editor;
		if (!editor) {
			return;
		}

		const line = Math.min(this.line, editor.document.lineCount - 1);
		const column = Math.max(0, Math.round(this.col));
		const deco = this.decorationFor(column, this.dirX < 0);

		if (this.active && this.active !== deco) {
			editor.setDecorations(this.active, []);
		}
		editor.setDecorations(deco, [new vscode.Range(line, 0, line, 0)]);
		this.active = deco;

		if (this.wipeType) {
			editor.setDecorations(this.wipeType, this.buildWipeRanges(editor.document, line, column));
		}
	}

	private decorationFor(column: number, facingLeft: boolean): vscode.TextEditorDecorationType {
		const key = `${facingLeft ? 'l' : 'r'}:${column}`;
		const existing = this.pool.get(key);
		if (existing) {
			return existing;
		}
		const deco = this.buildPetDecoration(column, facingLeft);
		this.pool.set(key, deco);
		return deco;
	}

	/**
	 * The one place that depends on VS Code interpolating `textDecoration` into the CSS rule
	 * without escaping it. See the class comment.
	 */
	private buildPetDecoration(column: number, facingLeft: boolean): vscode.TextEditorDecorationType {
		const size = this.cfg.petSize;
		// Centre the pet on the line rather than letting it hang below the baseline.
		const top = -Math.round((size - this.lineHeight) / 2);

		const css = [
			'none',
			'position:absolute',
			`left:${column}ch`,
			`top:${top}px`,
			`width:${size}px`,
			`height:${size}px`,
			'z-index:10',
			'pointer-events:none',
			`transform:scaleX(${facingLeft ? -1 : 1})`
		].join('; ') + ';';

		return vscode.window.createTextEditorDecorationType({
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
			after: {
				contentIconPath: this.petUri,
				width: `${size}px`,
				height: `${size}px`,
				textDecoration: css
			}
		});
	}

	/**
	 * Everything above the pet reads as "already cleaned". The region grows as it descends and
	 * shrinks as it climbs back, so the code fades out and returns.
	 *
	 * This is a rendering effect only — no TextEdit is ever constructed, and the document is
	 * never touched.
	 */
	private buildWipeRanges(doc: vscode.TextDocument, line: number, column: number): vscode.Range[] {
		const ranges: vscode.Range[] = [];

		for (let l = this.topLine; l < line; l++) {
			const length = doc.lineAt(l).text.length;
			if (length > 0) {
				ranges.push(new vscode.Range(l, 0, l, length));
			}
		}

		const currentLength = doc.lineAt(line).text.length;
		const upto = Math.min(column, currentLength);
		if (upto > 0) {
			ranges.push(new vscode.Range(line, 0, line, upto));
		}

		return ranges;
	}
}

// ---------------------------------------------------------------------------
// Idle tracking
// ---------------------------------------------------------------------------

/**
 * Watches for signs of life and arms the idle timer.
 *
 * The screensaver's own `setDecorations` calls do not raise any of these events, so there is
 * no feedback loop — the animation cannot mistake itself for user activity.
 */
class IdleWatcher implements vscode.Disposable {
	private timer?: Timer;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly screensaver: Screensaver) {
		const bump = () => this.onActivity();

		this.disposables.push(
			vscode.workspace.onDidChangeTextDocument(e => {
				// Without these guards a background log or output channel resets the timer
				// forever and the screensaver never fires.
				if (e.contentChanges.length === 0) {
					return;
				}
				if (!isUserDocument(e.document)) {
					return;
				}
				if (e.document !== vscode.window.activeTextEditor?.document) {
					return;
				}
				bump();
			}),

			vscode.window.onDidChangeTextEditorSelection(e => {
				if (isUserDocument(e.textEditor.document)) {
					bump();
				}
			}),

			// Scrolling counts as being awake.
			vscode.window.onDidChangeTextEditorVisibleRanges(e => {
				if (isUserDocument(e.textEditor.document)) {
					bump();
				}
			}),

			vscode.window.onDidChangeActiveTextEditor(() => bump()),

			// Partial cover for terminal work, which raises no editor events at all.
			vscode.window.onDidChangeActiveTerminal(() => bump()),

			vscode.window.onDidChangeWindowState(state => {
				if (state.focused) {
					bump();
				} else {
					// Nothing to look at — stop burning cycles.
					this.clearTimer();
					this.screensaver.stop();
				}
			}),

			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration(CONFIG_SECTION)) {
					bump();
				}
			})
		);

		this.arm();
	}

	private onActivity(): void {
		this.screensaver.stop();
		this.arm();
	}

	private arm(): void {
		this.clearTimer();
		const cfg = readConfig();
		if (!cfg.enabled) {
			return;
		}
		const delay = Math.max(5, cfg.idleTimeout) * 1000;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.trigger();
		}, delay);
	}

	private async trigger(): Promise<void> {
		if (!vscode.window.state.focused) {
			return; // refocusing will re-arm
		}
		const editor = vscode.window.activeTextEditor;
		if (!editor || !isUserDocument(editor.document)) {
			this.arm(); // no editor to draw on — check again later
			return;
		}
		await this.screensaver.start(editor);
	}

	private clearTimer(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	dispose(): void {
		this.clearTimer();
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables.length = 0;
	}
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
	const assets = new AssetResolver(context);
	const screensaver = new Screensaver(assets);
	const watcher = new IdleWatcher(screensaver);

	context.subscriptions.push(
		screensaver,
		watcher,

		vscode.commands.registerCommand('petScreensaver.start', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				void vscode.window.showInformationMessage('Pet Screensaver: open a file first.');
				return;
			}
			await screensaver.start(editor);
		}),

		vscode.commands.registerCommand('petScreensaver.stop', () => screensaver.stop()),

		vscode.commands.registerCommand('petScreensaver.clearAssetCache', async () => {
			screensaver.stop();
			await assets.clearCache();
			void vscode.window.showInformationMessage(
				'Pet Screensaver: cached pet removed. It will be downloaded again next time.'
			);
		}),

		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(`${CONFIG_SECTION}.cleanPetUrl`)) {
				assets.invalidate();
			}
		})
	);
}

export function deactivate(): void {
	// Disposables registered on the context handle teardown.
}
