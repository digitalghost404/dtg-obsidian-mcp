import { z } from "zod";
import { fs, VAULT_ROOT, notePath, collectMarkdownFiles, toRelative, matter, extractTags } from "./helpers.js";

export function registerBulkTools(server, cache) {
  server.tool(
    "bulk_tag",
    "Add or remove tags across multiple notes matching a search query.",
    {
      query: z.string().min(1).describe("Search query to find notes (matches filename or content)."),
      tags: z.array(z.string()).optional().describe("Tags to add (without # prefix)."),
      remove_tags: z.array(z.string()).optional().describe("Tags to remove (without # prefix)."),
      dry_run: z.boolean().optional().default(false).describe("Preview changes without applying."),
    },
    async ({ query, tags = [], remove_tags = [], dry_run }) => {
      const files = await collectMarkdownFiles(VAULT_ROOT);
      const lowerQuery = query.toLowerCase();
      const matched = [];

      for (const file of files) {
        const content = await fs.readFile(file, "utf-8");
        const relativePath = toRelative(file);
        if (relativePath.toLowerCase().includes(lowerQuery) || content.toLowerCase().includes(lowerQuery)) {
          matched.push({ file, relativePath, content });
        }
      }

      if (!matched.length) {
        return { content: [{ type: "text", text: "No notes matched the query." }] };
      }

      const results = [];
      let applied = 0;

      for (const { file, relativePath, content } of matched) {
        const parsed = matter(content);
        const currentTags = extractTags(parsed);
        const newTags = new Set(currentTags);

        for (const tag of tags) newTags.add(tag);
        for (const tag of remove_tags) newTags.delete(tag);

        const finalTags = Array.from(newTags).sort();
        const changed = JSON.stringify(currentTags.sort()) !== JSON.stringify(finalTags);

        if (changed) {
          results.push({
            path: relativePath,
            oldTags: currentTags.sort(),
            newTags: finalTags,
          });

          if (!dry_run) {
            cache?.invalidate("*");
            parsed.data.tags = finalTags.length ? finalTags : undefined;
            if (!parsed.data.tags) delete parsed.data.tags;
            await fs.writeFile(file, matter.stringify(parsed.content, parsed.data), "utf-8");
            applied++;
          }
        }
      }

      const action = dry_run ? "Would update" : "Updated";
      const text = results.length
        ? `${action} ${results.length} note(s):\n${results.map((r) => `  ${r.path}: [${r.oldTags.join(", ")}] → [${r.newTags.join(", ")}]`).join("\n")}`
        : "No tag changes needed.";

      return { content: [{ type: "text", text }] };
    }
  );
}
