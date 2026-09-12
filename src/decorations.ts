import * as vscode from 'vscode';

/**
 * How a sprite should look at the moment it is drawn. Everything here ends up baked into a
 * CSS rule, so the fields are quantised before being used as a pool key — see `keyOf`.
 */
export interface SpriteStyle {
	uri: vscode.Uri;
	width: number;
	height: number;
	facing: 1 | -1;
	/** Horizontal nudge in px, for sub-character smoothing and off-screen entrances. */
	dx: number;
	/** Vertical nudge in px, measured from the top of the anchor line. */
	dy: number;
	opacity: number;
	/** Higher sits in front. Props sit behind their pet. */
	z: number;
}

/** Quantisation steps. Finer looks smoother but multiplies the number of CSS rules. */
const DX_STEP = 2;
const DY_STEP = 2;
const OPACITY_STEP = 0.1;

/** Refuse to grow past this many rules; a runaway pool would bloat the editor stylesheet. */
const MAX_POOL = 600;

/**
 * Builds and reuses the decoration types that draw sprites.
 *
 * The load-bearing trick: an inline `after` decoration normally takes up layout space and
 * shoves the surrounding code sideways. We take it out of flow by injecting
 * `position:absolute` through `textDecoration`, which VS Code interpolates into the generated
 * CSS rule verbatim (unlike `contentText`, which is escaped). This is undocumented internal
 * behaviour — it broke in VS Code 1.88 and was restored in 1.100, hence the `^1.100.0` engine
 * floor. `create` below is the only place to repair if it ever regresses.
 *
 * Sprites are anchored to real (line, column) positions, which is possible only because pets
 * stay on top of actual code. See `terrain.ts`.
 */
export class SpritePool implements vscode.Disposable {
	private readonly pool = new Map<string, vscode.TextEditorDecorationType>();
	private frame = new Map<vscode.TextEditorDecorationType, vscode.Range[]>();
	private lastUsed = new Set<vscode.TextEditorDecorationType>();
	private exhausted = false;

	beginFrame(): void {
		this.frame = new Map();
	}

	/** Queues one sprite for this frame. Sprites sharing a style share a decoration type. */
	draw(style: SpriteStyle, line: number, column: number): void {
		const deco = this.get(style);
		if (!deco) {
			return;
		}
		const ranges = this.frame.get(deco);
		const range = new vscode.Range(line, column, line, column);
		if (ranges) {
			ranges.push(range);
		} else {
			this.frame.set(deco, [range]);
		}
	}

	/** Pushes the queued frame to the editor and clears anything drawn last frame but not this one. */
	commit(editor: vscode.TextEditor): void {
		for (const [deco, ranges] of this.frame) {
			editor.setDecorations(deco, ranges);
		}
		for (const deco of this.lastUsed) {
			if (!this.frame.has(deco)) {
				editor.setDecorations(deco, []);
			}
		}
		this.lastUsed = new Set(this.frame.keys());
	}

	clear(editor: vscode.TextEditor | undefined): void {
		if (editor) {
			for (const deco of this.pool.values()) {
				try {
					editor.setDecorations(deco, []);
				} catch {
					// editor already gone; dispose below still cleans up
				}
			}
		}
		this.frame = new Map();
		this.lastUsed = new Set();
	}

	dispose(): void {
		for (const deco of this.pool.values()) {
			deco.dispose();
		}
		this.pool.clear();
		this.frame = new Map();
		this.lastUsed = new Set();
		this.exhausted = false;
	}

	private get(style: SpriteStyle): vscode.TextEditorDecorationType | undefined {
		const key = keyOf(style);
		const existing = this.pool.get(key);
		if (existing) {
			return existing;
		}
		if (this.pool.size >= MAX_POOL) {
			if (!this.exhausted) {
				this.exhausted = true;
				console.warn('[pet-screensaver] sprite pool exhausted; some frames will be dropped');
			}
			return undefined;
		}
		const deco = create(style);
		this.pool.set(key, deco);
		return deco;
	}
}

function keyOf(s: SpriteStyle): string {
	return [
		s.uri.toString(),
		Math.round(s.width),
		Math.round(s.height),
		s.facing,
		quantise(s.dx, DX_STEP),
		quantise(s.dy, DY_STEP),
		quantise(s.opacity, OPACITY_STEP),
		s.z
	].join('|');
}

function quantise(value: number, step: number): number {
	return Math.round(value / step) * step;
}

function create(style: SpriteStyle): vscode.TextEditorDecorationType {
	const width = Math.round(style.width);
	const height = Math.round(style.height);
	const dx = quantise(style.dx, DX_STEP);
	const dy = quantise(style.dy, DY_STEP);
	const opacity = quantise(style.opacity, OPACITY_STEP);

	// `left`/`top` are relative to the .view-line the decoration is anchored in, so these are
	// offsets from the anchor character rather than absolute editor coordinates.
	const css = [
		'none',
		'position:absolute',
		`left:${dx}px`,
		`top:${dy}px`,
		`width:${width}px`,
		`height:${height}px`,
		// `content: url()` makes the pseudo-element a replaced element, and Chromium lets its
		// intrinsic size win over width/height. max-* does apply to replaced elements, so these
		// are what actually pin the sprite to the requested size. Bundled SVGs also ship without
		// width/height attributes so they have no intrinsic size to begin with.
		`max-width:${width}px`,
		`max-height:${height}px`,
		'object-fit:contain',
		`opacity:${opacity}`,
		`z-index:${style.z}`,
		'pointer-events:none',
		`transform:scaleX(${style.facing})`,
		'transform-origin:center'
	].join('; ') + ';';

	return vscode.window.createTextEditorDecorationType({
		rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
		after: {
			contentIconPath: style.uri,
			width: `${width}px`,
			height: `${height}px`,
			textDecoration: css
		}
	});
}
