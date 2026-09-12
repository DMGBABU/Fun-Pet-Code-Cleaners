import { ALL_ENTRANCES, CustomPetManifest, EntranceKind, PetConfig } from './config';

/** Sprite states a pet can be drawn in. `clean` is the only one every pet must provide. */
export type SpriteState = 'clean' | 'walk' | 'run' | 'climb' | 'hang';

/** Every state, in the order a missing sprite falls back through. */
export const SPRITE_STATES: SpriteState[] = ['clean', 'walk', 'run', 'climb', 'hang'];

export interface PetSpecies {
	id: string;
	label: string;
	/** State -> bundled media path, absolute local path, or http(s) URL. */
	sprites: Partial<Record<SpriteState, string>>;
	entrances: EntranceKind[];
}

export const BUNDLED_PETS: PetSpecies[] = [
	{
		id: 'penguin',
		label: 'Penguin',
		sprites: {
			clean: 'pets/penguin-clean.svg',
			walk: 'pets/penguin-walk.svg',
			run: 'pets/penguin-run.svg',
			climb: 'pets/penguin-climb.svg',
			hang: 'pets/penguin-hang.svg'
		},
		entrances: ALL_ENTRANCES
	},
	{
		id: 'cat',
		label: 'Cat',
		sprites: {
			clean: 'pets/cat-clean.svg',
			walk: 'pets/cat-walk.svg',
			run: 'pets/cat-run.svg',
			climb: 'pets/cat-climb.svg',
			hang: 'pets/cat-hang.svg'
		},
		entrances: ALL_ENTRANCES
	},
	{
		id: 'robot',
		label: 'Robot',
		sprites: {
			clean: 'pets/robot-clean.svg',
			walk: 'pets/robot-walk.svg',
			run: 'pets/robot-run.svg',
			climb: 'pets/robot-climb.svg',
			hang: 'pets/robot-hang.svg'
		},
		entrances: ALL_ENTRANCES
	}
];

export const PROP_SPRITES = {
	door: 'props/door.svg',
	ladder: 'props/ladder.svg',
	rope: 'props/rope.svg'
} as const;

/**
 * The pets available for this run: bundled species filtered by the `pets` setting, plus any
 * custom manifests, plus a synthetic species for the legacy single-image `cleanPetUrl`.
 */
export function resolveRoster(cfg: PetConfig): PetSpecies[] {
	const roster: PetSpecies[] = [];

	const wanted = cfg.pets.length > 0 ? new Set(cfg.pets) : undefined;
	for (const pet of BUNDLED_PETS) {
		if (!wanted || wanted.has(pet.id)) {
			roster.push(pet);
		}
	}

	for (const manifest of cfg.customPets) {
		roster.push(fromManifest(manifest));
	}

	if (cfg.cleanPetUrl) {
		roster.push({
			id: 'custom-url',
			label: 'Custom (cleanPetUrl)',
			sprites: { clean: cfg.cleanPetUrl, walk: cfg.cleanPetUrl },
			// A single image has no door or ladder art, so keep it to entrances that need none.
			entrances: ['edge']
		});
	}

	return roster.length > 0 ? roster : BUNDLED_PETS;
}

function fromManifest(manifest: CustomPetManifest): PetSpecies {
	const sprites: Partial<Record<SpriteState, string>> = {};
	for (const state of SPRITE_STATES) {
		const value = manifest.sprites[state];
		if (typeof value === 'string' && value.length > 0) {
			sprites[state] = value;
		}
	}
	return {
		id: manifest.id,
		label: manifest.label ?? manifest.id,
		sprites,
		entrances: manifest.entrances?.length ? manifest.entrances : ['edge']
	};
}

/** Falls back through states so a pet providing only `clean` still works everywhere. */
export function spriteFor(species: PetSpecies, state: SpriteState): string {
	// `run` degrades to `walk` before `clean`; climbing and hanging do too.
	const order: SpriteState[] = [state, 'walk', 'clean'];
	for (const candidate of order) {
		const value = species.sprites[candidate];
		if (value) {
			return value;
		}
	}
	return species.sprites.clean ?? PROP_SPRITES.door;
}
