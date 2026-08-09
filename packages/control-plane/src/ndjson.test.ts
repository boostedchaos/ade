import { describe, expect, it } from "bun:test";
import { encodeNdjson, NdjsonParser } from "./ndjson";

describe("NdjsonParser", () => {
	it("parses one object per line", () => {
		const parser = new NdjsonParser<{ id: string }>();
		const { values, invalid } = parser.parse('{"id":"1"}\n{"id":"2"}\n');
		expect(values).toEqual([{ id: "1" }, { id: "2" }]);
		expect(invalid).toEqual([]);
	});

	it("holds a line split across chunks until its newline arrives", () => {
		const parser = new NdjsonParser<{ id: string }>();
		expect(parser.parse('{"id":').values).toEqual([]);
		expect(parser.parse('"1"}').values).toEqual([]);
		expect(parser.parse("\n").values).toEqual([{ id: "1" }]);
	});

	it("handles a split in the middle of a multi-byte-looking payload", () => {
		const parser = new NdjsonParser<{ text: string }>();
		parser.parse('{"text":"héllo — ');
		const { values } = parser.parse('wörld"}\n');
		expect(values).toEqual([{ text: "héllo — wörld" }]);
	});

	it("returns several pipelined requests from a single chunk", () => {
		const parser = new NdjsonParser<{ id: string }>();
		const { values } = parser.parse('{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n');
		expect(values.map((v) => v.id)).toEqual(["a", "b", "c"]);
	});

	it("skips blank lines rather than reporting them as invalid", () => {
		const parser = new NdjsonParser<{ id: string }>();
		const { values, invalid } = parser.parse('\n\n{"id":"1"}\n\n');
		expect(values).toEqual([{ id: "1" }]);
		expect(invalid).toEqual([]);
	});

	it("reports an unparseable line without losing the ones around it", () => {
		const parser = new NdjsonParser<{ id: string }>();
		const { values, invalid } = parser.parse(
			'{"id":"1"}\nnot json\n{"id":"2"}\n',
		);
		expect(values).toEqual([{ id: "1" }, { id: "2" }]);
		expect(invalid).toEqual(["not json"]);
	});

	it("keeps a trailing partial line out of the results", () => {
		const parser = new NdjsonParser<{ id: string }>();
		const { values } = parser.parse('{"id":"1"}\n{"id":"2"');
		expect(values).toEqual([{ id: "1" }]);
	});

	it("flags overflow when a line never terminates", () => {
		const parser = new NdjsonParser(16);
		parser.parse("x".repeat(64));
		expect(parser.overflowed).toBe(true);
	});

	it("does not flag overflow when a long chunk contains newlines", () => {
		const parser = new NdjsonParser<{ id: string }>(16);
		const { values } = parser.parse('{"id":"1"}\n{"id":"2"}\n');
		expect(parser.overflowed).toBe(false);
		expect(values.length).toBe(2);
	});
});

describe("encodeNdjson", () => {
	it("appends exactly one newline", () => {
		expect(encodeNdjson({ a: 1 })).toBe('{"a":1}\n');
	});
});
