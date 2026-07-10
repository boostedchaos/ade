import { describe, expect, it } from "bun:test";
import { canonicalizePath } from "./path-canonical";

describe("canonicalizePath", () => {
	describe("win32", () => {
		it("unifies forward and back slashes to backslash", () => {
			expect(canonicalizePath("C:/Users/x/repo", "win32")).toBe(
				canonicalizePath("C:\\Users\\x\\repo", "win32"),
			);
		});

		it("folds drive-letter and path case", () => {
			expect(canonicalizePath("C:\\Users\\X\\Repo", "win32")).toBe(
				"c:\\users\\x\\repo",
			);
			expect(canonicalizePath("c:/users/x/repo", "win32")).toBe(
				"c:\\users\\x\\repo",
			);
		});

		it("matches git porcelain output against a path.join-style path", () => {
			// git emits forward slashes; we build with backslashes
			const fromGit = "C:/Users/dev/project/.worktrees/feature";
			const fromDb = "C:\\Users\\dev\\project\\.worktrees\\feature";
			expect(canonicalizePath(fromGit, "win32")).toBe(
				canonicalizePath(fromDb, "win32"),
			);
		});

		it("normalizes . and .. segments", () => {
			expect(canonicalizePath("C:\\a\\b\\..\\c", "win32")).toBe("c:\\a\\c");
		});

		it("treats distinct paths as distinct", () => {
			expect(canonicalizePath("C:\\a\\b", "win32")).not.toBe(
				canonicalizePath("C:\\a\\c", "win32"),
			);
		});
	});

	describe("posix", () => {
		it("preserves case (no folding)", () => {
			expect(canonicalizePath("/Users/X/Repo", "linux")).toBe("/Users/X/Repo");
		});

		it("is byte-identical for an already-canonical absolute path", () => {
			const p = "/home/dev/project/.worktrees/feature";
			expect(canonicalizePath(p, "linux")).toBe(p);
			expect(canonicalizePath(p, "darwin")).toBe(p);
		});

		it("normalizes . and .. segments", () => {
			expect(canonicalizePath("/a/b/../c", "linux")).toBe("/a/c");
		});

		it("does not fold forward/back slashes together", () => {
			// On POSIX a backslash is a literal filename character, not a separator
			expect(canonicalizePath("/a/b", "linux")).not.toBe(
				canonicalizePath("/a\\b", "linux"),
			);
		});
	});
});
