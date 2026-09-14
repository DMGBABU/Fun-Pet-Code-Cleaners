import * as vscode from 'vscode';

/**
 * A stretch of actual code on one line: the columns between the first non-whitespace
 * character and the end of the line.
 *
 * Pets only ever travel along these, which is what keeps them off the empty space to the
 * right of short lines — and, usefully, means every position a pet occupies has a real
 * character under it. That is what lets decorations be anchored to genuine (line, column)
 * positions instead of needing one decoration type per pixel column.
 */
export interface CodeSegment {
	line: number;
	start: number;
	end: number;
}

/** Ignore slivers of code too narrow to be worth walking along. */
const MIN_SEGMENT_WIDTH = 3;

export function scanTerrain(editor: vscode.TextEditor): CodeSegment[] {
	const doc = editor.document;
	const segments: CodeSegment[] = [];

	for (const visible of editor.visibleRanges) {
		const last = Math.min(visible.end.line, doc.lineCount - 1);
		for (let line = visible.start.line; line <= last; line++) {
			const textLine = doc.lineAt(line);
			if (textLine.isEmptyOrWhitespace) {
				continue;
			}
			const start = textLine.firstNonWhitespaceCharacterIndex;
			const end = textLine.text.trimEnd().length;
			if (end - start >= MIN_SEGMENT_WIDTH) {
				segments.push({ line, start, end });
			}
		}
	}

	return segments;
}

export function segmentWidth(segment: CodeSegment): number {
	return segment.end - segment.start;
}

/**
 * Which pet is currently working which line.
 *
 * `CleanLedger.isFullyClean` already stops a pet re-sweeping a *finished* line, but two pets
 * choosing the same dirty line at the same moment would both work it — neither sees it as
 * clean until one of them finishes. A claim is taken when a line is chosen, not when it is
 * reached, so the second pet looks elsewhere while the first is still walking over.
 */
export class SegmentClaims {
	private readonly owners = new Map<number, object>();

	clear(): void {
		this.owners.clear();
	}

	/** True if `owner` may work this line — either nobody holds it, or they already do. */
	isAvailable(line: number, owner: object): boolean {
		const current = this.owners.get(line);
		return current === undefined || current === owner;
	}

	claim(line: number, owner: object): void {
		this.owners.set(line, owner);
	}

	release(line: number, owner: object): void {
		if (this.owners.get(line) === owner) {
			this.owners.delete(line);
		}
	}

	releaseAll(owner: object): void {
		for (const [line, held] of [...this.owners]) {
			if (held === owner) {
				this.owners.delete(line);
			}
		}
	}
}

interface Span {
	start: number;
	end: number;
}

/**
 * Tracks how much of each line has been swept, for the wipe effect.
 *
 * Spans are kept as a list of disjoint intervals rather than a single min/max hull. A pet that
 * sweeps columns 0-5 and later 18-22 on the same line must dim only those two stretches — a
 * hull would dim the untouched code in between, which makes the fade look unrelated to where
 * the pet actually went.
 */
export class CleanLedger {
	private readonly spans = new Map<number, Span[]>();

	constructor(private readonly terrain: CodeSegment[]) {}

	clear(): void {
		this.spans.clear();
	}

	/** Records that [start, end] on `line` has been swept, merging into any touching span. */
	mark(line: number, start: number, end: number): void {
		const lo = Math.min(start, end);
		const hi = Math.max(start, end);
		if (hi - lo <= 0) {
			return;
		}

		const list = this.spans.get(line) ?? [];
		list.push({ start: lo, end: hi });
		list.sort((a, b) => a.start - b.start);

		const merged: Span[] = [];
		for (const span of list) {
			const last = merged[merged.length - 1];
			// Half a column of slack so consecutive sweep steps join up cleanly.
			if (last && span.start <= last.end + 0.5) {
				last.end = Math.max(last.end, span.end);
			} else {
				merged.push({ ...span });
			}
		}
		this.spans.set(line, merged);
	}

	isFullyClean(segment: CodeSegment): boolean {
		const list = this.spans.get(segment.line);
		if (!list) {
			return false;
		}
		return list.some(s => s.start <= segment.start + 0.5 && s.end >= segment.end - 0.5);
	}

	/** True once every segment of code on screen has been swept end to end. */
	get allClean(): boolean {
		return this.terrain.length > 0 && this.terrain.every(s => this.isFullyClean(s));
	}

	toRanges(): vscode.Range[] {
		const ranges: vscode.Range[] = [];
		for (const [line, list] of this.spans) {
			for (const span of list) {
				const start = Math.round(span.start);
				const end = Math.round(span.end);
				if (end > start) {
					ranges.push(new vscode.Range(line, start, line, end));
				}
			}
		}
		return ranges;
	}
}
