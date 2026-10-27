import assert from "node:assert/strict";
import { test } from "node:test";
import { branchToItems, clip, findImage, findToolOutput, messageToItem, PHONE_BASH, toolTitle } from "../src/protocol.ts";

test("assistant messages become text, thinking and tool blocks", () => {
	const item = messageToItem(
		{
			role: "assistant",
			model: "m",
			stopReason: "toolUse",
			timestamp: 5,
			content: [
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "Running it" },
				{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls -la\necho" } },
			],
		},
		"x",
	);
	assert.deepEqual(item, {
		k: "assistant",
		id: "x",
		model: "m",
		stop: "toolUse",
		error: undefined,
		ts: 5,
		blocks: [
			{ t: "thinking", text: "hmm" },
			{ t: "text", text: "Running it" },
			{ t: "tool", id: "t1", name: "bash", title: "ls -la", args: '{\n "command": "ls -la\\necho"\n}' },
		],
	});
});

test("aborted and errored assistant messages carry the reason", () => {
	const item = messageToItem({ role: "assistant", stopReason: "error", errorMessage: "rate limited", content: [] }, "a");
	assert.equal(item?.k === "assistant" && item.error, "rate limited");
});

test("tool results keep the tail of long output and the edit diff", () => {
	const long = `${"x".repeat(10_000)}END`;
	const item = messageToItem(
		{ role: "toolResult", toolCallId: "t1", toolName: "edit", isError: false, content: [{ type: "text", text: long }], details: { diff: "+a\n-b" } },
		"ignored",
	);
	assert.ok(item?.k === "tool");
	if (item?.k !== "tool") return;
	assert.equal(item.id, "t1");
	assert.equal(item.truncated, true);
	assert.ok(item.output.endsWith("END"));
	assert.equal(item.diff, "+a\n-b");
});

test("user images are counted, hidden custom messages dropped, summaries kept", () => {
	const u = messageToItem({ role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "", mimeType: "image/png" }] }, "u");
	assert.equal(u?.k === "user" && u.images, 1);
	assert.equal(messageToItem({ role: "custom", display: false, content: "x" }, "c"), undefined);
	assert.equal(messageToItem({ role: "system", content: "x" }, "s"), undefined);
	const items = branchToItems([
		{ type: "message", id: "1", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "hi" } },
		{ type: "model_change", id: "2", timestamp: "2026-01-01T00:00:00Z" },
		{ type: "compaction", id: "3", timestamp: "2026-01-01T00:00:00Z", summary: "sum" },
		{ type: "custom_message", id: "4", timestamp: "2026-01-01T00:00:00Z", display: true, customType: "goal", content: "status" },
		{ type: "custom_message", id: "5", timestamp: "2026-01-01T00:00:00Z", display: false, customType: "h", content: "x" },
	]);
	assert.deepEqual(
		items.map((i) => [i.k, i.id]),
		[
			["user", "1"],
			["summary", "3"],
			["custom", "4"],
		],
	);
});

test("a phone's !command shows as a bash item, live and from the session file", () => {
	const details = { command: "git status", output: "clean", exitCode: 0, excluded: true };
	const live = messageToItem({ role: "custom", customType: PHONE_BASH, display: true, content: "Ran `git status`", details, timestamp: 7 }, "m1");
	assert.deepEqual(live, { k: "bash", id: "m1", command: "git status", output: "clean", exitCode: 0, excluded: true, ts: 7 });
	const [saved] = branchToItems([
		{ type: "custom_message", id: "e9", timestamp: "2026-01-01T00:00:00Z", display: true, customType: PHONE_BASH, content: "Ran", details },
	]);
	assert.deepEqual(saved, { ...live, id: "e9", ts: Date.parse("2026-01-01T00:00:00Z") });
	// Without its details it is just another custom message.
	assert.equal(messageToItem({ role: "custom", customType: PHONE_BASH, display: true, content: "x" }, "m2")?.k, "custom");
});

test("findImage finds user images by entry id or timestamp and tool images by call id", () => {
	const png = { type: "image", data: "UE5H", mimeType: "image/png" };
	const entries = [
		{ type: "message", id: "e1", message: { role: "user", timestamp: 42, content: [{ type: "text", text: "look" }, png, { ...png, data: "Mg==" }] } },
		{ type: "message", id: "e2", message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "Read image" }, png] } },
	];
	assert.deepEqual(findImage(entries, "e1", 1), { data: "Mg==", mimeType: "image/png" });
	assert.deepEqual(findImage(entries, "m-live", 0, 42), { data: "UE5H", mimeType: "image/png" });
	assert.deepEqual(findImage(entries, "t1", 0), { data: "UE5H", mimeType: "image/png" });
	assert.equal(findImage(entries, "e1", 2), undefined);
	assert.equal(findImage(entries, "m-live", 0, 7), undefined);
	const tool = messageToItem({ role: "toolResult", toolCallId: "t1", toolName: "read", content: entries[1].message.content }, "x");
	assert.equal(tool?.k === "tool" && tool.images, 1);
});

test("findToolOutput returns the latest result for a call id", () => {
	const entries = [{ type: "message", message: { role: "toolResult", toolCallId: "a", content: [{ type: "text", text: "full output" }] } }];
	assert.equal(findToolOutput(entries, "a"), "full output");
	assert.equal(findToolOutput(entries, "b"), undefined);
});

test("toolTitle and clip", () => {
	assert.equal(toolTitle("read", { path: "/a/b.ts" }), "/a/b.ts");
	assert.equal(toolTitle("custom", { x: 1 }), "");
	assert.equal(toolTitle("edit", { edits: [{ path: "a.ts" }, { path: "b.ts" }, { path: "a.ts" }] }), "a.ts, b.ts");
	assert.deepEqual(clip("abc", 5), { text: "abc", truncated: false });
	assert.deepEqual(clip("abcdef", 2), { text: "…\nef", truncated: true });
});
