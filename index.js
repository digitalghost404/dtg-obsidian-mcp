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
  const fmTags = parsedMatter.data.tags;
  if (Array.isArray(fmTags)) fmTags.forEach((t) => tags.add(String(t).toLowerCase()));
  else if (typeof fmTags === "string") fmTags.split(/[\s,]+/).filter(Boolean).forEach((t) => tags.add(t.toLowerCase()));
  const inlineMatches = [...parsedMatter.content.matchAll(/#([\w/-]+)/g)];
  inlineMatches.forEach((m) => tags.add(m[1].toLowerCase()));
  return [...tags];
}

/** Sanitize a string for use as a filename stem. */
function slugify(str) {
  return str.replace(/[/\\?%*:|"<>]/g, "-").trim();
}

// ─── NLP helpers ─────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for","of","with","by",
  "from","is","was","are","were","be","been","being","have","has","had","do",
  "does","did","will","would","could","should","may","might","must","shall",
  "can","that","this","these","those","it","its","i","you","he","she","we",
  "they","what","which","who","how","when","where","why","not","no","so","if",
  "as","up","out","about","into","than","then","there","their","my","your",
  "his","her","our","just","also","more","some","any","all","each","both",
  "few","other","such","same","own","new","first","last","much","many","very",
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function jaccardSimilarity(setA, setB) {
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

// ─── Graph helpers ────────────────────────────────────────────────────────────

/** Build a stem→[linked stems] adjacency map for the whole vault. */
async function buildLinkGraph(files) {
  const graph = {};
  for (const file of files) {
    const stem = path.basename(file, ".md").toLowerCase();
    const content = await fs.readFile(file, "utf-8");
    graph[stem] = parseWikilinks(content).map((l) => l.toLowerCase());
  }
  return graph;
}

/** BFS to find shortest wikilink path between two note stems. */
function bfsPath(graph, startStem, endStem) {
  const queue = [[startStem]];
  const visited = new Set([startStem]);
  while (queue.length) {
    const path = queue.shift();
    const current = path[path.length - 1];
    for (const neighbor of graph[current] ?? []) {
      if (visited.has(neighbor)) continue;
      const newPath = [...path, neighbor];
      if (neighbor === endStem) return newPath;
      visited.add(neighbor);
      queue.push(newPath);
    }
  }
  return null;
}

// ─── Server setup ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "obsidian-vault",
  version: "3.0.0",
});

// ══════════════════════════════════════════════════════════════════════════════
// NOTE MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  "list_notes",
  "List all notes in the Obsidian vault. Optionally filter by folder.",
  { folder: z.string().optional().describe("Subfolder to list (e.g. 'Projects'). Omit for all notes.") },
  async ({ folder }) => {
    const searchRoot = folder ? notePath(folder) : VAULT_PATH;
    const files = await collectMarkdownFiles(searchRoot);
    return { content: [{ type: "text", text: files.map(toRelative).join("\n") || "No notes found." }] };
  }
);

server.tool(
  "read_note",
  "Read the full content of a note by its vault-relative path.",
  { path: z.string().describe("Vault-relative path to the note.") },
  async ({ path: noteName }) => {
    const content = await fs.readFile(notePath(noteName), "utf-8");
    return { content: [{ type: "text", text: content }] };
  }
);

server.tool(
  "write_note",
  "Create or overwrite a note. Parent folders are created automatically.",
  {
    path: z.string().describe("Vault-relative path for the note."),
    content: z.string().describe("Full markdown content to write."),
  },
  async ({ path: noteName, content }) => {
    const fullPath = notePath(noteName);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
    return { content: [{ type: "text", text: `Note written: ${noteName}` }] };
  }
);

server.tool(
  "delete_note",
  "Delete a note by its vault-relative path. This is irreversible.",
  { path: z.string().describe("Vault-relative path to the note to delete.") },
  async ({ path: noteName }) => {
    await fs.unlink(notePath(noteName));
    return { content: [{ type: "text", text: `Deleted: ${noteName}` }] };
  }
);

server.tool(
  "rename_note",
  "Rename or move a note to a new vault-relative path.",
  {
    from: z.string().describe("Current vault-relative path."),
    to: z.string().describe("New vault-relative path."),
  },
  async ({ from, to }) => {
    const toPath = notePath(to);
    await fs.mkdir(path.dirname(toPath), { recursive: true });
    await fs.rename(notePath(from), toPath);
    return { content: [{ type: "text", text: `Moved: ${from} → ${to}` }] };
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
    return { content: [{ type: "text", text: `Appended to: ${noteName}` }] };
  }
);

server.tool(
  "patch_note",
  "Replace the first (or all) occurrences of a search string within a note.",
  {
    path: z.string().describe("Vault-relative path to the note."),
    search: z.string().describe("Exact string to find."),
    replace: z.string().describe("Replacement string."),
    replace_all: z.boolean().optional().describe("Replace all occurrences. Defaults to false."),
  },
  async ({ path: noteName, search, replace, replace_all = false }) => {
    const fullPath = notePath(noteName);
    const content = await fs.readFile(fullPath, "utf-8");
    if (!content.includes(search)) throw new Error(`Search string not found in ${noteName}`);
    const updated = replace_all ? content.split(search).join(replace) : content.replace(search, replace);
    await fs.writeFile(fullPath, updated, "utf-8");
    const count = replace_all ? content.split(search).length - 1 : 1;
    return { content: [{ type: "text", text: `Patched ${count} occurrence(s) in: ${noteName}` }] };
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// FRONTMATTER / METADATA
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  "get_frontmatter",
  "Parse and return the YAML frontmatter of a note as structured JSON.",
  { path: z.string().describe("Vault-relative path to the note.") },
  async ({ path: noteName }) => {
    const raw = await fs.readFile(notePath(noteName), "utf-8");
    return { content: [{ type: "text", text: JSON.stringify(matter(raw).data, null, 2) }] };
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
    const parsed = matter(await fs.readFile(fullPath, "utf-8"));
    await fs.writeFile(fullPath, matter.stringify(parsed.content, { ...parsed.data, ...fields }), "utf-8");
    return { content: [{ type: "text", text: `Frontmatter updated: ${noteName}` }] };
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
      for (const tag of extractTags(matter(await fs.readFile(file, "utf-8")))) {
        tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
      }
    }
    const sorted = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([tag, count]) => `${tag}: ${count}`)
      .join("\n");
    return { content: [{ type: "text", text: sorted || "No tags found." }] };
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// LINKS & GRAPH
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  "get_outgoing_links",
  "Return all [[wikilinks]] found in a note.",
  { path: z.string().describe("Vault-relative path to the note.") },
  async ({ path: noteName }) => {
    const content = await fs.readFile(notePath(noteName), "utf-8");
    const links = parseWikilinks(content);
    return { content: [{ type: "text", text: links.length ? links.join("\n") : "No outgoing links." }] };
  }
);

server.tool(
  "get_backlinks",
  "Find all notes in the vault that [[wikilink]] to the given note.",
  { path: z.string().describe("Vault-relative path of the target note.") },
  async ({ path: noteName }) => {
    const stem = path.basename(noteName, ".md").toLowerCase();
    const files = await collectMarkdownFiles(VAULT_PATH);
    const backlinks = [];
    for (const file of files) {
      const links = parseWikilinks(await fs.readFile(file, "utf-8")).map((l) => l.toLowerCase());
      if (links.includes(stem)) backlinks.push(toRelative(file));
    }
    return { content: [{ type: "text", text: backlinks.length ? backlinks.join("\n") : "No backlinks found." }] };
  }
);

server.tool(
  "get_orphans",
  "List notes that have no incoming backlinks and no outgoing wikilinks.",
  {},
  async () => {
    const files = await collectMarkdownFiles(VAULT_PATH);
    const outgoingByRel = {};
    for (const file of files) {
      const rel = toRelative(file);
      outgoingByRel[rel] = parseWikilinks(await fs.readFile(file, "utf-8")).map((l) => l.toLowerCase());
    }
    const referenced = new Set(Object.values(outgoingByRel).flat());
    const orphans = Object.keys(outgoingByRel).filter((rel) => {
      const stem = path.basename(rel, ".md").toLowerCase();
      return !referenced.has(stem) && outgoingByRel[rel].length === 0;
    });
    return { content: [{ type: "text", text: orphans.length ? orphans.join("\n") : "No orphaned notes found." }] };
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
    return { content: [{ type: "text", text: folders.length ? folders.join("\n") : "No folders found." }] };
  }
);

server.tool(
  "create_folder",
  "Create a new folder (and any missing parent folders) in the vault.",
  { path: z.string().describe("Vault-relative folder path to create.") },
  async ({ path: folderName }) => {
    await fs.mkdir(notePath(folderName), { recursive: true });
    return { content: [{ type: "text", text: `Folder created: ${folderName}` }] };
  }
);

server.tool(
  "delete_folder",
  "Delete a folder. Fails if non-empty unless force is true.",
  {
    path: z.string().describe("Vault-relative path of the folder to delete."),
    force: z.boolean().optional().describe("Delete folder and all its contents. Defaults to false."),
  },
  async ({ path: folderName, force = false }) => {
    const fullPath = notePath(folderName);
    if (force) await fs.rm(fullPath, { recursive: true, force: true });
    else await fs.rmdir(fullPath);
    return { content: [{ type: "text", text: `Folder deleted: ${folderName}` }] };
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// DAILY NOTES
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  "get_daily_note",
  "Read the daily note for today or a specific date.",
  { date: z.string().optional().describe("Date in YYYY-MM-DD format. Defaults to today.") },
  async ({ date }) => {
    const dateStr = date ?? formatDate();
    const relPath = path.join(DAILY_NOTES_FOLDER, `${dateStr}.md`);
    const content = await fs.readFile(notePath(relPath), "utf-8");
    return { content: [{ type: "text", text: content }] };
  }
);

server.tool(
  "create_daily_note",
  "Create the daily note for today or a specific date, optionally from a template.",
  {
    date: z.string().optional().describe("Date in YYYY-MM-DD format. Defaults to today."),
    template: z.string().optional().describe("Vault-relative path to a template note."),
  },
  async ({ date, template }) => {
    const dateStr = date ?? formatDate();
    const relPath = path.join(DAILY_NOTES_FOLDER, `${dateStr}.md`);
    const fullPath = notePath(relPath);
    try {
      await fs.access(fullPath);
      return { content: [{ type: "text", text: `Daily note already exists: ${relPath}` }] };
    } catch { /* doesn't exist — proceed */ }
    let content = `# ${dateStr}\n`;
    if (template) {
      const tmplRaw = await fs.readFile(notePath(template), "utf-8");
      content = tmplRaw.replaceAll("{{date}}", dateStr).replaceAll("{{title}}", dateStr);
    }
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
    return { content: [{ type: "text", text: `Daily note created: ${relPath}` }] };
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
    return { content: [{ type: "text", text: files.map(toRelative).join("\n") || "No templates found." }] };
  }
);

server.tool(
  "create_from_template",
  "Create a new note from a template, substituting {{title}}, {{date}}, and custom {{key}} placeholders.",
  {
    template: z.string().describe("Vault-relative path to the template note."),
    destination: z.string().describe("Vault-relative path for the new note."),
    title: z.string().optional().describe("Value for {{title}}. Defaults to the destination filename stem."),
    extra_vars: z.record(z.string()).optional().describe("Additional {{key}} substitutions."),
  },
  async ({ template, destination, title, extra_vars = {} }) => {
    const destPath = notePath(destination);
    const raw = await fs.readFile(notePath(template), "utf-8");
    const titleValue = title ?? path.basename(destination, ".md");
    let content = raw.replaceAll("{{title}}", titleValue).replaceAll("{{date}}", formatDate());
    for (const [key, value] of Object.entries(extra_vars)) {
      content = content.replaceAll(`{{${key}}}`, value);
    }
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, content, "utf-8");
    return { content: [{ type: "text", text: `Note created from template: ${destination}` }] };
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// SEARCH
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  "search_notes",
  "Search note contents and filenames for a query string (case-insensitive).",
  { query: z.string().describe("Text to search for.") },
  async ({ query }) => {
    const files = await collectMarkdownFiles(VAULT_PATH);
    const lowerQuery = query.toLowerCase();
    const results = [];
    for (const file of files) {
      const content = await fs.readFile(file, "utf-8");
      const relativePath = toRelative(file);
      if (relativePath.toLowerCase().includes(lowerQuery) || content.toLowerCase().includes(lowerQuery)) {
        const matchingLines = content.split("\n")
          .map((line, i) => ({ line, i: i + 1 }))
          .filter(({ line }) => line.toLowerCase().includes(lowerQuery))
          .map(({ line, i }) => `  L${i}: ${line.trim()}`)
          .slice(0, 5);
        results.push(`### ${relativePath}\n${matchingLines.join("\n") || "  (filename match)"}`);
      }
    }
    return { content: [{ type: "text", text: results.length ? results.join("\n\n") : "No matches found." }] };
  }
);

server.tool(
  "search_by_tag",
  "Find all notes that contain one or more specified tags (frontmatter or inline #tag).",
  {
    tags: z.array(z.string()).describe("Tags to search for (without the # prefix)."),
    match: z.enum(["any", "all"]).optional().describe("'any': at least one tag matches. 'all': all tags must match. Defaults to 'any'."),
  },
  async ({ tags, match = "any" }) => {
    const files = await collectMarkdownFiles(VAULT_PATH);
    const lowerTags = tags.map((t) => t.toLowerCase());
    const results = [];
    for (const file of files) {
      const noteTags = extractTags(matter(await fs.readFile(file, "utf-8")));
      const matched = lowerTags.filter((t) => noteTags.includes(t));
      const passes = match === "all" ? matched.length === lowerTags.length : matched.length > 0;
      if (passes) results.push(`${toRelative(file)} [${matched.join(", ")}]`);
    }
    return { content: [{ type: "text", text: results.length ? results.join("\n") : "No matching notes found." }] };
  }
);

server.tool(
  "search_by_frontmatter",
  "Find notes whose frontmatter matches the given key-value criteria (case-insensitive string comparison).",
  { criteria: z.record(z.unknown()).describe("Key-value pairs that must match the note's frontmatter.") },
  async ({ criteria }) => {
    const files = await collectMarkdownFiles(VAULT_PATH);
    const results = [];
    for (const file of files) {
      const { data } = matter(await fs.readFile(file, "utf-8"));
      const matches = Object.entries(criteria).every(([key, value]) => {
        if (!(key in data)) return false;
        return String(data[key]).toLowerCase() === String(value).toLowerCase();
      });
      if (matches) results.push(toRelative(file));
    }
    return { content: [{ type: "text", text: results.length ? results.join("\n") : "No matching notes found." }] };
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// AI-POWERED KNOWLEDGE FEATURES
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  "summarize_note",
  "Extract a structural outline of a note: headings, first sentence of each section, word count, and reading time. Use this as the basis for generating a summary.",
  { path: z.string().describe("Vault-relative path to the note.") },
  async ({ path: noteName }) => {
    const raw = await fs.readFile(notePath(noteName), "utf-8");
    const { content, data } = matter(raw);
    const lines = content.split("\n");
    const words = tokenize(content).length;
    const readingTimeMins = Math.ceil(words / 200);

    const outline = [];
    let buffer = [];

    const flushBuffer = () => {
      const sentence = buffer.join(" ").replace(/\s+/g, " ").trim();
      if (sentence) {
        const first = sentence.match(/[^.!?]+[.!?]*/)?.[0]?.trim() ?? sentence.slice(0, 120);
        outline.push(`  → ${first}`);
      }
      buffer = [];
    };

    for (const line of lines) {
      if (/^#{1,6}\s/.test(line)) {
        flushBuffer();
        outline.push(line);
      } else if (line.trim()) {
        buffer.push(line.trim());
      } else {
        flushBuffer();
      }
    }
    flushBuffer();

    const meta = [
      `**Words:** ${words}`,
      `**Reading time:** ~${readingTimeMins} min`,
      data.tags ? `**Tags:** ${[].concat(data.tags).join(", ")}` : null,
      data.summary ? `**Existing summary:** ${data.summary}` : null,
    ].filter(Boolean).join(" | ");

    return {
      content: [{
        type: "text",
        text: `## Outline: ${path.basename(noteName, ".md")}\n${meta}\n\n${outline.join("\n")}`,
      }],
    };
  }
);

server.tool(
  "suggest_links",
  "Suggest existing vault notes that the given note should link to, based on content and title overlap. Returns ranked candidates not already linked.",
  {
    path: z.string().describe("Vault-relative path to the note."),
    limit: z.number().optional().describe("Max suggestions to return. Defaults to 10."),
  },
  async ({ path: noteName, limit = 10 }) => {
    const fullPath = notePath(noteName);
    const sourceRaw = await fs.readFile(fullPath, "utf-8");
    const sourceTokens = new Set(tokenize(matter(sourceRaw).content));
    const sourceLinks = new Set(parseWikilinks(sourceRaw).map((l) => l.toLowerCase()));
    const sourceStem = path.basename(noteName, ".md").toLowerCase();

    const files = await collectMarkdownFiles(VAULT_PATH);
    const candidates = [];

    for (const file of files) {
      const rel = toRelative(file);
      const stem = path.basename(rel, ".md").toLowerCase();
      if (stem === sourceStem || sourceLinks.has(stem)) continue; // skip self and already-linked

      const raw = await fs.readFile(file, "utf-8");
      const titleTokens = new Set(tokenize(stem));
      const contentTokens = new Set(tokenize(matter(raw).content));
      const allTokens = new Set([...titleTokens, ...contentTokens]);

      // Score: weighted combination of title overlap and content overlap
      const titleScore = jaccardSimilarity(sourceTokens, titleTokens) * 3; // title match weighted 3×
      const contentScore = jaccardSimilarity(sourceTokens, contentTokens);
      const score = titleScore + contentScore;

      if (score > 0.02) candidates.push({ rel, score: Math.round(score * 1000) / 1000 });
    }

    candidates.sort((a, b) => b.score - a.score);
    const top = candidates.slice(0, limit);

    return {
      content: [{
        type: "text",
        text: top.length
          ? top.map((c) => `${c.rel} (score: ${c.score})`).join("\n")
          : "No link suggestions found.",
      }],
    };
  }
);

server.tool(
  "generate_moc",
  "Generate a Map of Contents (MOC) note for a folder, listing all notes with their tags and first paragraph.",
  {
    folder: z.string().describe("Vault-relative folder to generate the MOC for."),
    destination: z.string().optional().describe("Vault-relative path to write the MOC note. Omit to return without saving."),
  },
  async ({ folder, destination }) => {
    const searchRoot = notePath(folder);
    const files = await collectMarkdownFiles(searchRoot);

    const sections = [];
    for (const file of files) {
      const rel = toRelative(file);
      const raw = await fs.readFile(file, "utf-8");
      const { content, data } = matter(raw);
      const title = path.basename(rel, ".md");
      const tags = data.tags ? [].concat(data.tags).map((t) => `#${t}`).join(" ") : "";
      const firstPara = content.split(/\n\n+/).find((p) => p.trim() && !/^#/.test(p))?.trim().slice(0, 200) ?? "";
      sections.push(`### [[${title}]]\n${tags ? `${tags}\n` : ""}${firstPara ? `${firstPara}…` : ""}`);
    }

    const moc = `# Map of Contents — ${folder}\n*Generated: ${formatDate()}*\n\n${sections.join("\n\n")}`;

    if (destination) {
      const destPath = notePath(destination);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, moc, "utf-8");
      return { content: [{ type: "text", text: `MOC written to: ${destination}` }] };
    }

    return { content: [{ type: "text", text: moc }] };
  }
);

server.tool(
  "find_duplicates",
  "Identify pairs of notes with highly similar content using Jaccard similarity. Returns pairs above the similarity threshold.",
  {
    threshold: z.number().optional().describe("Similarity threshold between 0 and 1. Defaults to 0.5."),
    folder: z.string().optional().describe("Limit search to a specific folder."),
  },
  async ({ threshold = 0.5, folder }) => {
    const searchRoot = folder ? notePath(folder) : VAULT_PATH;
    const files = await collectMarkdownFiles(searchRoot);

    // Pre-tokenize all files
    const tokenSets = await Promise.all(
      files.map(async (f) => {
        const raw = await fs.readFile(f, "utf-8");
        return new Set(tokenize(matter(raw).content));
      })
    );

    const pairs = [];
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const sim = jaccardSimilarity(tokenSets[i], tokenSets[j]);
        if (sim >= threshold) {
          pairs.push({
            a: toRelative(files[i]),
            b: toRelative(files[j]),
            similarity: Math.round(sim * 1000) / 1000,
          });
        }
      }
    }

    pairs.sort((a, b) => b.similarity - a.similarity);

    return {
      content: [{
        type: "text",
        text: pairs.length
          ? pairs.map((p) => `${p.similarity} — "${p.a}" ↔ "${p.b}"`).join("\n")
          : `No duplicate pairs found above threshold ${threshold}.`,
      }],
    };
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// VAULT INTELLIGENCE
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  "get_graph_stats",
  "Return vault-wide graph statistics: note count, link counts, most-connected notes, and isolated clusters.",
  {},
  async () => {
    const files = await collectMarkdownFiles(VAULT_PATH);
    const graph = await buildLinkGraph(files);

    const inDegree = {};
    const outDegree = {};
    for (const [stem, links] of Object.entries(graph)) {
      outDegree[stem] = links.length;
      for (const link of links) {
        inDegree[link] = (inDegree[link] ?? 0) + 1;
      }
    }

    const stems = Object.keys(graph);
    const totalLinks = Object.values(outDegree).reduce((a, b) => a + b, 0);
    const avgConnections = stems.length ? (totalLinks / stems.length).toFixed(2) : 0;

    const topByIn = Object.entries(inDegree)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([s, c]) => `  ${s} (${c} backlinks)`);

    const topByOut = stems
      .sort((a, b) => (outDegree[b] ?? 0) - (outDegree[a] ?? 0))
      .slice(0, 5)
      .map((s) => `  ${s} (${outDegree[s]} outgoing)`);

    const isolated = stems.filter((s) => !inDegree[s] && !outDegree[s]);

    const stats = [
      `**Total notes:** ${files.length}`,
      `**Total links:** ${totalLinks}`,
      `**Avg connections per note:** ${avgConnections}`,
      `\n**Most linked-to (by backlinks):**\n${topByIn.join("\n") || "  none"}`,
      `\n**Most outgoing links:**\n${topByOut.join("\n") || "  none"}`,
      `\n**Isolated notes (no links):** ${isolated.length}`,
    ].join("\n");

    return { content: [{ type: "text", text: stats }] };
  }
);

server.tool(
  "get_hub_notes",
  "Return the most-linked-to notes in the vault (the knowledge graph's pillars), ranked by backlink count.",
  { limit: z.number().optional().describe("Number of hub notes to return. Defaults to 10.") },
  async ({ limit = 10 }) => {
    const files = await collectMarkdownFiles(VAULT_PATH);
    const inDegree = {};
    for (const file of files) {
      const content = await fs.readFile(file, "utf-8");
      for (const link of parseWikilinks(content)) {
        const key = link.toLowerCase();
        inDegree[key] = (inDegree[key] ?? 0) + 1;
      }
    }

    const hubs = Object.entries(inDegree)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([stem, count]) => `${stem}: ${count} backlinks`);

    return { content: [{ type: "text", text: hubs.length ? hubs.join("\n") : "No links found in vault." }] };
  }
);

server.tool(
  "trace_path",
  "Find the shortest wikilink path connecting two notes (like six degrees of separation).",
  {
    from: z.string().describe("Vault-relative path or note stem to start from."),
    to: z.string().describe("Vault-relative path or note stem to find."),
  },
  async ({ from, to }) => {
    const files = await collectMarkdownFiles(VAULT_PATH);
    const graph = await buildLinkGraph(files);
    const startStem = path.basename(from, ".md").toLowerCase();
    const endStem = path.basename(to, ".md").toLowerCase();

    if (startStem === endStem) {
      return { content: [{ type: "text", text: "Source and destination are the same note." }] };
    }

    const foundPath = bfsPath(graph, startStem, endStem);

    return {
      content: [{
        type: "text",
        text: foundPath
          ? `Path (${foundPath.length - 1} hop${foundPath.length === 2 ? "" : "s"}):\n${foundPath.join(" → ")}`
          : `No wikilink path found between "${startStem}" and "${endStem}".`,
      }],
    };
  }
);

server.tool(
  "get_recently_modified",
  "List notes modified within the last N days, most recent first.",
  { days: z.number().optional().describe("Lookback window in days. Defaults to 7.") },
  async ({ days = 7 }) => {
    const files = await collectMarkdownFiles(VAULT_PATH);
    const cutoff = Date.now() - days * 86_400_000;
    const entries = [];

    for (const file of files) {
      const { mtimeMs } = await fs.stat(file);
      if (mtimeMs >= cutoff) entries.push({ rel: toRelative(file), mtimeMs });
    }

    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

    return {
      content: [{
        type: "text",
        text: entries.length
          ? entries.map((e) => `${new Date(e.mtimeMs).toISOString().split("T")[0]}  ${e.rel}`).join("\n")
          : `No notes modified in the last ${days} days.`,
      }],
    };
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// WRITING & WORKFLOW
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  "extract_tasks",
  "Scan the vault (or a specific note) for markdown checkboxes and return a consolidated task list.",
  {
    path: z.string().optional().describe("Vault-relative path to a single note. Omit to scan the entire vault."),
    status: z.enum(["all", "open", "done"]).optional().describe("Filter by task status. Defaults to 'all'."),
  },
  async ({ path: noteName, status = "all" }) => {
    const files = noteName ? [notePath(noteName)] : await collectMarkdownFiles(VAULT_PATH);
    const results = [];

    for (const file of files) {
      const content = await fs.readFile(file, "utf-8");
      const rel = toRelative(file);
      const taskLines = content.split("\n").reduce((acc, line, i) => {
        const openMatch = /^(\s*)-\s+\[ \]\s+(.+)/.exec(line);
        const doneMatch = /^(\s*)-\s+\[x\]\s+(.+)/i.exec(line);
        if (openMatch && (status === "all" || status === "open")) {
          acc.push({ line: i + 1, done: false, text: openMatch[2].trim() });
        } else if (doneMatch && (status === "all" || status === "done")) {
          acc.push({ line: i + 1, done: true, text: doneMatch[2].trim() });
        }
        return acc;
      }, []);

      if (taskLines.length) {
        results.push(`### ${rel}\n${taskLines.map((t) => `  L${t.line}: [${t.done ? "x" : " "}] ${t.text}`).join("\n")}`);
      }
    }

    return {
      content: [{ type: "text", text: results.length ? results.join("\n\n") : "No tasks found." }],
    };
  }
);

server.tool(
  "complete_task",
  "Check off a specific open task in a note by matching its text.",
  {
    path: z.string().describe("Vault-relative path to the note."),
    task_text: z.string().describe("Exact text of the task to complete (without the checkbox)."),
  },
  async ({ path: noteName, task_text }) => {
    const fullPath = notePath(noteName);
    const content = await fs.readFile(fullPath, "utf-8");
    const pattern = `- [ ] ${task_text}`;
    if (!content.includes(pattern)) throw new Error(`Open task not found: "${task_text}"`);
    await fs.writeFile(fullPath, content.replace(pattern, `- [x] ${task_text}`), "utf-8");
    return { content: [{ type: "text", text: `Task completed: "${task_text}"` }] };
  }
);

server.tool(
  "merge_notes",
  "Merge multiple notes into a single destination note.",
  {
    sources: z.array(z.string()).describe("Ordered list of vault-relative source note paths."),
    destination: z.string().describe("Vault-relative path for the merged note."),
    strip_frontmatter: z.boolean().optional().describe("If true, omit frontmatter from all but the first note. Defaults to true."),
    separator: z.string().optional().describe("Markdown separator inserted between merged notes. Defaults to '\\n---\\n'."),
  },
  async ({ sources, destination, strip_frontmatter = true, separator = "\n---\n" }) => {
    const parts = [];
    for (let i = 0; i < sources.length; i++) {
      const raw = await fs.readFile(notePath(sources[i]), "utf-8");
      if (i > 0 && strip_frontmatter) {
        parts.push(matter(raw).content.trim());
      } else {
        parts.push(raw.trim());
      }
    }
    const merged = parts.join(separator);
    const destPath = notePath(destination);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, merged + "\n", "utf-8");
    return { content: [{ type: "text", text: `Merged ${sources.length} notes into: ${destination}` }] };
  }
);

server.tool(
  "split_note",
  "Split a note into multiple notes at a given heading level. Each section becomes its own file.",
  {
    path: z.string().describe("Vault-relative path to the note to split."),
    heading_level: z.number().optional().describe("Heading level to split at (1–6). Defaults to 2."),
    destination_folder: z.string().optional().describe("Vault-relative folder for the new notes. Defaults to same folder as the source note."),
  },
  async ({ path: noteName, heading_level = 2, destination_folder }) => {
    const fullPath = notePath(noteName);
    const raw = await fs.readFile(fullPath, "utf-8");
    const { content } = matter(raw);
    const marker = "#".repeat(heading_level) + " ";
    const destFolder = destination_folder ?? path.dirname(noteName);

    const sections = [];
    let currentTitle = null;
    let currentLines = [];

    for (const line of content.split("\n")) {
      if (line.startsWith(marker) && !line.startsWith(marker + "#")) {
        if (currentTitle !== null) {
          sections.push({ title: currentTitle, content: currentLines.join("\n").trim() });
        }
        currentTitle = line.slice(marker.length).trim();
        currentLines = [line];
      } else {
        currentLines.push(line);
      }
    }
    if (currentTitle !== null) {
      sections.push({ title: currentTitle, content: currentLines.join("\n").trim() });
    }

    if (sections.length === 0) {
      return { content: [{ type: "text", text: `No level-${heading_level} headings found in ${noteName}.` }] };
    }

    const created = [];
    for (const section of sections) {
      const filename = `${slugify(section.title)}.md`;
      const relPath = path.join(destFolder, filename);
      const sectionPath = notePath(relPath);
      await fs.mkdir(path.dirname(sectionPath), { recursive: true });
      await fs.writeFile(sectionPath, section.content + "\n", "utf-8");
      created.push(relPath);
    }

    return {
      content: [{
        type: "text",
        text: `Split into ${created.length} notes:\n${created.join("\n")}`,
      }],
    };
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// DATAVIEW-STYLE QUERIES
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  "query_notes",
  "Query notes using frontmatter field filters. Supports equality, inclusion (for arrays), and comparison operators.",
  {
    where: z.array(
      z.object({
        field: z.string().describe("Frontmatter field name."),
        operator: z.enum(["eq", "neq", "contains", "gt", "lt", "gte", "lte", "exists"]).describe(
          "eq: equals | neq: not equals | contains: array/string includes value | gt/lt/gte/lte: numeric comparison | exists: field is present"
        ),
        value: z.union([z.string(), z.number(), z.boolean()]).optional().describe("Value to compare against (not needed for 'exists')."),
      })
    ).describe("Filter conditions (all must match)."),
    sort_by: z.string().optional().describe("Frontmatter field to sort results by."),
    sort_order: z.enum(["asc", "desc"]).optional().describe("Sort direction. Defaults to 'asc'."),
    limit: z.number().optional().describe("Maximum number of results to return."),
  },
  async ({ where, sort_by, sort_order = "asc", limit }) => {
    const files = await collectMarkdownFiles(VAULT_PATH);
    const results = [];

    for (const file of files) {
      const { data } = matter(await fs.readFile(file, "utf-8"));
      const passes = where.every(({ field, operator, value }) => {
        const fieldVal = data[field];
        if (operator === "exists") return field in data;
        if (fieldVal === undefined) return false;
        switch (operator) {
          case "eq":       return String(fieldVal).toLowerCase() === String(value).toLowerCase();
          case "neq":      return String(fieldVal).toLowerCase() !== String(value).toLowerCase();
          case "contains": return Array.isArray(fieldVal)
            ? fieldVal.map(String).map((v) => v.toLowerCase()).includes(String(value).toLowerCase())
            : String(fieldVal).toLowerCase().includes(String(value).toLowerCase());
          case "gt":  return Number(fieldVal) > Number(value);
          case "lt":  return Number(fieldVal) < Number(value);
          case "gte": return Number(fieldVal) >= Number(value);
          case "lte": return Number(fieldVal) <= Number(value);
          default:    return false;
        }
      });
      if (passes) results.push({ rel: toRelative(file), data });
    }

    if (sort_by) {
      results.sort((a, b) => {
        const va = a.data[sort_by] ?? "";
        const vb = b.data[sort_by] ?? "";
        return sort_order === "desc"
          ? String(vb).localeCompare(String(va))
          : String(va).localeCompare(String(vb));
      });
    }

    const limited = limit ? results.slice(0, limit) : results;

    return {
      content: [{
        type: "text",
        text: limited.length
          ? limited.map((r) => {
              const fields = Object.entries(r.data)
                .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
                .join(", ");
              return `${r.rel}${fields ? `  [${fields}]` : ""}`;
            }).join("\n")
          : "No notes matched the query.",
      }],
    };
  }
);

server.tool(
  "get_timeline",
  "List notes sorted chronologically by a date frontmatter field.",
  {
    date_field: z.string().optional().describe("Frontmatter field containing the date. Defaults to 'date'."),
    order: z.enum(["asc", "desc"]).optional().describe("Sort order. Defaults to 'desc' (newest first)."),
    limit: z.number().optional().describe("Maximum number of results."),
    folder: z.string().optional().describe("Limit to a specific folder."),
  },
  async ({ date_field = "date", order = "desc", limit, folder }) => {
    const searchRoot = folder ? notePath(folder) : VAULT_PATH;
    const files = await collectMarkdownFiles(searchRoot);
    const entries = [];

    for (const file of files) {
      const { data } = matter(await fs.readFile(file, "utf-8"));
      if (data[date_field]) {
        entries.push({ rel: toRelative(file), date: String(data[date_field]), data });
      }
    }

    entries.sort((a, b) =>
      order === "desc" ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date)
    );

    const limited = limit ? entries.slice(0, limit) : entries;

    return {
      content: [{
        type: "text",
        text: limited.length
          ? limited.map((e) => `${e.date}  ${e.rel}`).join("\n")
          : `No notes found with a '${date_field}' field.`,
      }],
    };
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// VAULT HEALTH
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  "find_broken_links",
  "List all [[wikilinks]] that point to notes that don't exist in the vault.",
  {},
  async () => {
    const files = await collectMarkdownFiles(VAULT_PATH);
    const existingStems = new Set(files.map((f) => path.basename(f, ".md").toLowerCase()));
    const broken = [];

    for (const file of files) {
      const content = await fs.readFile(file, "utf-8");
      const rel = toRelative(file);
      const links = parseWikilinks(content);
      for (const link of links) {
        if (!existingStems.has(link.toLowerCase())) {
          broken.push(`${rel} → [[${link}]]`);
        }
      }
    }

    return {
      content: [{
        type: "text",
        text: broken.length ? broken.join("\n") : "No broken links found.",
      }],
    };
  }
);

server.tool(
  "find_empty_notes",
  "Find notes that have no meaningful content (empty body or only frontmatter).",
  {},
  async () => {
    const files = await collectMarkdownFiles(VAULT_PATH);
    const empty = [];

    for (const file of files) {
      const raw = await fs.readFile(file, "utf-8");
      const body = matter(raw).content.trim();
      if (!body) empty.push(toRelative(file));
    }

    return {
      content: [{ type: "text", text: empty.length ? empty.join("\n") : "No empty notes found." }],
    };
  }
);

server.tool(
  "vault_report",
  "Generate a comprehensive vault health report: broken links, orphans, empty notes, tag stats, and folder sizes.",
  {},
  async () => {
    const files = await collectMarkdownFiles(VAULT_PATH);
    const existingStems = new Set(files.map((f) => path.basename(f, ".md").toLowerCase()));

    const broken = [];
    const outgoingByRel = {};
    const tagCounts = {};
    const folderCounts = {};
    const empty = [];

    for (const file of files) {
      const raw = await fs.readFile(file, "utf-8");
      const rel = toRelative(file);
      const parsed = matter(raw);
      const body = parsed.content.trim();

      // Empty
      if (!body) empty.push(rel);

      // Tags
      for (const tag of extractTags(parsed)) {
        tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
      }

      // Links
      const links = parseWikilinks(raw);
      outgoingByRel[rel] = links.map((l) => l.toLowerCase());
      for (const link of links) {
        if (!existingStems.has(link.toLowerCase())) broken.push(`${rel} → [[${link}]]`);
      }

      // Folder sizes
      const folder = path.dirname(rel);
      folderCounts[folder] = (folderCounts[folder] ?? 0) + 1;
    }

    // Orphans
    const referenced = new Set(Object.values(outgoingByRel).flat());
    const orphans = Object.keys(outgoingByRel).filter((rel) => {
      const stem = path.basename(rel, ".md").toLowerCase();
      return !referenced.has(stem) && outgoingByRel[rel].length === 0;
    });

    // Top tags
    const topTags = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([t, c]) => `  ${t}: ${c}`)
      .join("\n");

    // Folder sizes
    const folderSizes = Object.entries(folderCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([f, c]) => `  ${f}: ${c} notes`)
      .join("\n");

    const report = [
      `# Vault Health Report — ${formatDate()}`,
      `\n## Overview`,
      `- Total notes: ${files.length}`,
      `- Total unique tags: ${Object.keys(tagCounts).length}`,
      `- Total folders: ${Object.keys(folderCounts).length}`,
      `\n## Issues`,
      `- Broken links: ${broken.length}`,
      `- Orphaned notes: ${orphans.length}`,
      `- Empty notes: ${empty.length}`,
      broken.length ? `\n### Broken Links\n${broken.join("\n")}` : "",
      orphans.length ? `\n### Orphaned Notes\n${orphans.join("\n")}` : "",
      empty.length ? `\n### Empty Notes\n${empty.join("\n")}` : "",
      `\n## Top Tags\n${topTags || "  none"}`,
      `\n## Notes by Folder\n${folderSizes}`,
    ].filter((s) => s !== "").join("\n");

    return { content: [{ type: "text", text: report }] };
  }
);

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
