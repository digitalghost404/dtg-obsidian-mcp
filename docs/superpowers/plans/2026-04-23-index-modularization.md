# index.js Modularization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 2272-line `index.js` into focused `lib/` modules while preserving every MCP tool's behavior and keeping `npm run test` green.

**Architecture:** Keep runtime behavior unchanged by moving shared constants/helpers into `lib/helpers.js`, moving existing `server.tool(...)` registrations into domain modules that export `register*Tools(server)`, and leaving `index.js` as a thin bootstrap that configures the server and registers modules in the same order. Preserve the current environment-variable contract, path-safety checks, tool names, schemas, descriptions, and handler logic verbatim unless import rewiring requires mechanical changes.

**Tech Stack:** Node.js ESM, @modelcontextprotocol/sdk, gray-matter, zod

---

### Task 1: Capture current structure and shared dependencies

**Files:**
- Modify: `docs/superpowers/plans/2026-04-23-index-modularization.md`
- Read: `index.js`
- Read: `test.js`

- [ ] **Step 1: Confirm tool group boundaries from the current monolith**

Read `index.js` and map existing registrations into these modules without changing tool order inside each module: `notes`, `frontmatter`, `links`, `folders`, `daily`, `templates`, `search`, `ai`, `graph`, `tasks`, `surgery`, `health`.

- [ ] **Step 2: Confirm verification target**

Read `test.js` and preserve all tested tool names and success/error text patterns. Treat the current test suite as behavior lock.

### Task 2: Extract shared helpers

**Files:**
- Create: `lib/helpers.js`
- Modify: `index.js`

- [ ] **Step 1: Move shared runtime setup into `lib/helpers.js`**

Export the vault configuration and shared helpers currently defined near the top of `index.js`: `VAULT_PATH`, `VAULT_ROOT`, `REAL_VAULT_ROOT`, `DAILY_NOTES_FOLDER`, `TEMPLATES_FOLDER`, `notePath`, `collectMarkdownFiles`, `collectFolders`, `toRelative`, `parseWikilinks`, `formatDate`, `extractTags`, `slugify`, `STOP_WORDS`, `tokenize`, `jaccardSimilarity`, `buildLinkGraph`, `bfsPath`, `QUALITY_RUBRIC`, `QUALITY_MAX`, `execFileAsync`, and any path-safety helper needed by multiple modules.

- [ ] **Step 2: Preserve startup validation behavior**

Keep `VAULT_PATH` validation and vault-root resolution logic exactly the same, just relocated into the helper module so imports fail the same way when `VAULT_PATH` is missing.

### Task 3: Extract domain registration modules

**Files:**
- Create: `lib/notes.js`
- Create: `lib/frontmatter.js`
- Create: `lib/links.js`
- Create: `lib/folders.js`
- Create: `lib/daily.js`
- Create: `lib/templates.js`
- Create: `lib/search.js`
- Create: `lib/ai.js`
- Create: `lib/graph.js`
- Create: `lib/tasks.js`
- Create: `lib/surgery.js`
- Create: `lib/health.js`

- [ ] **Step 1: Move each `server.tool(...)` block intact into its target module**

Each module must import `z` plus the exact helpers it uses from `./helpers.js`, then export a single registration function: `registerNotesTools`, `registerFrontmatterTools`, `registerLinksTools`, `registerFoldersTools`, `registerDailyTools`, `registerTemplatesTools`, `registerSearchTools`, `registerAiTools`, `registerGraphTools`, `registerTasksTools`, `registerSurgeryTools`, `registerHealthTools`.

- [ ] **Step 2: Keep mechanical behavior identical**

Do not rename tools, alter descriptions, change schemas, reorder logic inside handlers, or rewrite user-visible strings except for import-related mechanical adjustments.

### Task 4: Replace the monolith bootstrap

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Reduce `index.js` to server bootstrap only**

Keep the shebang, import `McpServer` and `StdioServerTransport`, import helper-side environment initialization indirectly via module imports, retain `server.setResourceRequestHandlers()`, `server.setPromptRequestHandlers()`, and the `ENABLED_TOOLS` wrapper behavior, then register all modules in the same overall order as the existing file.

- [ ] **Step 2: Connect stdio transport unchanged**

Preserve the final `const transport = new StdioServerTransport(); await server.connect(transport);` startup contract.

### Task 5: Verify refactor safety

**Files:**
- Read: `lib/*.js`
- Read: `index.js`

- [ ] **Step 1: Run diagnostics on the changed JS files**

Run LSP diagnostics on the project after the split and fix any import/export or syntax issues.

- [ ] **Step 2: Run the behavior lock**

Run `npm run test` from the project root.
Expected: all existing tests pass with no tool regressions.
