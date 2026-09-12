import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';

const DOWNLOAD_TIMEOUT_MS = 10_000;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

/**
 * Turns a sprite spec into something a decoration can actually render.
 *
 * A spec is one of:
 *   - a bundled media-relative path  ("pets/penguin-clean.svg")
 *   - an absolute local path         ("C:\\sprites\\cat.gif")
 *   - an http(s) URL                 (downloaded once, then served from disk)
 *
 * The download step exists because `contentIconPath` silently ignores http(s) URLs
 * (microsoft/vscode#11055, open since 2016 — confusingly, `gutterIconPath` does follow them).
 * Cached assets keep working offline.
 */
export class AssetResolver {
	private readonly resolved = new Map<string, vscode.Uri>();
	private readonly inFlight = new Map<string, Promise<vscode.Uri>>();
	private warned = new Set<string>();

	constructor(private readonly ctx: vscode.ExtensionContext) {}

	invalidate(): void {
		this.resolved.clear();
		this.inFlight.clear();
		this.warned = new Set();
	}

	bundled(mediaRelativePath: string): vscode.Uri {
		return vscode.Uri.joinPath(this.ctx.extensionUri, 'media', mediaRelativePath);
	}

	/** Resolves many specs at once, de-duplicating repeats and concurrent requests. */
	async resolveAll(specs: Iterable<string>): Promise<Map<string, vscode.Uri>> {
		const unique = [...new Set(specs)];
		const entries = await Promise.all(
			unique.map(async spec => [spec, await this.resolve(spec)] as const)
		);
		return new Map(entries);
	}

	async resolve(spec: string): Promise<vscode.Uri> {
		const cached = this.resolved.get(spec);
		if (cached) {
			return cached;
		}
		const pending = this.inFlight.get(spec);
		if (pending) {
			return pending;
		}

		const task = this.resolveUncached(spec).then(uri => {
			this.resolved.set(spec, uri);
			this.inFlight.delete(spec);
			return uri;
		});
		this.inFlight.set(spec, task);
		return task;
	}

	private async resolveUncached(spec: string): Promise<vscode.Uri> {
		if (/^https?:\/\//i.test(spec)) {
			try {
				return await this.download(spec);
			} catch (err) {
				this.warnOnce(spec, `could not download ${spec} (${describe(err)})`);
				return this.bundled('pets/penguin-clean.svg');
			}
		}

		if (path.isAbsolute(spec)) {
			const local = vscode.Uri.file(spec);
			try {
				await vscode.workspace.fs.stat(local);
				return local;
			} catch {
				this.warnOnce(spec, `could not read ${spec}`);
				return this.bundled('pets/penguin-clean.svg');
			}
		}

		return this.bundled(spec);
	}

	private async download(url: string): Promise<vscode.Uri> {
		const dir = this.ctx.globalStorageUri;
		await vscode.workspace.fs.createDirectory(dir);

		const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
		const target = vscode.Uri.joinPath(dir, `sprite-${hash}${guessExtension(url)}`);

		try {
			await vscode.workspace.fs.stat(target);
			return target; // already cached
		} catch {
			// not cached yet
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
		try {
			const res = await fetch(url, { signal: controller.signal });
			if (!res.ok) {
				throw new Error(`HTTP ${res.status} ${res.statusText}`);
			}
			const bytes = new Uint8Array(await res.arrayBuffer());
			if (bytes.byteLength === 0) {
				throw new Error('the server returned an empty file');
			}
			if (bytes.byteLength > MAX_ASSET_BYTES) {
				throw new Error(`larger than ${MAX_ASSET_BYTES / 1024 / 1024} MB`);
			}
			await vscode.workspace.fs.writeFile(target, bytes);
			return target;
		} finally {
			clearTimeout(timeout);
		}
	}

	async clearCache(): Promise<void> {
		this.invalidate();
		try {
			await vscode.workspace.fs.delete(this.ctx.globalStorageUri, {
				recursive: true,
				useTrash: false
			});
		} catch {
			// nothing cached
		}
	}

	private warnOnce(key: string, message: string): void {
		if (this.warned.has(key)) {
			return;
		}
		this.warned.add(key);
		void vscode.window.showWarningMessage(`Pet Screensaver: ${message}. Using a bundled sprite instead.`);
	}
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function guessExtension(url: string): string {
	const allowed = ['.gif', '.png', '.svg', '.webp', '.jpg', '.jpeg', '.apng'];
	try {
		const pathname = new URL(url).pathname.toLowerCase();
		const match = allowed.find(ext => pathname.endsWith(ext));
		if (match) {
			return match;
		}
	} catch {
		// unparseable URL — fetch surfaces the real error
	}
	return '.gif';
}
