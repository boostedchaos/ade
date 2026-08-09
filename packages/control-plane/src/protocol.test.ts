import { describe, expect, it } from "bun:test";
import { escapeControlChars, previewLine, redactSecrets } from "./protocol";

const ESC = "\u001b";

describe("escapeControlChars", () => {
	it("leaves printable text alone", () => {
		expect(escapeControlChars("hello world {}")).toBe("hello world {}");
	});

	it("escapes ESC, CR, LF and TAB", () => {
		expect(escapeControlChars(`${ESC}[31mred${ESC}[0m`)).toBe(
			"\\x1b[31mred\\x1b[0m",
		);
		expect(escapeControlChars("a\rb\nc\td")).toBe("a\\x0db\\x0ac\\x09d");
	});

	it("escapes NUL, DEL and C1", () => {
		expect(escapeControlChars("\u0000")).toBe("\\x00");
		expect(escapeControlChars("\u007f")).toBe("\\x7f");
		expect(escapeControlChars("\u009b")).toBe("\\x9b");
	});

	it("leaves non-ASCII printable characters intact", () => {
		expect(escapeControlChars("café — ok")).toBe("café — ok");
	});
});

describe("previewLine", () => {
	/**
	 * The line being previewed came from a peer that has NOT authenticated, and
	 * it is written straight to a terminal. Before this, its raw bytes were ANSI
	 * sequences the reader's terminal executed: the payload below uses CR to
	 * rewind the line and overwrite whatever prefix the logger printed, so a
	 * rejected connection could be made to render as an accepted one.
	 */
	it("neutralises a terminal-escape payload", () => {
		const hostile = `${ESC}[2K\rok: connection accepted${ESC}[0m`;
		const preview = previewLine(hostile);
		expect(preview).not.toContain(ESC);
		expect(preview).not.toContain("\r");
		expect(preview).toContain("\\x1b");
		expect(preview).toContain("\\x0d");
	});

	it("still redacts a token, and escapes what surrounds it", () => {
		const preview = previewLine(`{"token":"s3cret"}${ESC}[0m`);
		expect(preview).toContain("<redacted>");
		expect(preview).not.toContain("s3cret");
		expect(preview).not.toContain(ESC);
	});

	it("redaction runs BEFORE escaping, so escapes cannot hide a token", () => {
		// Escaping first would rewrite the quote/colon delimiters redactSecrets
		// keys off, and the secret would survive into the log.
		expect(previewLine('token="abc123"')).toContain("<redacted>");
		expect(previewLine('token="abc123"')).not.toContain("abc123");
	});

	it("truncates a long line and escapes the survivors", () => {
		const preview = previewLine(ESC.repeat(200), 10);
		expect(preview.startsWith("\\x1b")).toBe(true);
		expect(preview.endsWith("…")).toBe(true);
		expect(preview).not.toContain(ESC);
	});

	it("leaves a short printable line unchanged", () => {
		expect(previewLine("not json")).toBe("not json");
	});
});

describe("redactSecrets", () => {
	it("redacts token, secret, password, key and auth", () => {
		for (const field of ["token", "secret", "password", "key", "auth"]) {
			expect(redactSecrets(`${field}=hunter2`)).toBe(`${field}=<redacted>`);
		}
	});
});
