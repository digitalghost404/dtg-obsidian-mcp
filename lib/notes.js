import { z } from "zod";
import { fs, path, VAULT_ROOT, notePath, collectMarkdownFiles, toRelative, parseWikilinks } from "./helpers.js";

export function registerNotesTools(server, cache) {
server.tool(
  "list_notes",
  "List all notes in the Obsidian vault. Optionally filter by folder.",
  { folder: z.string().optional().describe("Subfolder to list (e.g. 'Projects'). Omit for all notes.") },
  async ({ folder }) => {
    const searchRoot = folder ? await notePath(folder) : VAULT_ROOT;
    const files = await collectMarkdownFiles(searchRoot);
    return { content: [{ type: "text", text: files.map(toRelative).join("\n") || "No notes found." }] };
  }
);

server.tool(
  "read_note",
  "Read the full content of a note by its vault-relative path.",
  { path: z.string().describe("Vault-relative path to the note.") },
  async ({ path: noteName }) => {
    const content = await fs.readFile(await notePath(noteName), "utf-8");
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
    cache?.invalidate("*");
    const fullPath = await notePath(noteName);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
    return { content: [{ type: "text", text: `Note written: ${noteName}` }] };
  }
);

server.tool(
  "delete_note",
  "Delete a note by its vault-relative path. This is irreversible. Reports any notes that still link to it (dangling backlinks).",
  { path: z.string().describe("Vault-relative path to the note to delete.") },
  async ({ path: noteName }) => {
    cache?.invalidate("*");
    const targetPath = await notePath(noteName);
    // Validate target exists before scanning vault for backlinks
    await fs.access(targetPath);

    const stem = path.basename(noteName, ".md").toLowerCase();
    const normalizedTarget = path.normalize(noteName);
    const files = await collectMarkdownFiles(VAULT_ROOT);
    const danglingIn = [];
    for (const file of files) {
      if (path.normalize(toRelative(file)) === normalizedTarget) continue;
      const links = parseWikilinks(await fs.readFile(file, "utf-8")).map((l) => l.toLowerCase());
      if (links.includes(stem)) danglingIn.push(toRelative(file));
    }

    await fs.unlink(targetPath);

    let msg = `Deleted: ${noteName}`;
    if (danglingIn.length) {
      msg += `\n\n⚠ Warning: ${danglingIn.length} note(s) still link to this note (now broken):\n${danglingIn.map((n) => `  - ${n}`).join("\n")}`;
    }
    return { content: [{ type: "text", text: msg }] };
  }
);

server.tool(
  "rename_note",
  "Rename or move a note to a new vault-relative path. Automatically updates [[wikilinks]] in other notes that reference the old name.",
  {
    from: z.string().describe("Current vault-relative path."),
    to: z.string().describe("New vault-relative path."),
  },
  async ({ from, to }) => {
    cache?.invalidate("*");
    const fromPath = await notePath(from);
    await fs.access(fromPath);
    const toPath = await notePath(to);
    // Check destination doesn't already exist
    try {
      await fs.access(toPath);
      throw new Error(`Destination already exists: ${to}. Delete it first or choose a different name.`);
    } catch (e) {
      if (e.message.startsWith("Destination already exists")) throw e;
    }
    await fs.mkdir(path.dirname(toPath), { recursive: true });
    await fs.rename(fromPath, toPath);

    // Update backlinks in other notes
    const oldStem = path.basename(from, ".md");
    const newStem = path.basename(to, ".md");
    let updatedCount = 0;
    if (oldStem !== newStem) {
      const files = await collectMarkdownFiles(VAULT_ROOT);
      const normalizedTo = path.normalize(toRelative(toPath));
      const escapedStem = oldStem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      for (const file of files) {
        if (path.normalize(toRelative(file)) === normalizedTo) continue;
        const content = await fs.readFile(file, "utf-8");
        const linkPattern = new RegExp(`\\[\\[${escapedStem}(\\|[^\\]]*)?\\]\\]`, "gi");
        const updated = content.replace(linkPattern, `[[${newStem}$1]]`);
        if (updated !== content) {
          await fs.writeFile(file, updated, "utf-8");
          updatedCount++;
        }
      }
    }

    const backlinkMsg = updatedCount ? ` Updated backlinks in ${updatedCount} note(s).` : "";
    return { content: [{ type: "text", text: `Moved: ${from} → ${to}${backlinkMsg}` }] };
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
    cache?.invalidate("*");
    const fullPath = await notePath(noteName);
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
    cache?.invalidate("*");
    const fullPath = await notePath(noteName);
    const content = await fs.readFile(fullPath, "utf-8");
    if (!search) throw new Error("Search string cannot be empty");
    if (!content.includes(search)) throw new Error(`Search string not found in ${noteName}`);
    const parts = content.split(search);
    const count = replace_all ? parts.length - 1 : 1;
    const updated = replace_all ? parts.join(replace) : content.replace(search, replace);
    await fs.writeFile(fullPath, updated, "utf-8");
    return { content: [{ type: "text", text: `Patched ${count} occurrence(s) in: ${noteName}` }] };
  }
);
}
