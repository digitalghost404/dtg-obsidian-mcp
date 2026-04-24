import { z } from "zod";
import { fs, matter, VAULT_ROOT, notePath, collectMarkdownFiles, formatDate, extractTags } from "./helpers.js";

function getCached(cache, key) {
  return cache?.get(key) ?? null;
}

export function registerFrontmatterTools(server, cache) {
server.tool(
  "get_frontmatter",
  "Parse and return the YAML frontmatter of a note as structured JSON.",
  { path: z.string().describe("Vault-relative path to the note.") },
  async ({ path: noteName }) => {
    const raw = await fs.readFile(await notePath(noteName), "utf-8");
    const data = matter(raw).data;
    // Normalize Date objects to YYYY-MM-DD strings
    const normalized = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, v instanceof Date ? formatDate(v) : v])
    );
    return { content: [{ type: "text", text: JSON.stringify(normalized, null, 2) }] };
  }
);

server.tool(
  "set_frontmatter",
  "Update specific frontmatter fields on a note. Existing fields not mentioned are preserved.",
  {
    path: z.string().describe("Vault-relative path to the note."),
    fields: z.record(z.string(), z.unknown()).describe("Key-value pairs to set in the frontmatter."),
  },
  async ({ path: noteName, fields }) => {
    cache?.invalidate("*");
    const fullPath = await notePath(noteName);
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
    const cacheKey = "list_tags";
    const cached = getCached(cache, cacheKey);
    if (cached) return cached;

    const files = await collectMarkdownFiles(VAULT_ROOT);
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
    const result = { content: [{ type: "text", text: sorted || "No tags found." }] };
    cache?.set(cacheKey, result, 30000);
    return result;
  }
);
}
