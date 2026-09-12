# Fun Pet Code Cleaners

A MobaXterm-inspired screensaver for VS Code. Go idle, and a small crew of pets arrives — through a door, up a ladder, down a rope, or scurrying in from the edge — and sweeps your code clean. Come back, and they run home and leave the way they came.

Everything renders **inside the active editor** using the native `createTextEditorDecorationType` API. No webview, no extra tab. The wipe effect is purely visual: no `TextEdit` is ever constructed, and your file is never modified.

## Running it

```bash
npm install
npm run compile
```

Press **F5** for the Extension Development Host, then run **`Pet Screensaver: Start Now`** to skip the idle wait.

## Commands

| Command | |
|---|---|
| `Pet Screensaver: Start Now` | Skip the idle timer |
| `Pet Screensaver: Stop` | Clear everything immediately |
| `Pet Screensaver: Choose Pets` | Pick which pets join the crew |
| `Pet Screensaver: Clear Downloaded Asset Cache` | Force downloaded sprites to be re-fetched |

## Settings

| Setting | Default | |
|---|---|---|
| `idleTimeout` | `60` | Seconds of inactivity before pets arrive |
| `enabled` | `true` | Idle activation. `Start Now` works regardless |
| `pets` | `[]` | Which bundled pets can appear (`penguin`, `cat`, `robot`). Empty means all |
| `minPets` / `maxPets` | `2` / `4` | A random count in this range turns up each round |
| `entrances` | all four | `door`, `ladder`, `abseil`, `edge` |
| `petSize` | `0` | Pixels. `0` matches your line height |
| `speed` | `6` | Characters per second |
| `exitAnimation` | `true` | Let pets run home instead of vanishing |
| `customPets` | `[]` | Your own pets — see below |
| `cleanPetUrl` | `""` | Shortcut for a single-image custom pet |
| `wipeEffect` / `wipeOpacity` | `true` / `0.12` | Fade code out behind the pets |
| `lineHeightOverride` | `0` | `0` auto-derives from your editor font |

## Adding your own pets

Animated GIFs and animated SVGs both work — declarative animation runs fine inside decorations.

```jsonc
"petScreensaver.customPets": [
  {
    "id": "my-pet",
    "label": "My Pet",
    "sprites": {
      "clean": "https://example.com/sweeping.gif",  // required
      "walk":  "https://example.com/walking.gif"    // optional, falls back to clean
    },
    "entrances": ["edge"]
  }
]
```

`sprites` accepts five states — `clean`, `walk`, `run`, `climb` and `hang`. Only `clean` is required; the rest fall back to it. Each bundled pet provides all five:

| State | When it plays |
|---|---|
| `clean` | Sweeping a line of code |
| `walk` | Moving between lines |
| `run` | Heading home after you come back |
| `climb` | On the ladder |
| `hang` | On the rope |

Values can be absolute local paths instead of URLs.

Remote images are downloaded once into global storage and rendered from there, because `contentIconPath` silently ignores http(s) URLs ([microsoft/vscode#11055](https://github.com/microsoft/vscode/issues/11055), open since 2016 — confusingly, `gutterIconPath` *does* follow them). Everything works offline after the first fetch.

**Sprite sheets will not work as-is.** These render as CSS `content: url(...)`, which cannot crop a region of a sheet. Supply individual frames or a pre-composed animated GIF per state.

Good sources: [Kenney.nl](https://kenney.nl) (CC0), [itch.io](https://itch.io/game-assets/free/tag-sprites), [OpenGameArt](https://opengameart.org), [LottieFiles](https://lottiefiles.com) (exports transparent GIF).

## How it works

Two decisions carry the whole design:

**Pets only walk on code.** `terrain.ts` scans the visible range for the span between each line's first non-whitespace character and its end, and pets travel only along those. That keeps them out of the empty space to the right of short lines — and, usefully, guarantees every position a pet occupies has a real character beneath it. That is what allows decorations to be anchored to genuine `(line, column)` positions, with the fractional part becoming a sub-character pixel offset. Anchoring to characters is why a crew of pets costs roughly 30 CSS rules rather than thousands.

**Sprites are lifted out of layout flow.** An inline `after` decoration normally occupies horizontal space and shoves the surrounding code sideways. `decorations.ts` injects `position:absolute` through `textDecoration`, which VS Code interpolates into the generated CSS rule verbatim (unlike `contentText`, which is escaped).

## Known limitations

- **The `position:absolute` injection is undocumented internal behaviour**, not supported API. It broke in VS Code 1.88 and was restored in 1.100, hence the `^1.100.0` engine floor. `create()` in [src/decorations.ts](src/decorations.ts) is the only place to repair if it regresses.
- **Chromium ignores `width`/`height` on replaced `content: url()` pseudo-elements** — confirmed in practice, not just in theory. Sprites are pinned to size with `max-width`/`max-height` (which *do* apply to replaced elements) plus `object-fit: contain`, and bundled SVGs ship without `width`/`height` attributes so they carry no intrinsic size. A custom GIF with an awkward aspect ratio will letterbox rather than stretch.
- **Typing in the integrated terminal raises no editor events**, so pets can arrive while you are working in the terminal. `onDidChangeActiveTerminal` covers this only partly; `Pet Screensaver: Stop` and `enabled` are the escape hatches.
- Pets sweep the **visible viewport only**, so your scroll position is never moved.
