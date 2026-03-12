import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";
import fs from "fs/promises";
import path from "path";
import matter from "gray-matter";

// ─── Vault path ───────────────────────────────────────────────────────────────
const VAULT_PATH = process.env.VAULT_PATH ?? "/home/xcoleman/obsidian-vault/dtg404-vault";
const DAILY_NOTES_FOLDER = process.env.DAILY_NOTES_FOLDER ?? "Daily Notes";
const TEMPLATES_FOLDER = process.env.TEMPLATES_FOLDER ?? "Templates";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve a note path safely within the vault (prevents path traversal). */
function notePath(relativePath) {
  const resolved = path.resolve(VAULT_PATH, relativePath);
  if (!resolved.startsWith(path.resolve(VAULT_PATH))) {
    throw new Error("Path is outside the vault");
  }
  return resolved;
}

/** Recursively collect all .md files under a directory. */
async function collectMarkdownFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      files.push(...(await collectMarkdownFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

/** Recursively collect all subdirectories under a directory. */
async function collectFolders(dir, baseDir = dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const folders = [];
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      const fullPath = path.join(dir, entry.name);
      folders.push(path.relative(baseDir, fullPath));
      folders.push(...(await collectFolders(fullPath, baseDir)));
    }
  }
  return folders;
}

/** Convert an absolute vault file path to a vault-relative path. */
function toRelative(absolutePath) {
  return path.relative(VAULT_PATH, absolutePath);
}

/** Extract [[wikilinks]] from content. */
function parseWikilinks(content) {
  const matches = [...content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)];
  return [...new Set(matches.map((m) => m[1].trim()))];
}

/** Format today or a given date as YYYY-MM-DD. */
function formatDate(date = new Date()) {
  return date.toISOString().split("T")[0];
}

/** Parse tags from frontmatter and inline #tags in content. */
function extractTags(parsedMatter) {
  const tags = new Set();
  // Frontmatter tags (array or space-separated string)
  const fmTags = parsedMatter.data.tags;
  if (Array.isArray(fmTags)) fmTags.forEach((t) => tags.add(String(t).toLowerCase()));
  else if (typeof fmTags === "string") fmTags.split(/[\s,]+/).filter(Boolean).forEach((t) => tags.add(t.toLowerCase()));

  // Inline #tags in body
  const inlineMatches = [...parsedMatter.content.matchAll(/#([\w/-]+)/g)];
  inlineMatches.forEach((m) => tags.add(m[1].toLowerCase()));

  return [...tags];
}

// ─── Server setup ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "obsidian-vault",
  version: "2.0.0",
});

// ══════════════════════════════════════════════════════════════════════════════
// NOTE MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  "list_notes",
  "List all notes in the Obsidian vault. Optionally filter by folder.",
  {
    folder: z.string().optional().describe("Subfolder to list (e.g. 'Projects'). Omit for all notes."),
  },
  async ({ folder }) => {
    const searchRoot = folder ? notePath(folder) : VAULT_PATH;
    const files = await collectMarkdownFiles(searchRoot);
    const relative = files.map(toRelative);
    return {
      content: [{ type: "text", text: relative.join("\n") || "No notes found." }],
    };
  }
);

server.tool(
  "read_note",
  "Read the full content of a note by its vault-relative path (e.g. 'Projects/My Note.md').",
  {
    path: z.string().describe("Vault-relative path to the note."),
  },
  async ({ path: noteName }) => {
    const fullPath = notePath(noteName);
    const content = await fs.readFile(fullPath, "utf-8");
    return {
      content: [{ type: "text", text: content }],
    };
  }
);

server.tool(
  "write_note",
  "Create or overwrite a note. Parent folders are created automatically.",
  {
    path: z.string().describe("Vault-relative path for the note (e.g. 'Projects/New Note.md')."),
    content: z.string().describe("Full markdown content to write."),
  },
  async ({ path: noteName, content }) => {
    const fullPath = notePath(noteName);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
    return {
      content: [{ type: "text", text: `Note written: ${noteName}` }],
    };
  }
);

server.tool(
  "delete_note",
  "Delete a note by its vault-relative path. This is irreversible.",
  {
    path: z.string().describe("Vault-relative path to the note to delete."),
  },
  async ({ path: noteName }) => {
    const fullPath = notePath(noteName);
    await fs.unlink(fullPath);
    return {
      content: [{ type: "text", text: `Deleted: ${noteName}` }],
    };
  }
);

server.tool(
  "rename_note",
  "Rename or move a note to a new vault-relative path. Parent folders are created automatically.",
  {
    from: z.string().describe("Current vault-relative path of the note."),
    to: z.string().describe("New vault-relative path for the note."),
  },
  async ({ from, to }) => {
    const fromPath = notePath(from);
    const toPath = notePath(to);
    await fs.mkdir(path.dirname(toPath), { recursive: true });
    await fs.rename(fromPath, toPath);
    return {
      content: [{ type: "text", text: `Moved: ${from} → ${to}` }],
    };
  }
);

server.tool(
  "append_to_note",
  "Append content to the end of an existing note without overwriting it.",
  {
    path: z.string().describe("Vault-relative path to the note."),
    content: z.string().describe("Markdown content to append."),
  },
  async ({ path: noteName, content }) => {
    const fullPath = notePath(noteName);
    const existing = await fs.readFile(fullPath, "utf-8");
    const separator = existing.endsWith("\n") ? "" : "\n";
    await fs.writeFile(fullPath, existing + separator + content, "utf-8");
    return {
      content: [{ type: "text", text: `Appended to: ${noteName}` }],
    };
  }
);

server.tool(
  "patch_note",
  "Replace the first occurrence of a search string within a note with a replacement string.",
  {
    path: z.string().describe("Vault-relative path to the note."),
    search: z.string().describe("Exact string to find in the note."),
    replace: z.string().describe("String to replace it with."),
    replace_all: z.boolean().optional().describe("If true, replace all occurrences. Defaults to false."),
  },
  async ({ path: noteName, search, replace, replace_all = false }) => {
    const fullPath = notePath(noteName);
    const content = await fs.readFile(fullPath, "utf-8");
    if (!content.includes(search)) {
      throw new Error(`Search string not found in ${noteName}`);
    }
    const updated = replace_all
      ? content.split(search).join(replace)
      : content.replace(search, replace);
    await fs.writeFile(fullPath, updated, "utf-8");
    const count = replace_all ? (content.split(search).length - 1) : 1;
    return {
      content: [{ type: "text", text: `Patched ${count} occurrence(s) in: ${noteName}` }],
    };
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// FRONTMATTER / METADATA
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  "get_frontmatter",
  "Parse and return the YAML frontmatter of a note as structured data.",
  {
    path: z.string().describe("Vault-relative path to the note."),
  },
  async ({ path: noteName }) => {
    const fullPath = notePath(noteName);
    const raw = await fs.readFile(fullPath, "utf-8");
    const parsed = matter(raw);
    return {
      content: [{ type: "text", text: JSON.stringify(parsed.data, null, 2) }],
    };
  }
);

server.tool(
  "set_frontmatter",
  "Update specific frontmatter fields on a note. Existing fields not mentioned are preserved.",
  {
    path: z.string().describe("Vault-relative path to the note."),
    fields: z.record(z.unknown()).describe("Key-value pairs to set in the frontmatter."),
  },
  async ({ path: noteName, fields }) => {
    const fullPath = notePath(noteName);
    const raw = await fs.readFile(fullPath, "utf-8");
    const parsed = matter(raw);
    const updatedData = { ...parsed.data, ...fields };
    const updated = matter.stringify(parsed.content, updatedData);
    await fs.writeFile(fullPath, updated, "utf-8");
    return {
      content: [{ type: "text", text: `Frontmatter updated: ${noteName}` }],
    };
  }
);

server.tool(
  "list_tags",
  "Aggregate all tags used across the vault with their usage counts.",
  {},
  async () => {
    const files = await collectMarkdownFiles(VAULT_PATH);
    const tagCounts = {};
    for (const file of files) {
      const raw = await fs.readFile(file, "utf-8");
      const parsed = matter(raw);
      const tags = extractTags(parsed);
      for (const tag of tags) {
        tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
      }
    }
    const sorted = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([tag, count]) => `${tag}: ${count}`)
      .join("\n");
    return {
      content: [{ type: "text", text: sorted || "No tags found." }],
    };
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// LINKS & GRAPH
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  "get_outgoing_links",
  "Return all [[wikilinks]] found in a note.",
  {
    path: z.string().describe("Vault-relative path to the note."),
  },
  async ({ path: noteName }) => {
    const fullPath = notePath(noteName);
    const content = await fs.readFile(fullPath, "utf-8");
    const links = parseWikilinks(content);
    return {
      content: [{ type: "text", text: links.length ? links.join("\n") : "No outgoing links." }],
    };
  }
);

server.tool(
  "get_backlinks",
  "Find all notes in the vault that contain a [[wikilink]] pointing to the given note.",
  {
    path: z.string().describe("Vault-relative path of the target note."),
  },
  async ({ path: noteName }) => {
    // Match by filename stem (without .md) as that's how Obsidian wikilinks work
    const stem = path.basename(noteName, ".md");
    const files = await collectMarkdownFiles(VAULT_PATH);
    const backlinks = [];
    for (const file of files) {
      const content = await fs.readFile(file, "utf-8");
      const links = parseWikilinks(content);
      if (links.some((l) => l.toLowerCase() === stem.toLowerCase())) {
        backlinks.push(toRelative(file));
      }
    }
    return {
      content: [{ type: "text", text: backlinks.length ? backlinks.join("\n") : "No backlinks found." }],
    };
  }
);

server.tool(
  "get_orphans",
  "List notes that have no incoming backlinks and no outgoing wikilinks.",
  {},
  async () => {
    const files = await collectMarkdownFiles(VAULT_PATH);
    // Build a map of stem → relative path and collect all outgoing links
    const stemToRel = {};
    const outgoingByFile = {};
    for (const file of files) {
      const rel = toRelative(file);
      const stem = path.basename(rel, ".md").toLowerCase();
      stemToRel[stem] = rel;
      const content = await fs.readFile(file, "utf-8");
      outgoingByFile[rel] = parseWikilinks(content).map((l) => l.toLowerCase());
    }
    // Collect all stems that are referenced by at least one file
    const referenced = new Set(Object.values(outgoingByFile).flat());
    const orphans = [];
    for (const rel of Object.values(stemToRel)) {
      const stem = path.basename(rel, ".md").toLowerCase();
      const hasIncoming = referenced.has(stem);
      const hasOutgoing = outgoingByFile[rel].length > 0;
      if (!hasIncoming && !hasOutgoing) orphans.push(rel);
    }
    return {
      content: [{ type: "text", text: orphans.length ? orphans.join("\n") : "No orphaned notes found." }],
    };
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// FOLDERS
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  "list_folders",
  "List all subdirectories (folders) in the vault.",
  {},
  async () => {
    const folders = await collectFolders(VAULT_PATH);
    return {
      content: [{ type: "text", text: folders.length ? folders.join("\n") : "No folders found." }],
    };
  }
);

server.tool(
  "create_folder",
  "Create a new folder (and any missing parent folders) in the vault.",
  {
    path: z.string().describe("Vault-relative folder path to create (e.g. 'Projects/Research')."),
  },
  async ({ path: folderName }) => {
    const fullPath = notePath(folderName);
    await fs.mkdir(fullPath, { recursive: true });
    return {
      content: [{ type: "text", text: `Folder created: ${folderName}` }],
    };
  }
);

server.tool(
  "delete_folder",
  "Delete an empty folder from the vault. Fails if the folder contains files.",
  {
    path: z.string().describe("Vault-relative path of the folder to delete."),
    force: z.boolean().optional().describe("If true, delete the folder and all its contents. Defaults to false."),
  },
  async ({ path: folderName, force = false }) => {
    const fullPath = notePath(folderName);
    if (force) {
      await fs.rm(fullPath, { recursive: true, force: true });
    } else {
      await fs.rmdir(fullPath); // fails if not empty
    }
    return {
      content: [{ type: "text", text: `Folder deleted: ${folderName}` }],
    };
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// DAILY NOTES
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  "get_daily_note",
  "Read the daily note for today or a specific date.",
  {
    date: z.string().optional().describe("Date in YYYY-MM-DD format. Defaults to today."),
  },
  async ({ date }) => {
    const dateStr = date ?? formatDate();
    const relPath = path.join(DAILY_NOTES_FOLDER, `${dateStr}.md`);
    const fullPath = notePath(relPath);
    const content = await fs.readFile(fullPath, "utf-8");
    return {
      content: [{ type: "text", text: content }],
    };
  }
);

server.tool(
  "create_daily_note",
  "Create the daily note for today or a specific date, optionally from a template.",
  {
    date: z.string().optional().describe("Date in YYYY-MM-DD format. Defaults to today."),
    template: z.string().optional().describe("Vault-relative path to a template note. Omit to create a blank note."),
  },
  async ({ date, template }) => {
    const dateStr = date ?? formatDate();
    const relPath = path.join(DAILY_NOTES_FOLDER, `${dateStr}.md`);
    const fullPath = notePath(relPath);

    // Don't overwrite an existing daily note
    try {
      await fs.access(fullPath);
      return { content: [{ type: "text", text: `Daily note already exists: ${relPath}` }] };
    } catch {
      // doesn't exist — proceed
    }

    let content = `# ${dateStr}\n`;
    if (template) {
      const tmplPath = notePath(template);
      const tmplRaw = await fs.readFile(tmplPath, "utf-8");
      content = tmplRaw
        .replaceAll("{{date}}", dateStr)
        .replaceAll("{{title}}", dateStr);
    }

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
    return {
      content: [{ type: "text", text: `Daily note created: ${relPath}` }],
    };
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// TEMPLATES
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  "list_templates",
  "List all notes in the Templates folder.",
  {},
  async () => {
    const tmplRoot = notePath(TEMPLATES_FOLDER);
    const files = await collectMarkdownFiles(tmplRoot);
    const relative = files.map(toRelative);
    return {
      content: [{ type: "text", text: relative.join("\n") || "No templates found." }],
    };
  }
);

server.tool(
  "create_from_template",
  "Create a new note from a template, substituting {{title}} and {{date}} placeholders.",
  {
    template: z.string().describe("Vault-relative path to the template note."),
    destination: z.string().describe("Vault-relative path for the new note."),
    title: z.string().optional().describe("Value to substitute for {{title}}. Defaults to the destination filename stem."),
    extra_vars: z.record(z.string()).optional().describe("Additional key-value pairs to substitute as {{key}} placeholders."),
  },
  async ({ template, destination, title, extra_vars = {} }) => {
    const tmplPath = notePath(template);
    const destPath = notePath(destination);

    const raw = await fs.readFile(tmplPath, "utf-8");
    const titleValue = title ?? path.basename(destination, ".md");
    const dateStr = formatDate();

    let content = raw
      .replaceAll("{{title}}", titleValue)
      .replaceAll("{{date}}", dateStr);

    for (const [key, value] of Object.entries(extra_vars)) {
      content = content.replaceAll(`{{${key}}}`, value);
    }

    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, content, "utf-8");
    return {
      content: [{ type: "text", text: `Note created from template: ${destination}` }],
    };
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// SEARCH
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  "search_notes",
  "Search note contents and filenames for a query string (case-insensitive).",
  {
    query: z.string().describe("Text to search for."),
  },
  async ({ query }) => {
    const files = await collectMarkdownFiles(VAULT_PATH);
    const lowerQuery = query.toLowerCase();
    const results = [];

    for (const file of files) {
      const content = await fs.readFile(file, "utf-8");
      const relativePath = toRelative(file);
      if (
        relativePath.toLowerCase().includes(lowerQuery) ||
        content.toLowerCase().includes(lowerQuery)
      ) {
        const lines = content.split("\n");
        const matchingLines = lines
          .map((line, i) => ({ line, i: i + 1 }))
          .filter(({ line }) => line.toLowerCase().includes(lowerQuery))
          .map(({ line, i }) => `  L${i}: ${line.trim()}`)
          .slice(0, 5);

        results.push(`### ${relativePath}\n${matchingLines.join("\n") || "  (filename match)"}`);
      }
    }

    return {
      content: [
        {
          type: "text",
          text: results.length ? results.join("\n\n") : "No matches found.",
        },
      ],
    };
  }
);

server.tool(
  "search_by_tag",
  "Find all notes that contain one or more specified tags (frontmatter or inline #tag).",
  {
    tags: z.array(z.string()).describe("List of tags to search for (without the # prefix)."),
    match: z.enum(["any", "all"]).optional().describe("'any' returns notes with at least one tag; 'all' requires all tags. Defaults to 'any'."),
  },
  async ({ tags, match = "any" }) => {
    const files = await collectMarkdownFiles(VAULT_PATH);
    const lowerTags = tags.map((t) => t.toLowerCase());
    const results = [];

    for (const file of files) {
      const raw = await fs.readFile(file, "utf-8");
      const parsed = matter(raw);
      const noteTags = extractTags(parsed);
      const matched = lowerTags.filter((t) => noteTags.includes(t));
      const passes = match === "all" ? matched.length === lowerTags.length : matched.length > 0;
      if (passes) {
        results.push(`${toRelative(file)} [${matched.join(", ")}]`);
      }
    }

    return {
      content: [{ type: "text", text: results.length ? results.join("\n") : "No matching notes found." }],
    };
  }
);

server.tool(
  "search_by_frontmatter",
  "Find notes whose frontmatter matches the given key-value criteria.",
  {
    criteria: z.record(z.unknown()).describe("Key-value pairs that must match the note's frontmatter (string values are compared case-insensitively)."),
  },
  async ({ criteria }) => {
    const files = await collectMarkdownFiles(VAULT_PATH);
    const results = [];

    for (const file of files) {
      const raw = await fs.readFile(file, "utf-8");
      const { data } = matter(raw);
      const matches = Object.entries(criteria).every(([key, value]) => {
        if (!(key in data)) return false;
        const a = String(data[key]).toLowerCase();
        const b = String(value).toLowerCase();
        return a === b;
      });
      if (matches) results.push(toRelative(file));
    }

    return {
      content: [{ type: "text", text: results.length ? results.join("\n") : "No matching notes found." }],
    };
  }
);

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
