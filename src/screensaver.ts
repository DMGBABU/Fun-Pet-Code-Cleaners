import * as vscode from 'vscode';
import { AssetResolver } from './assets';
import { EntranceKind, PetConfig, readConfig, resolveLineHeight, resolvePetSize, TICK_MS } from './config';
import { SpritePool } from './decorations';
import { Pet, PetEnv, spriteSpecsFor } from './pet';
import { PetSpecies, resolveRoster } from './pets';
import { CleanLedger, CodeSegment, scanTerrain, SegmentClaims } from './terrain';

type Timer = ReturnType<typeof setTimeout>;

/** Pause between a finished round and the next crew arriving. */
const RESPAWN_TICKS = 26;

/** Hard ceiling on a graceful exit, so an interrupted run always clears promptly. */
const EXIT_DEADLINE_TICKS = 34;

/** Ladder and abseil need headroom above the touchdown line. */
const HEADROOM_LINES = 4;

interface Metrics {
	lineHeight: number;
	petSize: number;
	charWidth: number;
}

export class Screensaver implements vscode.Disposable {
	private timer?: Timer;
	private editor?: vscode.TextEditor;

	private readonly pool = new SpritePool();
	private wipeType?: vscode.TextEditorDecorationType;

	private pets: Pet[] = [];
	private roster: PetSpecies[] = [];
	private terrain: CodeSegment[] = [];
	private ledger?: CleanLedger;
	private readonly claims = new SegmentClaims();
	private uris = new Map<string, vscode.Uri>();

	private cfg: PetConfig = readConfig();
	private metrics: Metrics = { lineHeight: 19, petSize: 22, charWidth: 8 };

	/** Bumped on every stop so an in-flight async start abandons itself. */
	private generation = 0;

	private interrupted = false;
	private exitTicks = 0;
	private respawnIn = 0;

	constructor(private readonly assets: AssetResolver) {}

	get isRunning(): boolean {
		return this.timer !== undefined;
	}

	get isExiting(): boolean {
		return this.interrupted;
	}

	async start(editor: vscode.TextEditor): Promise<void> {
		this.hardStop();
		const generation = this.generation;

		const cfg = readConfig();
		const terrain = scanTerrain(editor);
		if (terrain.length === 0) {
			return; // nothing to clean
		}

		const roster = resolveRoster(cfg);
		const uris = await this.assets.resolveAll(spriteSpecsFor(roster));

		// The user may have typed, or the editor closed, while assets resolved.
		if (generation !== this.generation || !vscode.window.visibleTextEditors.includes(editor)) {
			return;
		}

		this.cfg = cfg;
		this.editor = editor;
		this.terrain = terrain;
		this.roster = roster;
		this.uris = uris;
		this.ledger = new CleanLedger(terrain);
		this.claims.clear();
		this.metrics = computeMetrics(cfg);
		this.interrupted = false;
		this.exitTicks = 0;
		this.respawnIn = 0;

		if (cfg.wipeEffect) {
			// Dim with a translucent colour rather than `opacity`. CSS opacity on a span also
			// fades its pseudo-elements, so any pet anchored inside an already-swept range would
			// fade itself out. Colour only touches glyphs, never a `content: url()` sprite.
			// The !important beats the syntax token colour, which is set on a competing class.
			const wipe = `rgba(128,128,128,${cfg.wipeOpacity})`;
			this.wipeType = vscode.window.createTextEditorDecorationType({
				rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
				color: wipe,
				textDecoration: `none; color:${wipe} !important;`
			});
		}

		this.spawnCrew();
		this.timer = setInterval(() => this.tick(), TICK_MS);
	}

	/**
	 * The user is back. The wipe clears immediately so code is readable on the very first
	 * keystroke; the pets then get about a second to pack up and leave the way they came.
	 */
	interrupt(): void {
		if (!this.isRunning || this.interrupted) {
			return;
		}
		this.interrupted = true;
		this.exitTicks = 0;

		// Code becomes readable now, not when the animation finishes.
		this.clearWipe();

		if (!this.cfg.exitAnimation) {
			this.hardStop();
			return;
		}

		const env = this.env();
		for (const pet of this.pets) {
			pet.beginExit(env);
		}
	}

	/** Immediate teardown, no animation. Safe to call repeatedly. */
	hardStop(): void {
		this.generation++;

		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}

		this.clearWipe();
		this.pool.clear(this.editor);
		this.pool.dispose();

		this.wipeType?.dispose();
		this.wipeType = undefined;

		this.pets = [];
		this.ledger = undefined;
		this.claims.clear();
		this.terrain = [];
		this.interrupted = false;
		this.respawnIn = 0;
		this.editor = undefined;
	}

	dispose(): void {
		this.hardStop();
	}

	// -----------------------------------------------------------------------

	private tick(): void {
		const editor = this.editor;
		if (!editor || editor.document.isClosed || !vscode.window.visibleTextEditors.includes(editor)) {
			this.hardStop();
			return;
		}

		if (this.respawnIn > 0) {
			this.respawnIn--;
			this.pool.beginFrame();
			this.pool.commit(editor);
			if (this.respawnIn === 0) {
				this.ledger?.clear();
				this.claims.clear();
				this.clearWipe();
				this.spawnCrew();
			}
			return;
		}

		const env = this.env();
		for (const pet of this.pets) {
			pet.tick(env);
		}

		this.pool.beginFrame();
		for (const pet of this.pets) {
			pet.draw({
				pool: this.pool,
				uris: this.uris,
				doc: editor.document,
				petSize: this.metrics.petSize,
				lineHeight: this.metrics.lineHeight,
				charWidth: this.metrics.charWidth
			});
		}
		this.pool.commit(editor);

		if (this.wipeType && this.ledger && !this.interrupted) {
			editor.setDecorations(this.wipeType, this.ledger.toRanges());
		}

		if (this.interrupted) {
			this.exitTicks++;
			if (this.exitTicks > EXIT_DEADLINE_TICKS) {
				this.hardStop();
				return;
			}
		} else if (this.ledger?.allClean && this.pets.some(p => !p.isDone)) {
			// Everything on screen is spotless — the crew packs up on its own.
			for (const pet of this.pets) {
				pet.beginExit(env);
			}
		}

		if (this.pets.length > 0 && this.pets.every(p => p.isDone)) {
			if (this.interrupted) {
				this.hardStop();
				return;
			}
			this.pets = [];
			this.respawnIn = RESPAWN_TICKS;
		}
	}

	private env(): PetEnv {
		const ticksPerSecond = 1000 / TICK_MS;
		return {
			terrain: this.terrain,
			ledger: this.ledger!,
			claims: this.claims,
			charsPerTick: this.cfg.speed / ticksPerSecond,
			linesPerTick: this.cfg.travelSpeed / ticksPerSecond,
			rng: Math.random
		};
	}

	private spawnCrew(): void {
		// Never more pets than there are lines to work, or they would collide immediately.
		const count = Math.min(randomInt(this.cfg.minPets, this.cfg.maxPets), this.terrain.length);
		const env = this.env();
		const topLine = this.terrain[0]?.line ?? 0;

		// Draw starting lines without replacement so no two pets begin on the same one.
		const available = shuffle([...this.terrain]);

		// A shuffle bag rather than an independent random pick per pet: picking independently
		// throws up duplicates constantly, so a crew of five would often be three penguins.
		// This guarantees every species appears once before any repeats.
		let bag: PetSpecies[] = [];
		const nextSpecies = (): PetSpecies => {
			if (bag.length === 0) {
				bag = shuffle([...this.roster]);
			}
			return bag.pop()!;
		};

		this.pets = [];
		for (let i = 0; i < count; i++) {
			const segment = available[i];
			if (!segment) {
				break;
			}

			const species = nextSpecies();
			const allowed = species.entrances.filter(e => this.cfg.entrances.includes(e));
			let entrance: EntranceKind = allowed.length > 0 ? pick(allowed) : 'edge';

			// Ladders and ropes need room above the touchdown line to be visible at all.
			if ((entrance === 'ladder' || entrance === 'abseil') && segment.line - HEADROOM_LINES < topLine) {
				entrance = 'edge';
			}

			this.pets.push(new Pet(species, entrance, segment, env));
		}
	}

	private clearWipe(): void {
		if (this.wipeType && this.editor) {
			try {
				this.editor.setDecorations(this.wipeType, []);
			} catch {
				// editor gone; dispose handles the rest
			}
		}
	}
}

function computeMetrics(cfg: PetConfig): Metrics {
	const lineHeight = resolveLineHeight(cfg.lineHeightOverride);
	const fontSize = vscode.workspace.getConfiguration('editor').get<number>('fontSize') ?? 14;
	return {
		lineHeight,
		petSize: resolvePetSize(cfg, lineHeight),
		// Monospace advance width is ~0.6em across the fonts VS Code ships with. Only used for
		// sub-character smoothing, so a small error is invisible.
		charWidth: fontSize * 0.6
	};
}

function pick<T>(items: T[]): T {
	return items[Math.floor(Math.random() * items.length)];
}

function randomInt(min: number, max: number): number {
	return min + Math.floor(Math.random() * (max - min + 1));
}

function shuffle<T>(items: T[]): T[] {
	for (let i = items.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[items[i], items[j]] = [items[j], items[i]];
	}
	return items;
}
