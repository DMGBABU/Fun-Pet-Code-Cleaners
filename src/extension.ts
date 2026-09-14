import * as vscode from 'vscode';
import { AssetResolver } from './assets';
import { CONFIG_SECTION, isUserDocument, readConfig } from './config';
import { BUNDLED_PETS } from './pets';
import { Screensaver } from './screensaver';

type Timer = ReturnType<typeof setTimeout>;

/**
 * Watches for signs of life and arms the idle timer.
 *
 * The screensaver's own `setDecorations` calls raise none of these events, so the animation
 * cannot mistake itself for user activity.
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
				if (e.contentChanges.length === 0 || !isUserDocument(e.document)) {
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
					this.screensaver.hardStop();
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
		// The first nudge sends the pets home, and the exit is then left to play out. Killing
		// it on the next keystroke meant nobody ever saw them leave, since a second keystroke
		// is only milliseconds behind the first. Letting it run costs nothing: the dimming is
		// already cleared, the sprites take no layout space and cannot be clicked.
		// `Pet Screensaver: Stop` is there for anyone who wants them gone instantly.
		if (this.screensaver.isRunning) {
			this.screensaver.interrupt();
		}
		this.arm();
	}

	private arm(): void {
		this.clearTimer();
		const cfg = readConfig();
		if (!cfg.enabled) {
			return;
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.trigger();
		}, cfg.idleTimeout * 1000);
	}

	private async trigger(): Promise<void> {
		if (!vscode.window.state.focused) {
			return; // refocusing re-arms
		}
		const editor = vscode.window.activeTextEditor;
		if (!editor || !isUserDocument(editor.document)) {
			this.arm(); // nothing to draw on — check again later
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

		vscode.commands.registerCommand('petScreensaver.stop', () => screensaver.hardStop()),

		vscode.commands.registerCommand('petScreensaver.pickPets', async () => {
			const cfg = readConfig();
			const active = new Set(cfg.pets.length > 0 ? cfg.pets : BUNDLED_PETS.map(p => p.id));
			const chosen = await vscode.window.showQuickPick(
				BUNDLED_PETS.map(pet => ({
					label: pet.label,
					id: pet.id,
					picked: active.has(pet.id)
				})),
				{ canPickMany: true, title: 'Which pets should join the cleaning crew?' }
			);
			if (!chosen) {
				return;
			}
			await vscode.workspace.getConfiguration(CONFIG_SECTION).update(
				'pets',
				chosen.map(c => c.id),
				vscode.ConfigurationTarget.Global
			);
		}),

		vscode.commands.registerCommand('petScreensaver.clearAssetCache', async () => {
			screensaver.hardStop();
			await assets.clearCache();
			void vscode.window.showInformationMessage(
				'Pet Screensaver: downloaded sprites removed. They will be fetched again next time.'
			);
		}),

		vscode.workspace.onDidChangeConfiguration(e => {
			if (
				e.affectsConfiguration(`${CONFIG_SECTION}.cleanPetUrl`) ||
				e.affectsConfiguration(`${CONFIG_SECTION}.customPets`)
			) {
				assets.invalidate();
			}
		})
	);
}

export function deactivate(): void {
	// Disposables registered on the context handle teardown.
}
