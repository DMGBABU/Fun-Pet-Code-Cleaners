import * as vscode from 'vscode';
import { clamp, EntranceKind } from './config';
import { SpritePool } from './decorations';
import {
	ACTIVITY_SPRITES,
	PetSpecies,
	PROP_SPRITES,
	SCRIBBLE_SPRITES,
	sharedSpriteSpecs,
	SPRITE_STATES,
	spriteFor,
	SpriteState
} from './pets';
import { CleanLedger, CodeSegment, SegmentClaims } from './terrain';

export type Phase = 'entering' | 'cleaning' | 'returning' | 'leaving' | 'done';

/** What a pet does when there is nothing to clean. Chosen at random, never by species. */
export type Activity = 'scribble' | 'sleep' | 'eat' | 'dance';
const ACTIVITIES: Activity[] = ['scribble', 'sleep', 'eat', 'dance'];

/** A proper knock-off, for when the code is spotless. */
const IDLE_MIN_TICKS = 70;
const IDLE_MAX_TICKS = 170;
/** A quick breather between lines, so idling is seen even on a file that is never finished. */
const BREAK_MIN_TICKS = 30;
const BREAK_MAX_TICKS = 75;
/** Chance of taking that breather after finishing a line. */
const BREAK_CHANCE = 0.12;

const MAX_SCRIBBLES = 5;
const SCRIBBLE_EVERY = 13;

/** Tick budgets for each choreography, at 15fps. Leaving is unhurried enough to watch. */
const ENTER_TICKS: Record<EntranceKind, number> = { edge: 14, door: 24, ladder: 28, abseil: 26 };
const LEAVE_TICKS: Record<EntranceKind, number> = { edge: 20, door: 34, ladder: 38, abseil: 34 };

/**
 * The walk home is run at a pace, not a fixed budget. A fixed budget meant a pet thirty lines
 * away covered several lines per tick, which is why an interrupted exit looked like everything
 * vanishing at once. The cap keeps a very distant pet from dawdling.
 */
const RUN_PACE_MULTIPLIER = 3;
const RETURN_MIN_TICKS = 10;
/**
 * A pet further from home than this budget allows does exceed running pace — the clamp wins.
 * That is deliberate: holding true pace across a 50-line viewport would mean a seven-second
 * exit. At this budget the worst case is about nine lines a second, which still reads as a
 * sprint rather than a teleport.
 */
const RETURN_MAX_TICKS = 60;

const LADDER_LINES = 4;
const ABSEIL_LINES = 4;
const EDGE_SLIDE_PX = 90;

export interface PetEnv {
	terrain: CodeSegment[];
	ledger: CleanLedger;
	claims: SegmentClaims;
	/** Sweeping pace, in characters per tick. */
	charsPerTick: number;
	/** Walking pace between lines, in lines per tick. */
	linesPerTick: number;
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
	/** Where the exit choreography begins — the top of the ladder, not its foot. */
	private readonly homeLine: number;
	private readonly edgeSign: 1 | -1;

	private mode: 'sweep' | 'travel' | 'idle' = 'sweep';
	private segment?: CodeSegment;

	// Idle play
	private activity?: Activity;
	private activityTicks = 0;
	private tilt = 0;
	private scribbles: Array<{ line: number; col: number; kind: number }> = [];
	private scribbleCooldown = 0;

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
		env.claims.claim(start.line, this);
		this.anchorLine = start.line;
		this.anchorCol = Math.round(start.start + env.rng() * Math.max(1, start.end - start.start));
		this.line = this.anchorLine;
		this.col = this.anchorCol;
		this.edgeSign = env.rng() < 0.5 ? -1 : 1;

		// A ladder sets the pet down at its top, several lines above the foot; every other
		// entrance leaves it on the anchor line. The exit has to start from the same place.
		this.homeLine = entrance === 'ladder' ? this.anchorLine - (LADDER_LINES - 1) : this.anchorLine;

		if (entrance === 'abseil') {
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
				this.tickEntering(env);
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
	beginExit(env: PetEnv): void {
		if (this.phase === 'leaving' || this.phase === 'done') {
			return;
		}
		env.claims.releaseAll(this);
		this.endIdle(); // drop the nap, the snack and any doodles
		this.phase = 'returning';
		this.phaseTick = 0;
		// Running pace: faster than a stroll because the user is back, but still a pace, so the
		// dash home is watchable. It heads for `homeLine`, which for a ladder is the top rung
		// the exit animation descends from.
		this.beginTravel(this.homeLine, this.anchorCol, this.runTicksTo(env, this.homeLine, this.anchorCol));
	}

	private tickEntering(env: PetEnv): void {
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
			this.settleAfterEntrance(env);
			this.phase = 'cleaning';
			this.mode = 'sweep';
			this.phaseTick = 0;
		}
	}

	/**
	 * Re-binds the pet to whatever line it is actually standing on.
	 *
	 * An entrance can move it: a ladder leaves it several lines above the one it was created
	 * for. Without this the pet would sweep its original line while standing somewhere else,
	 * so the dimming would appear detached from the pet doing it.
	 */
	private settleAfterEntrance(env: PetEnv): void {
		this.line = Math.round(this.line);

		if (this.segment) {
			env.claims.release(this.segment.line, this);
			this.segment = undefined;
		}

		const landed = env.terrain.find(s => s.line === this.line);
		if (landed && env.claims.isAvailable(landed.line, this)) {
			env.claims.claim(landed.line, this);
			this.segment = landed;
			this.col = clamp(this.col, landed.start, landed.end);
		}
		// Landed on a blank line, or someone already has it: leave `segment` unset and let
		// tickCleaning walk this pet to real work.
	}

	private tickCleaning(env: PetEnv): void {
		if (this.mode === 'idle') {
			this.tickIdle(env);
			return;
		}

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
		if (arrived || this.phaseTick > RETURN_MAX_TICKS) {
			this.line = this.homeLine;
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
		// Hand back the line we just finished so someone else may walk over it.
		if (this.segment) {
			env.claims.release(this.segment.line, this);
		}

		const available = env.terrain.filter(
			s => !env.ledger.isFullyClean(s) && env.claims.isAvailable(s.line, this)
		);

		if (available.length === 0) {
			// Everything is either done or spoken for. Knocking off and playing is far better
			// television than packing up and leaving, which just ended the show.
			this.beginIdle(env, IDLE_MIN_TICKS, IDLE_MAX_TICKS);
			return;
		}

		// Occasionally take a breather even with work outstanding, so the idle antics show up
		// on a big file that never gets finished.
		if (env.rng() < BREAK_CHANCE) {
			this.beginIdle(env, BREAK_MIN_TICKS, BREAK_MAX_TICKS);
			return;
		}

		// Prefer nearby work, so a pet reads as working a patch rather than criss-crossing.
		const nearest = [...available]
			.sort((a, b) => Math.abs(a.line - this.line) - Math.abs(b.line - this.line))
			.slice(0, 4);
		const next = nearest[Math.floor(env.rng() * nearest.length)] ?? available[0];

		env.claims.claim(next.line, this);
		this.travelTarget = next;

		const entryCol = Math.abs(this.col - next.start) <= Math.abs(this.col - next.end)
			? next.start
			: next.end;
		this.beginTravel(next.line, entryCol, this.walkTicksTo(env, next.line, entryCol));
		this.mode = 'travel';
	}

	/**
	 * How long it takes to walk somewhere, derived from actual pace rather than a fixed tick
	 * budget. A fixed budget made long hops across a gap in the code look like teleporting,
	 * because the same number of ticks covered one line or twenty.
	 */
	private walkTicksTo(env: PetEnv, line: number, col: number): number {
		const vertical = Math.abs(line - this.line) / Math.max(1e-4, env.linesPerTick);
		// Travelling is not cleaning, so it moves a little faster than a sweep.
		const horizontal = Math.abs(col - this.col) / Math.max(1e-4, env.charsPerTick * 1.6);
		return Math.max(4, Math.round(Math.max(vertical, horizontal)));
	}

	/**
	 * Knocks off and picks something to do. The activity is drawn at random every time, so the
	 * same pet naps once and snacks the next — nothing is tied to a species.
	 */
	private beginIdle(env: PetEnv, minTicks: number, maxTicks: number): void {
		if (this.segment) {
			env.claims.release(this.segment.line, this);
			this.segment = undefined;
		}
		this.mode = 'idle';
		this.activity = ACTIVITIES[Math.floor(env.rng() * ACTIVITIES.length)];
		this.activityTicks = Math.round(minTicks + env.rng() * (maxTicks - minTicks));
		this.scribbles = [];
		this.scribbleCooldown = 0;
		this.tilt = 0;
	}

	private tickIdle(env: PetEnv): void {
		this.activityTicks--;

		switch (this.activity) {
			case 'sleep':
				// A slow list to one side, as though nodding off on its feet.
				this.tilt = -8 + Math.sin(this.activityTicks / 22) * 3;
				break;
			case 'dance':
				this.tilt = Math.sin(this.activityTicks / 2.2) * 13;
				break;
			case 'scribble':
				this.tilt = Math.sin(this.activityTicks / 3) * 4;
				if (--this.scribbleCooldown <= 0 && this.scribbles.length < MAX_SCRIBBLES) {
					this.scribbleCooldown = SCRIBBLE_EVERY;
					this.scribbles.push({
						line: Math.round(this.line),
						col: Math.round(this.col) + 1 + Math.floor(env.rng() * 6),
						kind: Math.floor(env.rng() * 3)
					});
				}
				break;
			default:
				this.tilt = 0;
				break;
		}

		// Look up now and then: another pet may have released a line, or the code may have
		// "got dirty" again when the round reset.
		const lookForWork = this.activityTicks <= 0 || this.activityTicks % 20 === 0;
		if (lookForWork) {
			const work = env.terrain.some(
				s => !env.ledger.isFullyClean(s) && env.claims.isAvailable(s.line, this)
			);
			if (work) {
				this.endIdle();
				this.chooseNextSegment(env);
				return;
			}
		}

		if (this.activityTicks <= 0) {
			this.beginIdle(env, IDLE_MIN_TICKS, IDLE_MAX_TICKS);
		}
	}

	private endIdle(): void {
		this.mode = 'sweep';
		this.activity = undefined;
		this.activityTicks = 0;
		this.scribbles = [];
		this.tilt = 0;
	}

	/** Same idea as `walkTicksTo`, at a run, and bounded so an exit is never open-ended. */
	private runTicksTo(env: PetEnv, line: number, col: number): number {
		const vertical = Math.abs(line - this.line) / Math.max(1e-4, env.linesPerTick * RUN_PACE_MULTIPLIER);
		const horizontal = Math.abs(col - this.col) / Math.max(1e-4, env.charsPerTick * RUN_PACE_MULTIPLIER * 1.6);
		return clamp(Math.round(Math.max(vertical, horizontal)), RETURN_MIN_TICKS, RETURN_MAX_TICKS);
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
		// Linear: walking is a steady pace. Easing here made the middle of a long walk
		// accelerate, which is what read as a jump.
		const t = Math.min(1, this.travelTick / this.travelTicks);
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

		this.drawActivity(env);

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
				// Centre on the line, plus the sub-line remainder so vertical movement glides
				// rather than hopping a whole line at a time.
				dy: -(size - env.lineHeight) / 2 + anchor.lineFrac * env.lineHeight,
				opacity: this.opacity,
				rotate: this.tilt,
				z: 12
			},
			anchor.line,
			anchor.col
		);
	}

	/** The Zzz, the snack, the music note, and any doodles left on the code. */
	private drawActivity(env: DrawEnv): void {
		if (this.mode !== 'idle' || !this.activity) {
			return;
		}

		const size = env.petSize;

		for (const mark of this.scribbles) {
			const uri = env.uris.get(SCRIBBLE_SPRITES[mark.kind] ?? SCRIBBLE_SPRITES[0]);
			if (!uri) {
				continue;
			}
			const at = this.anchorAt(env.doc, mark.line, mark.col);
			env.pool.draw(
				{
					uri,
					width: size * 0.85,
					height: size * 0.85,
					facing: 1,
					dx: at.frac * env.charWidth,
					dy: -(size * 0.85 - env.lineHeight) / 2 + at.lineFrac * env.lineHeight,
					opacity: 0.95,
					z: 11
				},
				at.line,
				at.col
			);
		}

		const spec = this.activityPropSpec();
		if (!spec) {
			return;
		}
		const uri = env.uris.get(spec);
		if (!uri) {
			return;
		}

		const anchor = this.anchorAt(env.doc, this.line, this.col);
		// Zzz and music float overhead; food is held out in front.
		const overhead = this.activity === 'sleep' || this.activity === 'dance';

		env.pool.draw(
			{
				uri,
				width: size * 0.9,
				height: size * 0.9,
				facing: 1,
				dx: anchor.frac * env.charWidth + (overhead ? size * 0.45 : size * 0.8) * this.facing,
				dy: -(size * 0.9 - env.lineHeight) / 2
					+ anchor.lineFrac * env.lineHeight
					+ (overhead ? -size * 0.7 : size * 0.12),
				opacity: 1,
				z: 13
			},
			anchor.line,
			anchor.col
		);
	}

	private activityPropSpec(): string | undefined {
		switch (this.activity) {
			case 'sleep':
				return ACTIVITY_SPRITES.zzz;
			case 'dance':
				return ACTIVITY_SPRITES.note;
			case 'eat':
				return this.species.food ?? ACTIVITY_SPRITES.snack;
			default:
				return undefined;
		}
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
		if (this.mode === 'idle') {
			// Doodling wants the tool in hand; napping, snacking and dancing do not.
			return this.activity === 'scribble' ? 'clean' : 'walk';
		}
		return this.mode === 'sweep' ? 'clean' : 'walk';
	}

	/**
	 * Snaps a float position onto a real character, keeping both remainders as pixel offsets.
	 *
	 * The vertical remainder matters as much as the horizontal one: a decoration can only be
	 * anchored to a whole line, so without `lineFrac` a pet crossing lines hops a full line
	 * height at a time, which reads as jumping however slow the underlying pace is.
	 */
	private anchorAt(doc: vscode.TextDocument, line: number, col: number) {
		const bounded = clamp(line, 0, doc.lineCount - 1);
		const snappedLine = Math.round(bounded);
		const lineFrac = bounded - snappedLine; // -0.5 .. 0.5

		const maxCol = doc.lineAt(snappedLine).text.length;
		const snappedCol = clamp(col, 0, maxCol);
		const whole = Math.floor(snappedCol);

		return { line: snappedLine, col: whole, frac: snappedCol - whole, lineFrac };
	}
}

function easeOutCubic(t: number): number {
	return 1 - Math.pow(1 - t, 3);
}

function easeInCubic(t: number): number {
	return t * t * t;
}

/** Every sprite spec a roster could ask for, so assets can be pre-resolved before a run. */
export function spriteSpecsFor(species: PetSpecies[]): string[] {
	const specs = new Set<string>(sharedSpriteSpecs());
	for (const pet of species) {
		for (const state of SPRITE_STATES) {
			specs.add(spriteFor(pet, state));
		}
		if (pet.food) {
			specs.add(pet.food);
		}
	}
	return [...specs];
}
