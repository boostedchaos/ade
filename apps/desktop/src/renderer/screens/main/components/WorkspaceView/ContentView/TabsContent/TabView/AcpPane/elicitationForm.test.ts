/**
 * Smoke coverage for the question card's form handling (B2). An independent
 * author follows.
 *
 * The fixture is `AskUserQuestion`'s own shape — a `question_0` select and the
 * `question_0_custom` free-text box beside it — because that is the tool the
 * whole elicitation capability exists to re-enable.
 */

import { describe, expect, it } from "bun:test";
import {
	buildElicitationContent,
	canSubmitElicitation,
	describeElicitationAnswer,
	groupElicitationFields,
} from "./elicitationForm";
import type { AcpElicitationForm } from "./transcript";

const askUserQuestion: AcpElicitationForm = {
	title: "Pick an approach",
	fields: [
		{
			key: "question_0",
			kind: "select",
			title: "Which approach?",
			required: true,
			options: [
				{ value: "a", label: "Rewrite it" },
				{ value: "b", label: "Patch it" },
			],
		},
		{
			key: "question_0_custom",
			kind: "text",
			title: "Other",
			required: false,
		},
	],
};

describe("groupElicitationFields", () => {
	it("pairs a question with its _custom box as ONE question", () => {
		const groups = groupElicitationFields(askUserQuestion);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.field.key).toBe("question_0");
		expect(groups[0]?.customField?.key).toBe("question_0_custom");
	});

	it("keeps a _custom field that owns no question as its own group", () => {
		const groups = groupElicitationFields({
			fields: [{ key: "notes_custom", kind: "text", required: false }],
		});
		expect(groups.map((group) => group.field.key)).toEqual(["notes_custom"]);
	});

	it("keeps a multiselect and its options", () => {
		const groups = groupElicitationFields({
			fields: [
				{
					key: "question_0",
					kind: "multiselect",
					required: true,
					options: [
						{ value: "x", label: "X" },
						{ value: "y", label: "Y" },
					],
				},
			],
		});
		expect(groups[0]?.field.kind).toBe("multiselect");
		expect(groups[0]?.field.options).toHaveLength(2);
	});
});

describe("canSubmitElicitation", () => {
	const groups = groupElicitationFields(askUserQuestion);

	it("is false with the required question unanswered", () => {
		expect(canSubmitElicitation(groups, {})).toBe(false);
	});

	it("is true on a picked option", () => {
		expect(canSubmitElicitation(groups, { question_0: "a" })).toBe(true);
	});

	it("is true on the custom box ALONE — it is the alternative, not an extra", () => {
		expect(
			canSubmitElicitation(groups, { question_0_custom: "something else" }),
		).toBe(true);
	});

	it("does not count whitespace as an answer", () => {
		expect(canSubmitElicitation(groups, { question_0_custom: "   " })).toBe(
			false,
		);
	});
});

describe("buildElicitationContent", () => {
	const groups = groupElicitationFields(askUserQuestion);

	it("keys the answer by the schema's OWN property names", () => {
		expect(buildElicitationContent(groups, { question_0: "a" })).toEqual({
			question_0: "a",
		});
	});

	it("omits an untouched field rather than sending an empty string", () => {
		// `""` would read to the agent as an answer of nothing, not as no answer.
		const content = buildElicitationContent(groups, {
			question_0: "a",
			question_0_custom: "",
		});
		expect(Object.keys(content)).toEqual(["question_0"]);
	});

	it("carries a multiselect through as an array", () => {
		const multi = groupElicitationFields({
			fields: [
				{
					key: "question_0",
					kind: "multiselect",
					required: true,
					options: [
						{ value: "x", label: "X" },
						{ value: "y", label: "Y" },
					],
				},
			],
		});
		expect(buildElicitationContent(multi, { question_0: ["x", "y"] })).toEqual({
			question_0: ["x", "y"],
		});
	});
});

describe("describeElicitationAnswer", () => {
	const groups = groupElicitationFields(askUserQuestion);

	it("shows the LABEL the user clicked, not the wire value", () => {
		expect(describeElicitationAnswer(groups, { question_0: "a" })).toBe(
			"Rewrite it",
		);
	});

	it("shows typed text when that is what was given", () => {
		expect(
			describeElicitationAnswer(groups, { question_0_custom: "neither" }),
		).toBe("neither");
	});

	it("is empty when nothing was answered", () => {
		expect(describeElicitationAnswer(groups, {})).toBe("");
	});
});
