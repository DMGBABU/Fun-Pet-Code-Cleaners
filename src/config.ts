import * as vscode from 'vscode';

export const CONFIG_SECTION = 'petScreensaver';

/** Animation cadence. 15fps is smooth for a small sprite and cheap to leave running. */
export const FPS = 15;
export const TICK_MS = Math.round(1000 / FPS);

export type EntranceKind = 'door' | 'ladder' | 'abseil' | 'edge';

export const ALL_ENTRANCES: EntranceKind[] = ['door', 'ladder', 'abseil', 'edge'];

/** A user-supplied pet, contributed through `petScreensaver.customPets`. */
export interface CustomPetManifest {
	id: string;
	label?: string;
	/** State name -> image URL or absolute local path. `clean` is the only required one. */
	sprites: Record<string, string>;
	entrances?: EntranceKind[];
}

export interface PetConfig {
	enabled: boolean;
	idleTimeout: number;

	pets: string[];
	customPets: CustomPetManifest[];
	cleanPetUrl: string;

	minPets: number;
	maxPets: number;

	petSize: number;
	speed: number;
	travelSpeed: number;
	entrances: EntranceKind[];

	wipeEffect: boolean;
	wipeOpacity: number;
	exitAnimation: boolean;

	lineHeightOverride: number;
}

export function readConfig(): PetConfig {
	const c = vscode.workspace.getConfiguration(CONFIG_SECTION);

	const minPets = clamp(c.get<number>('minPets', 5), 1, 12);
	const maxPets = clamp(c.get<number>('maxPets', 8), minPets, 12);

	const entrances = c.get<string[]>('entrances', ALL_ENTRANCES)
		.filter((e): e is EntranceKind => (ALL_ENTRANCES as string[]).includes(e));

	return {
		enabled: c.get<boolean>('enabled', true),
		idleTimeout: Math.max(5, c.get<number>('idleTimeout', 60)),

		pets: c.get<string[]>('pets', []),
		customPets: c.get<CustomPetManifest[]>('customPets', []).filter(isUsableManifest),
		cleanPetUrl: c.get<string>('cleanPetUrl', '').trim(),

		minPets,
		maxPets,

		petSize: Math.max(0, c.get<number>('petSize', 0)),
		speed: clamp(c.get<number>('speed', 3), 0.5, 60),
		travelSpeed: clamp(c.get<number>('travelSpeed', 2), 0.2, 30),
		entrances: entrances.length > 0 ? entrances : ALL_ENTRANCES,

		wipeEffect: c.get<boolean>('wipeEffect', true),
		wipeOpacity: clamp(c.get<number>('wipeOpacity', 0.12), 0, 1),
		exitAnimation: c.get<boolean>('exitAnimation', true),

		lineHeightOverride: Math.max(0, c.get<number>('lineHeightOverride', 0))
	};
}

function isUsableManifest(m: unknown): m is CustomPetManifest {
	if (typeof m !== 'object' || m === null) {
		return false;
	}
	const candidate = m as Partial<CustomPetManifest>;
	return typeof candidate.id === 'string'
		&& candidate.id.length > 0
		&& typeof candidate.sprites === 'object'
		&& candidate.sprites !== null
		&& typeof candidate.sprites.clean === 'string';
}

/**
 * The editor's line height in pixels. `TextEditor.options` does not expose it, so mirror the
 * editor's own rules: 0 means "derive from font size", and anything below 8 is a multiplier
 * rather than a pixel count.
 */
export function resolveLineHeight(override: number): number {
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

/** Pets default to exactly one line tall, so they read as small and cute. */
export function resolvePetSize(cfg: PetConfig, lineHeight: number): number {
	return cfg.petSize > 0 ? cfg.petSize : lineHeight;
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

const IGNORED_SCHEMES = new Set([
	'output', 'log', 'vscode-scm', 'git', 'search-editor-result', 'vscode-chat-code-block'
]);

export function isUserDocument(doc: vscode.TextDocument): boolean {
	return !IGNORED_SCHEMES.has(doc.uri.scheme);
}
