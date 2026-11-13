import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { openStore, getDoc } from "../src/store.js";
import { search } from "../src/search.js";
import { formatHits } from "../src/format.js";
import { activePath, chatUrl, importExport, messageText, readExport } from "../src/adapters/claude-chat.js";
import { readZip } from "../src/zip.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agent-kb-chat-"));
const ROOT = "00000000-0000-4000-8000-000000000000";

/** A zip of `{ name: text }`, deflated, as the export writes it. */
function writeZip(file, entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text);
    const body = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(8, 8);
    head.writeUInt32LE(zlib.crc32(data), 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(zlib.crc32(data), 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    locals.push(head, nameBuf, body);
    central.push(dir, nameBuf);
    offset += head.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, cd, end]));
}

const msg = (uuid, sender, text, parent, minute, extra = []) => ({
  uuid, sender, text, parent_message_uuid: parent, created_at: `2026-11-01T10:${String(minute).padStart(2, "0")}:00Z`,
  content: [{ type: "thinking", thinking: "hidden reasoning" }, { type: "text", text }, ...extra],
});

/** A chat whose first reply was regenerated after an edited prompt: the old branch must not be read. */
function conversation(over = {}) {
  return {
    uuid: crypto.randomUUID(), name: "Offsite planning", summary: "Planned a three-session offsite.",
    created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-01T11:00:00Z", project_uuid: null,
    chat_messages: [
      msg("a", "human", "plan an offsite for twelve people", ROOT, 0),
      msg("b", "assistant", "Here is a draft agenda.", "a", 1),
      msg("c", "human", "abandoned question about catering", "b", 2),
      msg("d", "assistant", "abandoned answer", "c", 3),
      msg("e", "human", "move the retro to the second day", "b", 4, [{ type: "token_budget" }]),
      msg("f", "assistant", "Moved the retro.", "e", 5),
    ],
    ...over,
  };
}

test("the active path follows the latest leaf, so edited branches and stray roots are skipped", () => {
  // Arrange
  const c = conversation();
  const stray = msg("z", "human", "a root from another branch", "missing-parent", 0);

  // Act
  const ids = activePath([...c.chat_messages, stray]).map((m) => m.uuid);
  const cyclic = activePath([msg("x", "human", "x", "y", 1), msg("y", "assistant", "y", "x", 2), msg("l", "human", "leaf", "x", 3)]);

  // Assert
  assert.deepEqual(ids, ["a", "b", "e", "f"]);
  assert.ok(cyclic.length <= 4, "a cycle ends");
});

test("message text is the text blocks only, else the text field", () => {
  // Act + Assert
  assert.equal(messageText(msg("a", "human", "hello", ROOT, 0)), "hello");
  assert.equal(messageText({ text: "plain", content: [] }), "plain");
  assert.equal(messageText({ text: "reply plus tool placeholders", content: [{ type: "text", text: "reply" }] }), "reply");
  assert.equal(messageText({ content: [{ type: "tool_use", name: "x" }] }), "");
});

test("an export imports each chat as summary + active prompts, resumable by URL; a re-import skips it", () => {
  // Arrange
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const c = conversation();
  const token = "ghp_" + crypto.randomBytes(27).toString("base64url").replace(/[-_]/g, "x").slice(0, 36);
  c.chat_messages[4].content[1].text += ` with key ${token}`;
  const exp = { conversations: [c, { uuid: crypto.randomUUID(), name: "", summary: "", chat_messages: [] }, { nope: 1 }], memories: [] };

  // Act
  const first = importExport(db, exp);
  const again = importExport(db, exp);
  const edited = importExport(db, { conversations: [{ ...c, updated_at: "2026-11-02T09:00:00Z", name: "Offsite, final" }], memories: [] });

  // Assert
  const doc = getDoc(db, chatUrl(c.uuid));
  assert.deepEqual([first.chats, first.empty, first.failed], [1, 1, 1]);
  assert.equal(again.unchanged, 2);
  assert.equal(edited.chats, 1);
  assert.equal(doc.title, "Offsite, final");
  assert.match(doc.content, /^Planned a three-session offsite\.\n\nplan an offsite for twelve people\n\nmove the retro to the second day/);
  for (const absent of ["abandoned", "Here is a draft agenda", "hidden reasoning", token]) assert.ok(!doc.content.includes(absent), absent);
  assert.match(formatHits(search(db, "retro")), new RegExp(`resume: ${chatUrl(c.uuid)}`));
});

test("memory files import as semantic docs, the conversations memory included", () => {
  // Arrange
  const db = openStore(path.join(tmp(), "kb.sqlite"));
  const mem = {
    account_uuid: "acc", conversations_memory: "Prefers terse answers.",
    memory_files: [{ path: "/memories/stack.md", content: "Uses Node 24 and SQLite.", updated_at: "2026-11-01T00:00:00Z" }, { path: "/empty.md", content: " ", updated_at: null }],
  };

  // Act
  const c = importExport(db, { conversations: [], memories: [mem] });

  // Assert
  assert.deepEqual([c.memories, c.empty], [2, 1]);
  assert.equal(getDoc(db, "claude-memory:acc//memories/stack.md").tier, "semantic");
  assert.match(getDoc(db, "claude-memory:acc/conversations memory").content, /terse/);
});

test("an export is read from its zips, a folder, or the manifest, which names the zips not yet downloaded", () => {
  // Arrange
  const dir = tmp();
  const c = conversation();
  writeZip(path.join(dir, "conversations-000.zip"), { "conversations.json": JSON.stringify([c]) });
  writeZip(path.join(dir, "memories-000.zip"), { "memories/acc.json": JSON.stringify({ account_uuid: "acc", memory_files: [] }), "users.json": "{}" });
  const manifest = path.join(dir, "member-manifest-1.json");
  fs.writeFileSync(manifest, JSON.stringify({ version: "1.0", data_files: [
    { category: "conversations", filename: "conversations-000.zip", export_url: "https://example.test/1" },
    { category: "conversations", filename: "conversations-001.zip", export_url: "https://example.test/2" },
    { category: "light_metadata", filename: "light_metadata-000.zip", export_url: "https://example.test/3" },
  ] }));
  const unzipped = tmp();
  fs.mkdirSync(path.join(unzipped, "memories"));
  fs.writeFileSync(path.join(unzipped, "conversations.json"), JSON.stringify([c]));
  fs.writeFileSync(path.join(unzipped, "memories", "acc.json"), JSON.stringify({ memory_files: [] }));

  // Act
  const fromManifest = readExport(manifest);
  const fromFolder = readExport(dir);
  const fromUnzipped = readExport(unzipped);
  const fromZip = readExport(path.join(dir, "memories-000.zip"));

  // Assert
  assert.equal(fromManifest.conversations.length, 1);
  assert.deepEqual(fromManifest.missing, [{ filename: "conversations-001.zip", url: "https://example.test/2" }]);
  assert.deepEqual([fromFolder.conversations.length, fromFolder.memories.length], [1, 1]);
  assert.deepEqual([fromUnzipped.conversations.length, fromUnzipped.memories.length], [1, 1]);
  assert.deepEqual([fromZip.conversations.length, fromZip.memories.length], [0, 1], "users.json (PII) is never read");
});

test("the zip reader rejects what it cannot read instead of guessing", () => {
  // Arrange
  const dir = tmp();
  const notZip = path.join(dir, "a.zip");
  fs.writeFileSync(notZip, "plain text");

  // Act + Assert
  assert.throws(() => readZip(notZip), /not a zip file/);
});
