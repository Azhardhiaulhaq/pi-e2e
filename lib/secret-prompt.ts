/**
 * Masked input dialog: shows • per character, never renders the value.
 * Falls back to plain ctx.ui.input in RPC clients (no custom components there).
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export async function askSecret(ctx: ExtensionContext, title: string, masked = true): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;
	if (ctx.mode !== "tui") return ctx.ui.input(title, masked ? "(input is sent to the extension only)" : undefined);
	return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		let value = "";
		let inPaste = false;
		let pasteBuf = "";
		const add = (s: string) => {
			value += s.replace(/[\r\n\t]/g, "");
		};
		return {
			handleInput(data: string) {
				if (data.includes("\x1b[200~")) {
					inPaste = true;
					pasteBuf = "";
					data = data.replace("\x1b[200~", "");
				}
				if (inPaste) {
					pasteBuf += data;
					const end = pasteBuf.indexOf("\x1b[201~");
					if (end !== -1) {
						add(pasteBuf.slice(0, end));
						inPaste = false;
						pasteBuf = "";
					}
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.escape)) return done(undefined);
				if (matchesKey(data, Key.enter) || data === "\n" || data === "\r") return done(value);
				if (matchesKey(data, Key.backspace)) value = value.slice(0, -1);
				else if (matchesKey(data, Key.ctrl("u"))) value = "";
				else {
					const ch = decodeKittyPrintable(data) ?? (data.length === 1 && data >= " " ? data : data.length > 1 && !data.startsWith("\x1b") ? data : undefined);
					if (ch) add(ch);
				}
				tui.requestRender();
			},
			render(width: number) {
				const w = Math.max(10, width);
				const shown = masked ? "•".repeat(Math.min(value.length, w - 6)) : value;
				return [
					theme.fg("accent", "─".repeat(w)),
					truncateToWidth(" " + theme.fg("text", title), w),
					truncateToWidth(" " + theme.fg("accent", "> ") + shown + theme.fg("accent", "▏"), w),
					truncateToWidth(" " + theme.fg("dim", `Enter save • Esc cancel • Ctrl+U clear${masked ? " • hidden from the model and transcript" : ""}`), w),
					theme.fg("accent", "─".repeat(w)),
				];
			},
			invalidate() {},
		};
	});
}
