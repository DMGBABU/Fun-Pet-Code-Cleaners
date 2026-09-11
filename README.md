# Fun Pet Code Cleaners

A MobaXterm-inspired screensaver for VS Code. Go idle, and a pet crawls across your code in a serpentine path, sweeping it clean. Touch the keyboard and it's gone instantly.

It renders **inside the active editor** using the native `createTextEditorDecorationType` API — no webview, no extra tab. The wipe effect is purely visual: no `TextEdit` is ever constructed, and your file is never modified.

## Running it

```bash
npm install
npm run compile
```

Then press **F5** to launch the Extension Development Host. Open a file and run **`Pet Screensaver: Start Now`** from the Command Palette to skip the idle wait.

## Settings

| Setting | Default | |
|---|---|---|
| `petScreensaver.cleanPetUrl` | `""` | URL (or local path) of an animated GIF with a transparent background. Empty uses the bundled penguin. |
| `petScreensaver.idleTimeout` | `60` | Seconds of inactivity before it activates. |
| `petScreensaver.enabled` | `true` | Idle activation. The `Start Now` command works regardless. |
| `petScreensaver.petSize` | `28` | Pixels. |
| `petScreensaver.speed` | `28` | Characters per second. |
| `petScreensaver.sweepWidth` | `100` | Max sweep width in columns. Auto-shrinks to fit the visible code. |
| `petScreensaver.wipeEffect` | `true` | Fade code out behind the pet, restore on the way back. |
| `petScreensaver.wipeOpacity` | `0.12` | |
| `petScreensaver.lineHeightOverride` | `0` | `0` auto-derives from your editor font. |

## Two things to verify on first run

VS Code compiles `contentIconPath` to `content: url(...)` rather than `background-image`, and Chromium is quirky about replaced pseudo-element content. Neither of these could be settled without running it:

1. **Does the GIF animate?** If it renders as a static first frame, the fix is to drive frames ourselves — the tick loop already exists, so add a `frameUrls` setting and cycle one decoration type per frame.
2. **Is `petSize` honoured?** Chromium is documented as ignoring `width`/`height` on replaced `content: url()` pseudo-elements. If the pet renders at its natural size, resize the source asset instead.

Check both with **`Developer: Toggle Developer Tools`** → inspect a `.view-line` `::after` and confirm the computed `position: absolute`.

## Known limitations

- **The `position:absolute` injection is undocumented internal behaviour**, not supported API. `textDecoration` is interpolated into the generated CSS rule verbatim, which is what takes the pet out of layout flow — without it, an inline `after` decoration shoves your code sideways. This broke in VS Code 1.88 and was restored in 1.100, hence the `^1.100.0` engine floor. `Screensaver.buildPetDecoration` is the only place to repair if it regresses.
- **Remote URLs cannot be handed to a decoration** ([microsoft/vscode#11055](https://github.com/microsoft/vscode/issues/11055), open since 2016 — confusingly, `gutterIconPath` *does* follow URLs). The extension downloads the asset once into `globalStorageUri` and renders from that cache, so it works offline afterwards. `Pet Screensaver: Clear Downloaded Asset Cache` forces a re-download.
- **Typing in the integrated terminal raises no editor events**, so the screensaver can start over your code while you're working in the terminal. `onDidChangeActiveTerminal` covers this only partly; `Pet Screensaver: Stop` and the `enabled` switch are the escape hatches.
- The pet sweeps the **visible viewport only**, so your scroll position is never moved.
