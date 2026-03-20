#!/usr/bin/env node
/**
 * Synapse MCP — Full test suite
 * Spawns the server, seeds test data, tests all 56 tools, cleans up, reports results.
 */

import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.VAULT_PATH) {
  console.error("VAULT_PATH environment variable is required.");
  process.exit(1);
}
const VAULT_PATH = process.env.VAULT_PATH;
const TEST_DIR = path.join(VAULT_PATH, "__synapse_test__");

// ─── Colours ──────────────────────────────────────────────────────────────────
const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const B = (s) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;

// ─── Seed data ────────────────────────────────────────────────────────────────
const SEED_NOTES = {
  "__synapse_test__/Note A.md": `---
title: Note A
date: 2025-01-15
status: active
tags: [science, research]
---
# Note A

Note A is a comprehensive introduction to the scientific method.

The **scientific method** refers to a systematic approach to inquiry.

> Knowledge is power. — Francis Bacon

- [ ] Review literature
- [ ] Write hypothesis
- [x] Collect data

See also [[Note B]] and [[Note C]].
`,
  "__synapse_test__/Note B.md": `---
title: Note B
date: 2025-02-10
status: active
tags: [science, experiment]
---
# Note B

Note B covers experimental design in detail.

**Control group** — A group that does not receive the experimental treatment.

The scientific method is a process. It is used by researchers. It always produces reliable results when applied correctly.

- [ ] Design experiment
- [x] Run pilot study

See also [[Note A]].
`,
  "__synapse_test__/Note C.md": `---
title: Note C
date: 2025-03-01
status: done
tags: [research, writing]
summary: An overview of scientific writing conventions.
---
# Note C

Note C explains how to write scientific papers.

**Abstract** — A short summary of a research paper.

Q: What is peer review?
A: A process where experts evaluate scientific work before publication.

> Writing is thinking made visible.

See also [[Note A]].
`,
  "__synapse_test__/Note D.md": `---
title: Note D
date: 2025-03-20
status: active
tags: [research]
---
# Note D

Note D is about data analysis techniques used in research.

The scientific method and experimental design are closely related concepts.
`,
  "__synapse_test__/Templates/Daily.md": `---
date: {{date}}
title: {{title}}
---
# {{title}}

## Tasks
- [ ]

## Notes

`,
  "__synapse_test__/Daily Notes/2025-03-01.md": `---
date: 2025-03-01
---
# 2025-03-01

- [x] Morning review
- [ ] Write notes
`,
};

// ─── MCP client ───────────────────────────────────────────────────────────────
class MCPClient {
  constructor() {
    this.proc = null;
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.proc = spawn("node", [path.join(__dirname, "index.js")], {
        env: { ...process.env, VAULT_PATH, DAILY_NOTES_FOLDER: "__synapse_test__/Daily Notes", TEMPLATES_FOLDER: "__synapse_test__/Templates" },
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.proc.stdout.on("data", (chunk) => {
        this.buffer += chunk.toString();
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            const resolve = this.pending.get(msg.id);
            if (resolve) { this.pending.delete(msg.id); resolve(msg); }
          } catch { /* ignore non-JSON */ }
        }
      });

      this.proc.stderr.on("data", () => {}); // suppress server logs

      this.call("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "synapse-test", version: "1" },
      }).then(resolve).catch(reject);
    });
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, resolve);
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.proc.stdin.write(msg);
      setTimeout(() => { this.pending.delete(id); reject(new Error("timeout")); }, 10000);
    });
  }

  tool(name, args = {}) {
    return this.call("tools/call", { name, arguments: args });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.proc) return resolve();
      this.proc.on("close", resolve);
      this.proc.kill();
    });
  }
}

// ─── Seed / cleanup ───────────────────────────────────────────────────────────
async function seed() {
  for (const [rel, content] of Object.entries(SEED_NOTES)) {
    const full = path.join(VAULT_PATH, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf-8");
  }
}

async function cleanup() {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
}

// ─── Test runner ──────────────────────────────────────────────────────────────
const results = [];

async function test(name, fn, { contains, expectError } = {}) {
  try {
    const res = await fn();
    const isErr = res?.error || res?.result?.isError;
    const errMsg = res?.error?.message ?? res?.result?.content?.[0]?.text ?? "";
    if (isErr) {
      if (expectError) {
        results.push({ name, pass: true, text: `(expected error: ${errMsg.slice(0, 80)})` });
        return;
      }
      throw new Error(errMsg);
    }
    if (expectError) {
      results.push({ name, pass: false, error: "Expected error but got success" });
      return;
    }
    const text = res?.result?.content?.[0]?.text ?? "";
    if (contains && !text.includes(contains)) {
      results.push({ name, pass: false, error: `Expected "${contains}" in response, got: ${text.slice(0, 100)}` });
      return;
    }
    results.push({ name, pass: true, text: text.slice(0, 120) });
  } catch (e) {
    if (expectError) {
      results.push({ name, pass: true, text: `(expected error: ${e.message.slice(0, 80)})` });
      return;
    }
    results.push({ name, pass: false, error: e.message });
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
console.log(B("\n⚡ Synapse MCP — Full Test Suite\n"));

await seed();
const client = new MCPClient();
await client.start();

const T = "__synapse_test__";

// ── Note Management ──────────────────────────────────────────────────────────
console.log(B("Note Management"));
await test("list_notes",      () => client.tool("list_notes"), { contains: "Note A.md" });
await test("list_notes (folder)", () => client.tool("list_notes", { folder: T }), { contains: "Note A.md" });
await test("read_note",       () => client.tool("read_note",  { path: `${T}/Note A.md` }), { contains: "scientific method" });
await test("write_note",      () => client.tool("write_note", { path: `${T}/Write Test.md`, content: "# Write Test\nHello." }), { contains: "Note written" });
await test("append_to_note",  () => client.tool("append_to_note", { path: `${T}/Write Test.md`, content: "\nAppended line." }), { contains: "Appended to" });
await test("patch_note",      () => client.tool("patch_note",  { path: `${T}/Write Test.md`, search: "Hello.", replace: "Hello, world." }), { contains: "Patched" });
await test("rename_note",     () => client.tool("rename_note", { from: `${T}/Write Test.md`, to: `${T}/Renamed Test.md` }), { contains: "Moved" });
await test("delete_note",     () => client.tool("delete_note", { path: `${T}/Renamed Test.md` }), { contains: "Deleted" });

// ── Frontmatter & Metadata ───────────────────────────────────────────────────
console.log(B("\nFrontmatter & Metadata"));
await test("get_frontmatter", () => client.tool("get_frontmatter", { path: `${T}/Note A.md` }), { contains: "2025-01-15" });
await test("set_frontmatter", () => client.tool("set_frontmatter", { path: `${T}/Note A.md`, fields: { reviewed: true } }), { contains: "Frontmatter updated" });
await test("list_tags",       () => client.tool("list_tags"), { contains: "science" });

// ── Links & Graph ────────────────────────────────────────────────────────────
console.log(B("\nLinks & Graph"));
await test("get_outgoing_links", () => client.tool("get_outgoing_links", { path: `${T}/Note A.md` }), { contains: "Note B" });
await test("get_backlinks",      () => client.tool("get_backlinks",      { path: `${T}/Note A.md` }), { contains: "Note B.md" });
await test("get_orphans",        () => client.tool("get_orphans"));

// ── Folders ──────────────────────────────────────────────────────────────────
console.log(B("\nFolders"));
await test("list_folders",   () => client.tool("list_folders"));
await test("create_folder",  () => client.tool("create_folder",  { path: `${T}/New Folder` }));
await test("delete_folder (dry_run)", () => client.tool("delete_folder", { path: `${T}/New Folder`, dry_run: true }), { contains: "Dry run" });
await test("delete_folder",  () => client.tool("delete_folder",  { path: `${T}/New Folder` }));
// Create folder with content for force delete test
await client.tool("create_folder", { path: `${T}/Force Del` });
await client.tool("write_note", { path: `${T}/Force Del/temp.md`, content: "temp" });
await test("delete_folder (force)", () => client.tool("delete_folder", { path: `${T}/Force Del`, force: true }), { contains: "Folder deleted" });

// ── Daily Notes & Templates ──────────────────────────────────────────────────
console.log(B("\nDaily Notes & Templates"));
await test("get_daily_note",        () => client.tool("get_daily_note",  { date: "2025-03-01" }));
await test("create_daily_note",     () => client.tool("create_daily_note", { date: "2025-06-01" }));
await test("list_templates",        () => client.tool("list_templates"));
await test("create_from_template",  () => client.tool("create_from_template", {
  template: `${T}/Templates/Daily.md`,
  destination: `${T}/From Template.md`,
  title: "Test Note",
}));

// ── Search & Query ───────────────────────────────────────────────────────────
console.log(B("\nSearch & Query"));
await test("search_notes",          () => client.tool("search_notes",          { query: "scientific" }), { contains: "Note A.md" });
await test("search_by_tag",         () => client.tool("search_by_tag",         { tags: ["science"] }), { contains: "science" });
await test("search_by_frontmatter", () => client.tool("search_by_frontmatter", { criteria: { status: "active" } }), { contains: "Note A.md" });
await test("query_notes",           () => client.tool("query_notes", {
  where: [{ field: "status", operator: "eq", value: "active" }],
  sort_by: "date",
}), { contains: "Note A.md" });
await test("get_timeline",          () => client.tool("get_timeline", { date_field: "date", folder: T }));

// ── Writing & Workflow ───────────────────────────────────────────────────────
console.log(B("\nWriting & Workflow"));
await test("extract_tasks",  () => client.tool("extract_tasks",  { path: `${T}/Note A.md` }), { contains: "Write hypothesis" });
await test("complete_task",  () => client.tool("complete_task",  { path: `${T}/Note A.md`, task_text: "Review literature" }), { contains: "Task completed" });
await test("merge_notes",    () => client.tool("merge_notes",    { sources: [`${T}/Note A.md`, `${T}/Note B.md`], destination: `${T}/Merged.md` }));
await test("split_note",     () => client.tool("split_note",     { path: `${T}/Note C.md`, heading_level: 2, destination_folder: `${T}/Split` }));

// ── Vault Intelligence ───────────────────────────────────────────────────────
console.log(B("\nVault Intelligence"));
await test("get_graph_stats",      () => client.tool("get_graph_stats"));
await test("get_hub_notes",        () => client.tool("get_hub_notes", { limit: 5 }));
await test("trace_path",           () => client.tool("trace_path", { from: `${T}/Note B.md`, to: `${T}/Note C.md` }));
await test("get_recently_modified",() => client.tool("get_recently_modified", { days: 1 }), { contains: "Note A.md" });

// ── Vault Health ─────────────────────────────────────────────────────────────
console.log(B("\nVault Health"));
await test("find_broken_links", () => client.tool("find_broken_links"));
await test("find_empty_notes",  () => client.tool("find_empty_notes"));
await test("vault_report",      () => client.tool("vault_report"));

// ── Connective Intelligence ───────────────────────────────────────────────────
console.log(B("\nConnective Intelligence"));
await test("summarize_note",        () => client.tool("summarize_note",       { path: `${T}/Note A.md` }));
await test("suggest_links",         () => client.tool("suggest_links",        { path: `${T}/Note D.md` }));
await test("generate_moc",          () => client.tool("generate_moc",         { folder: T }), { contains: "Map of Contents" });
await test("find_duplicates",       () => client.tool("find_duplicates",       { threshold: 0.1, folder: T }));
await test("find_knowledge_gaps",   () => client.tool("find_knowledge_gaps",   { path: `${T}/Note A.md` }));
await test("extract_concepts",      () => client.tool("extract_concepts",      { path: `${T}/Note A.md` }));
await test("generate_summary_note", () => client.tool("generate_summary_note", {
  sources: [`${T}/Note A.md`, `${T}/Note B.md`],
  title: "Science Overview",
}), { contains: "Science Overview" });
await test("suggest_note_structure",() => client.tool("suggest_note_structure",{ path: `${T}/Note D.md` }));
await test("cluster_notes",         () => client.tool("cluster_notes",         { threshold: 0.05, folder: T }), { contains: "Cluster" });
await test("find_related_notes",    () => client.tool("find_related_notes",    { path: `${T}/Note A.md` }));
await test("compare_notes",         () => client.tool("compare_notes",         { path_a: `${T}/Note A.md`, path_b: `${T}/Note B.md` }));
await test("get_note_evolution",    () => client.tool("get_note_evolution",    { path: `${T}/Note A.md` }), { contains: "Note A.md" });
await test("extract_quotes",        () => client.tool("extract_quotes",        { path: `${T}/Note A.md` }), { contains: "Francis Bacon" });
await test("find_unsourced_claims", () => client.tool("find_unsourced_claims", { path: `${T}/Note B.md` }), { contains: "scientific method" });
await test("generate_flashcards",   () => client.tool("generate_flashcards",   { path: `${T}/Note C.md` }));
await test("extract_definitions",   () => client.tool("extract_definitions",   { path: `${T}/Note B.md` }));
await test("get_review_queue",      () => client.tool("get_review_queue",      { days: 1 }), { contains: "No notes overdue" });
await test("generate_weekly_review",() => client.tool("generate_weekly_review",{ days: 7 }), { contains: "Weekly Review" });
await test("score_note_quality",    () => client.tool("score_note_quality",    { path: `${T}/Note A.md` }), { contains: "Quality Score" });
await test("suggest_tags",          () => client.tool("suggest_tags",          { path: `${T}/Note D.md` }));

// ── Error / Edge Case Tests ──────────────────────────────────────────────────
console.log(B("\nError & Edge Cases"));
await test("path traversal blocked",  () => client.tool("read_note", { path: "../../etc/passwd" }), { expectError: true });
await test("read non-existent note",  () => client.tool("read_note", { path: `${T}/does-not-exist.md` }), { expectError: true });
await test("delete non-existent note",() => client.tool("delete_note", { path: `${T}/nope.md` }), { expectError: true });
await test("patch search not found",  () => client.tool("patch_note", { path: `${T}/Note A.md`, search: "XYZNONEXISTENT", replace: "foo" }), { expectError: true });
await test("patch empty search",      () => client.tool("patch_note", { path: `${T}/Note A.md`, search: "", replace: "foo" }), { expectError: true });
await test("complete non-existent task", () => client.tool("complete_task", { path: `${T}/Note A.md`, task_text: "This task does not exist" }), { expectError: true });
await test("invalid daily note date", () => client.tool("get_daily_note", { date: "not-a-date" }), { expectError: true });
await test("list non-existent folder", () => client.tool("list_notes", { folder: `${T}/nonexistent-folder` }), { expectError: true });
await test("rename to existing dest", () => client.tool("rename_note", { from: `${T}/Note B.md`, to: `${T}/Note C.md` }), { expectError: true });
await test("create_from_template over existing", () => client.tool("create_from_template", {
  template: `${T}/Templates/Daily.md`,
  destination: `${T}/Note D.md`,
  title: "Overwrite",
}), { expectError: true });

// ─── Cleanup & Report ────────────────────────────────────────────────────────
await client.stop();
await cleanup();

const passed = results.filter((r) => r.pass);
const failed = results.filter((r) => !r.pass);

console.log(B("\n─────────────────────────────────────────"));
console.log(B("Results\n"));

for (const r of results) {
  if (r.pass) {
    console.log(`${G("✓")} ${r.name.padEnd(30)} ${DIM(r.text.replace(/\n/g, " ").slice(0, 80))}`);
  } else {
    console.log(`${R("✗")} ${r.name.padEnd(30)} ${Y(r.error)}`);
  }
}

console.log(B("\n─────────────────────────────────────────"));
console.log(`${G(`✓ ${passed.length} passed`)}  ${failed.length ? R(`✗ ${failed.length} failed`) : ""}  / ${results.length} total\n`);

if (failed.length) process.exit(1);
