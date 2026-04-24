import { z } from "zod";
import { fs, path, matter, VAULT_ROOT, collectMarkdownFiles, toRelative, parseWikilinks, formatDate, extractTags } from "./helpers.js";

export function registerHealthTools(server) {
server.tool(
  "find_empty_notes",
  "Find notes that have no meaningful content (empty body or only frontmatter).",
  {},
  async () => {
    const files = await collectMarkdownFiles(VAULT_ROOT);
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
    const files = await collectMarkdownFiles(VAULT_ROOT);
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
}
