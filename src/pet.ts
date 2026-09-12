import * as vscode from 'vscode';
import { clamp, EntranceKind } from './config';
import { SpritePool } from './decorations';
import { PetSpecies, PROP_SPRITES, SPRITE_STATES, spriteFor, SpriteState } from './pets';
import { CleanLedger, CodeSegment } from './terrain';

export type Phase = 'entering' | 'cleaning' | 'returning' | 'leaving' | 'done';

/** Tick budgets for each choreography, at 15fps. */
const ENTER_TICKS: Record<EntranceKind, number> = { edge: 14, door: 24, ladder: 28, abseil: 26 };
const LEAVE_TICKS: Record<EntranceKind, number> = { edge: 12, door: 20, ladder: 22, abseil: 20 };

/** Cap on the walk-home leg so an interrupted pet is never slow to clear off. */
const RETURN_MAX_TICKS = 12;

const LADDER_LINES = 4;
const ABSEIL_LINES = 4;
const EDGE_SLIDE_PX = 90;

export interface PetEnv {
	terrain: CodeSegment[];
	ledger: CleanLedger;
	charsPerTick: number;
	rng(): number;
}

export interface DrawEnv {
	pool: SpritePool;
	uris: Map<string, vscode.Uri>;
	doc: vscode.TextDocument;
	petSize: number;
	lineHeight: number;
	charWidth: number;
}

/**
 * One pet: enters with a bit of theatre, sweeps code until interrupted, then leaves the same
 * way it arrived.
 *
 * Positions are kept as floats (`line`, `col`) and snapped to a real character anchor only at
 * draw time, with the fractional part becoming a sub-character pixel offset. That keeps
 * movement smooth without needing a decoration type per pixel.
 */
export class Pet {
	phase: Phase = 'entering';

	line: number;
	col: number;
	facing: 1 | -1 = 1;

	private opacity = 1;
	private propOpacity = 0;
	private dxPx = 0;

	private phaseTick = 0;

	/** Where it came in, and therefore where it must go back to. */
	private readonly anchorLine: number;
	private readonly anchorCol: number;
	private readonly edgeSign: 1 | -1;

	private mode: 'sweep' | 'travel' = 'sweep';
	private segment?: CodeSegment;

	// Travel leg
	private travelFrom = { line: 0, col: 0 };
	private travelTo = { line: 0, col: 0 };
	private travelTicks = 1;
	private travelTick = 0;
	private travelTarget?: CodeSegment;

	constructor(
		readonly species: PetSpecies,
		readonly entrance: EntranceKind,
		start: CodeSegment,
		env: PetEnv
	) {
		this.segment = start;
		this.anchorLine = start.line;
		this.anchorCol = Math.round(start.start + env.rng() * Math.max(1, start.end - start.start));
		this.line = this.anchorLine;
		this.col = this.anchorCol;
		this.edgeSign = env.rng() < 0.5 ? -1 : 1;

		// Ladder and abseil deliver the pet above where it touched down.
		if (entrance === 'ladder') {
			this.line = this.anchorLine;
		} else if (entrance === 'abseil') {
			this.line = this.anchorLine - (ABSEIL_LINES - 1);
		}
	}

	get isDone(): boolean {
		return this.phase === 'done';
	}

	// -----------------------------------------------------------------------
	// Simulation
	// -----------------------------------------------------------------------

	tick(env: PetEnv): void {
		switch (this.phase) {
			case 'entering':
				this.tickEntering();
				break;
			case 'cleaning':
				this.tickCleaning(env);
				break;
			case 'returning':
				this.tickReturning();
				break;
			case 'leaving':
				this.tickLeaving();
				break;
			case 'done':
				break;
		}
	}

	/** Asks the pet to pack up. It walks home, performs its exit, then reports `done`. */
	beginExit(): void {
		if (this.phase === 'leaving' || this.phase === 'done') {
			return;
		}
		this.phase = 'returning';
		this.phaseTick = 0;
		this.beginTravel(this.anchorLine, this.anchorCol, RETURN_MAX_TICKS);
	}

	private tickEntering(): void {
		const total = ENTER_TICKS[this.entrance];
		const t = Math.min(1, this.phaseTick / total);

		switch (this.entrance) {
			case 'edge': {
				this.opacity = 1;
				this.propOpacity = 0;
				// edgeSign 1 means it slid in from the left, so it is walking rightwards.
				this.dxPx = -this.edgeSign * EDGE_SLIDE_PX * (1 - easeOutCubic(t));
				this.facing = this.edgeSign;
				break;
			}
			case 'door': {
				// door swings open, pet steps out, door closes behind it
				this.propOpacity = t < 0.7 ? Math.min(1, t / 0.25) : Math.max(0, (1 - t) / 0.3);
				this.opacity = clamp((t - 0.25) / 0.25, 0, 1);
				this.dxPx = Math.max(0, (t - 0.55) / 0.45) * 14 * this.facing;
				break;
			}
			case 'ladder': {
				this.propOpacity = t < 0.8 ? Math.min(1, t / 0.2) : Math.max(0, (1 - t) / 0.2);
				this.opacity = clamp((t - 0.15) / 0.15, 0, 1);
				// climb from the foot of the ladder to the top
				const climb = clamp((t - 0.2) / 0.6, 0, 1);
				this.line = this.anchorLine - climb * (LADDER_LINES - 1);
				break;
			}
			case 'abseil': {
				this.propOpacity = t < 0.8 ? Math.min(1, t / 0.2) : Math.max(0, (1 - t) / 0.2);
				this.opacity = clamp(t / 0.2, 0, 1);
				const drop = clamp((t - 0.2) / 0.7, 0, 1);
				this.line = (this.anchorLine - (ABSEIL_LINES - 1)) + drop * (ABSEIL_LINES - 1);
				break;
			}
		}

		this.phaseTick++;
		if (this.phaseTick > total) {
			this.opacity = 1;
			this.propOpacity = 0;
			this.dxPx = 0;
			this.line = Math.round(this.line);
			this.phase = 'cleaning';
			this.mode = 'sweep';
			this.phaseTick = 0;
		}
	}

	private tickCleaning(env: PetEnv): void {
		if (this.mode === 'travel') {
			this.advanceTravel();
			if (this.travelTick >= this.travelTicks) {
				this.segment = this.travelTarget;
				this.mode = 'sweep';
				if (this.segment) {
					// Approach from whichever end we arrived nearest to.
					const fromLeft = Math.abs(this.col - this.segment.start) <= Math.abs(this.col - this.segment.end);
					this.facing = fromLeft ? 1 : -1;
					this.col = fromLeft ? this.segment.start : this.segment.end;
					this.line = this.segment.line;
				}
			}
			return;
		}

		const segment = this.segment;
		if (!segment) {
			this.chooseNextSegment(env);
			return;
		}

		const previous = this.col;
		this.col += env.charsPerTick * this.facing;

		const low = Math.max(segment.start, Math.min(previous, this.col));
		const high = Math.min(segment.end, Math.max(previous, this.col));
		if (high > low) {
			env.ledger.mark(segment.line, low, high);
		}

		const finished = this.facing > 0 ? this.col >= segment.end : this.col <= segment.start;
		if (finished) {
			this.col = clamp(this.col, segment.start, segment.end);
			this.chooseNextSegment(env);
		}
	}

	private tickReturning(): void {
		this.advanceTravel();
		this.phaseTick++;
		const arrived = this.travelTick >= this.travelTicks;
		if (arrived || this.phaseTick >= RETURN_MAX_TICKS) {
			this.line = this.anchorLine;
			this.col = this.anchorCol;
			this.phase = 'leaving';
			this.phaseTick = 0;
		}
	}

	private tickLeaving(): void {
		const total = LEAVE_TICKS[this.entrance];
		const t = Math.min(1, this.phaseTick / total);

		switch (this.entrance) {
			case 'edge': {
				// Leaving retraces the entry, so it walks back the other way.
				this.dxPx = -this.edgeSign * EDGE_SLIDE_PX * easeInCubic(t);
				this.facing = this.edgeSign > 0 ? -1 : 1;
				this.opacity = 1 - clamp((t - 0.6) / 0.4, 0, 1);
				break;
			}
			case 'door': {
				this.propOpacity = Math.min(1, t / 0.25);
				this.dxPx = Math.max(0, 1 - t / 0.5) * 14 * this.facing;
				this.opacity = 1 - clamp((t - 0.4) / 0.25, 0, 1);
				if (t > 0.8) {
					this.propOpacity = Math.max(0, (1 - t) / 0.2);
				}
				break;
			}
			case 'ladder': {
				this.propOpacity = t < 0.8 ? Math.min(1, t / 0.2) : Math.max(0, (1 - t) / 0.2);
				const descend = clamp((t - 0.2) / 0.55, 0, 1);
				this.line = (this.anchorLine - (LADDER_LINES - 1)) + descend * (LADDER_LINES - 1);
				this.opacity = 1 - clamp((t - 0.75) / 0.25, 0, 1);
				break;
			}
			case 'abseil': {
				this.propOpacity = t < 0.8 ? Math.min(1, t / 0.2) : Math.max(0, (1 - t) / 0.2);
				const rise = clamp((t - 0.15) / 0.6, 0, 1);
				this.line = this.anchorLine - rise * (ABSEIL_LINES - 1);
				this.opacity = 1 - clamp((t - 0.7) / 0.3, 0, 1);
				break;
			}
		}

		this.phaseTick++;
		if (this.phaseTick > total) {
			this.phase = 'done';
			this.opacity = 0;
			this.propOpacity = 0;
		}
	}

	// -----------------------------------------------------------------------
	// Roaming
	// -----------------------------------------------------------------------

	/** Prefers dirty code, and prefers it nearby, so the pet reads as working a patch. */
	private chooseNextSegment(env: PetEnv): void {
		const dirty = env.terrain.filter(s => !env.ledger.isFullyClean(s));
		const pool = dirty.length > 0 ? dirty : env.terrain;
		if (pool.length === 0) {
			return;
		}

		const nearest = [...pool]
			.sort((a, b) => Math.abs(a.line - this.line) - Math.abs(b.line - this.line))
			.slice(0, 5);
		const next = nearest[Math.floor(env.rng() * nearest.length)] ?? pool[0];

		if (next === this.segment && pool.length > 1) {
			this.facing = this.facing > 0 ? -1 : 1;
			return;
		}

		this.travelTarget = next;
		const entryCol = Math.abs(this.col - next.start) <= Math.abs(this.col - next.end)
			? next.start
			: next.end;
		const distance = Math.abs(next.line - this.line) + Math.abs(entryCol - this.col) / 12;
		this.beginTravel(next.line, entryCol, clamp(Math.round(distance * 2.2), 4, 22));
		this.mode = 'travel';
	}

	private beginTravel(line: number, col: number, ticks: number): void {
		this.travelFrom = { line: this.line, col: this.col };
		this.travelTo = { line, col };
		this.travelTicks = Math.max(1, ticks);
		this.travelTick = 0;
		this.facing = col >= this.col ? 1 : -1;
	}

	private advanceTravel(): void {
		this.travelTick++;
		const t = easeInOut(Math.min(1, this.travelTick / this.travelTicks));
		this.line = this.travelFrom.line + (this.travelTo.line - this.travelFrom.line) * t;
		this.col = this.travelFrom.col + (this.travelTo.col - this.travelFrom.col) * t;
	}

	// -----------------------------------------------------------------------
	// Drawing
	// -----------------------------------------------------------------------

	draw(env: DrawEnv): void {
		if (this.opacity <= 0.02 && this.propOpacity <= 0.02) {
			return;
		}

		if (this.propOpacity > 0.02) {
			this.drawProp(env);
		}

		if (this.opacity <= 0.02) {
			return;
		}

		const spec = spriteFor(this.species, this.spriteState);
		const uri = env.uris.get(spec);
		if (!uri) {
			return;
		}

		const anchor = this.anchorAt(env.doc, this.line, this.col);
		const size = env.petSize;

		env.pool.draw(
			{
				uri,
				width: size,
				height: size,
				facing: this.facing,
				dx: anchor.frac * env.charWidth + this.dxPx,
				// Sit the sprite on the line rather than letting it hang below the baseline.
				dy: -(size - env.lineHeight) / 2,
				opacity: this.opacity,
				z: 12
			},
			anchor.line,
			anchor.col
		);
	}

	private drawProp(env: DrawEnv): void {
		const geometry = this.propGeometry(env);
		if (!geometry) {
			return;
		}
		const uri = env.uris.get(geometry.spec);
		if (!uri) {
			return;
		}

		// Props are bottom-aligned to the line the pet arrived on, whatever the choreography.
		const anchor = this.anchorAt(env.doc, this.anchorLine, this.anchorCol);

		env.pool.draw(
			{
				uri,
				width: geometry.width,
				height: geometry.height,
				facing: 1,
				dx: anchor.frac * env.charWidth,
				// Bottom-align the prop with the anchor line.
				dy: -(geometry.height - env.lineHeight),
				opacity: this.propOpacity,
				z: 11
			},
			anchor.line,
			anchor.col
		);
	}

	private propGeometry(env: DrawEnv): { spec: string; width: number; height: number } | undefined {
		const size = env.petSize;
		switch (this.entrance) {
			case 'door':
				return { spec: PROP_SPRITES.door, width: size * 1.35, height: size * 1.7 };
			case 'ladder':
				return {
					spec: PROP_SPRITES.ladder,
					width: size * 1.1,
					height: LADDER_LINES * env.lineHeight
				};
			case 'abseil':
				return {
					spec: PROP_SPRITES.rope,
					width: size * 0.9,
					height: ABSEIL_LINES * env.lineHeight
				};
			case 'edge':
				return undefined;
		}
	}

	private get spriteState(): SpriteState {
		if (this.phase === 'entering' || this.phase === 'leaving') {
			if (this.entrance === 'ladder') {
				return 'climb';
			}
			if (this.entrance === 'abseil') {
				return 'hang';
			}
			return 'walk';
		}
		if (this.phase === 'returning') {
			return 'run'; // heading home in a hurry
		}
		return this.mode === 'sweep' ? 'clean' : 'walk';
	}

	/** Snaps a float position onto a real character, keeping the remainder as a pixel offset. */
	private anchorAt(doc: vscode.TextDocument, line: number, col: number) {
		const snappedLine = clamp(Math.round(line), 0, doc.lineCount - 1);
		const maxCol = doc.lineAt(snappedLine).text.length;
		const snappedCol = clamp(col, 0, maxCol);
		const whole = Math.floor(snappedCol);
		return { line: snappedLine, col: whole, frac: snappedCol - whole };
	}
}

function easeOutCubic(t: number): number {
	return 1 - Math.pow(1 - t, 3);
}

function easeInCubic(t: number): number {
	return t * t * t;
}

function easeInOut(t: number): number {
	return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** Every sprite spec a roster could ask for, so assets can be pre-resolved before a run. */
export function spriteSpecsFor(species: PetSpecies[]): string[] {
	const specs = new Set<string>(Object.values(PROP_SPRITES));
	for (const pet of species) {
		for (const state of SPRITE_STATES) {
			specs.add(spriteFor(pet, state));
		}
	}
	return [...specs];
}
