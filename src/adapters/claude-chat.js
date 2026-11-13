import fs from "node:fs";
import path from "node:path";
import { getDoc, upsertDoc } from "../store.js";
import { redact } from "../redact.js";
import { clip } from "../text.js";
import { readZip } from "../zip.js";

export const CHAT = "claude-chat";
export const MEMORY = "claude-memory";
const MAX_CHARS = 32_000;
export const chatUrl = (uuid) => `https://claude.ai/chat/${uuid}`;

const isConversations = (n) => path.basename(n) === "conversations.json";
const isMemory = (n) => /(^|\/)memories\/[^/]+\.json$/.test(n);

/**
 * The JSON files of a Claude data export, from a `conversations-NNN.zip` / `memories-NNN.zip`, a
 * folder holding them (else their unzipped `conversations.json` and `memories/`; top level only), a
 * `conversations.json`, or the `member-manifest-*.json` (its zips are looked up beside it).
 * Returns { conversations, memories, missing, unreadable }: a file that does not parse is named in
 * `unreadable` and the rest still import.
 */
export function readExport(input) {
  const out = { conversations: [], memories: [], missing: [], unreadable: [] };
  const add = (label, name, text) => {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      out.unreadable.push(label);
      return;
    }
    if (!isConversations(name)) out.memories.push(data);
    else if (Array.isArray(data)) out.conversations.push(...data);
    else out.unreadable.push(label);
  };
  const fromZip = (file) => {
    let entries;
    try {
      entries = readZip(file, (n) => isConversations(n) || isMemory(n));
    } catch (e) {
      out.unreadable.push(`${file}: ${e.message}`);
      return;
    }
    for (const e of entries) add(`${file}: ${e.name}`, e.name, e.data.toString("utf8"));
  };
  const st = fs.statSync(input);
  if (st.isDirectory()) {
    // per category: its zips, else its unzipped JSON (a copy beside a zip is never read twice)
    const names = fs.readdirSync(input).sort();
    const zips = (cat) => names.filter((n) => new RegExp(`^${cat}-\\d+\\.zip$`).test(n)).map((n) => path.join(input, n));
    const conversationZips = zips("conversations");
    const memoryZips = zips("memories");
    [...conversationZips, ...memoryZips].forEach(fromZip);
    const loose = (file, name) => {
      let text;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch (e) {
        out.unreadable.push(`${file}: ${e.code ?? e.message}`);
        return;
      }
      add(file, name, text);
    };
    const conv = path.join(input, "conversations.json");
    if (!conversationZips.length && fs.existsSync(conv)) loose(conv, "conversations.json");
    const mem = path.join(input, "memories");
    let memNames = [];
    try {
      memNames = !memoryZips.length && fs.existsSync(mem) ? fs.readdirSync(mem).filter((n) => n.endsWith(".json")).sort() : [];
    } catch (e) {
      out.unreadable.push(`${mem}: ${e.code ?? e.message}`);
    }
    for (const n of memNames) loose(path.join(mem, n), `memories/${n}`);
  } else if (input.endsWith(".zip")) fromZip(input);
  else {
    const data = JSON.parse(fs.readFileSync(input, "utf8"));
    if (Array.isArray(data?.data_files)) {
      // the manifest: each zip must be downloaded in the signed-in browser first
      for (const f of data.data_files) {
        if (!/^(conversations|memories)$/.test(f?.category) || typeof f.filename !== "string") continue;
        const zip = path.join(path.dirname(input), path.basename(f.filename));
        if (fs.existsSync(zip)) fromZip(zip);
        else out.missing.push({ filename: f.filename, url: f.export_url });
      }
    } else if (Array.isArray(data)) out.conversations.push(...data);
    else out.memories.push(data);
  }
  return out;
}

/**
 * The conversation as shown: edits and regenerations make a tree through `parent_message_uuid`,
 * so walk up from the latest leaf instead of reading the flat list.
 */
export function activePath(messages) {
  const byId = new Map(messages.filter((m) => m?.uuid).map((m) => [m.uuid, m]));
  const parents = new Set(messages.map((m) => m?.parent_message_uuid));
  const ts = (m) => Date.parse(m.created_at) || 0;
  let leaf = null;
  for (const m of byId.values()) if (!parents.has(m.uuid) && (!leaf || ts(m) >= ts(leaf))) leaf = m;
  const path = [];
  for (let m = leaf; m && path.length <= byId.size; m = byId.get(m.parent_message_uuid)) path.push(m);
  return path.reverse();
}

/** Text the person typed or read: text blocks only (no thinking, tool calls or token budgets). */
export function messageText(m) {
  const blocks = Array.isArray(m?.content) ? m.content.filter((b) => b?.type === "text" && typeof b.text === "string") : [];
  return (blocks.length ? blocks.map((b) => b.text).join("\n") : typeof m?.text === "string" ? m.text : "").trim();
}

/**
 * Tier 0 for chats: each conversation becomes a doc of its own summary (written by claude.ai) and
 * the user's prompts on the active path, resumable by its URL. Memory files become `semantic` docs.
 * A re-import skips a chat with the same `updated_at` and message count, and a memory with the same
 * text; one that is empty now is removed. No model call.
 */
export function importExport(db, exp) {
  const getScan = db.prepare("SELECT size, mtime_ms FROM scans WHERE source_path = ?");
  const setScan = db.prepare(
    `INSERT INTO scans (source_path, size, mtime_ms) VALUES (?, ?, ?)
     ON CONFLICT(source_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms`,
  );
  const counts = { chats: 0, memories: 0, unchanged: 0, empty: 0, removed: 0, failed: 0 };
  const del = db.prepare("DELETE FROM documents WHERE source_path = ?");
  // a chat or memory that is empty now: its old text must not stay searchable
  const emptied = (key) => {
    if (del.run(key).changes) counts.removed++;
    else counts.empty++;
  };
  const changed = (key, size, updated) => {
    const cur = getScan.get(key);
    return !(cur && cur.size === size && cur.mtime_ms === updated);
  };
  for (const c of exp.conversations) {
    try {
      if (typeof c?.uuid !== "string" || !Array.isArray(c.chat_messages)) throw new Error("not a conversation");
      const key = chatUrl(c.uuid);
      const updated = Date.parse(c.updated_at) || 0;
      if (!changed(key, c.chat_messages.length, updated)) {
        counts.unchanged++;
        continue;
      }
      const prompts = activePath(c.chat_messages).filter((m) => m.sender === "human").map(messageText).filter(Boolean);
      const summary = typeof c.summary === "string" ? c.summary.trim() : "";
      if (!prompts.length && !summary) emptied(key);
      else {
        const title = (typeof c.name === "string" && c.name.trim()) || prompts[0]?.replace(/\s+/g, " ").slice(0, 80) || "Untitled chat";
        upsertDoc(db, {
          source_path: key,
          source_type: CHAT,
          tier: "episodic",
          title,
          content: clip(redact([summary, ...prompts].filter(Boolean).join("\n\n")).text, MAX_CHARS),
          event_ts: updated || Date.parse(c.created_at) || Date.now(),
          resume_cmd: key,
        });
        counts.chats++;
      }
      setScan.run(key, c.chat_messages.length, updated);
    } catch {
      counts.failed++;
    }
  }
  for (const m of exp.memories) {
    const account = typeof m?.account_uuid === "string" ? m.account_uuid : "account";
    const files = Array.isArray(m?.memory_files) ? [...m.memory_files] : [];
    if (typeof m?.conversations_memory === "string") {
      files.push({ path: "conversations memory", content: m.conversations_memory, updated_at: null });
    }
    for (const f of files) {
      try {
        if (typeof f?.path !== "string" || typeof f.content !== "string") throw new Error("not a memory file");
        const key = `claude-memory:${account}/${f.path}`;
        const updated = Date.parse(f.updated_at) || 0;
        if (!f.content.trim()) {
          emptied(key);
          continue;
        }
        // compared by content: the conversations memory and some files carry no timestamp
        const content = clip(redact(f.content).text, MAX_CHARS);
        const title = `Claude memory: ${f.path}`;
        const cur = getDoc(db, key);
        if (cur && cur.content === redact(content).text && cur.title === redact(title).text) {
          counts.unchanged++;
          continue;
        }
        upsertDoc(db, { source_path: key, source_type: MEMORY, tier: "semantic", title, content, event_ts: updated || Date.now(), resume_cmd: null });
        counts.memories++;
      } catch {
        counts.failed++;
      }
    }
  }
  return counts;
}
