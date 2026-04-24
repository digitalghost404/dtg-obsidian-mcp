import { z } from "zod";
import { fs, path, matter, notePath, slugify } from "./helpers.js";

export function registerSurgeryTools(server, cache) {
server.tool(
  "merge_notes",
  "Merge multiple notes into a single destination note.",
  {
    sources: z.array(z.string()).min(1).describe("Ordered list of vault-relative source note paths."),
    destination: z.string().describe("Vault-relative path for the merged note."),
    strip_frontmatter: z.boolean().optional().describe("If true, omit frontmatter from all but the first note. Defaults to true."),
    separator: z.string().optional().describe("Markdown separator inserted between merged notes. Defaults to '\\n---\\n'."),
  },
  async ({ sources, destination, strip_frontmatter = true, separator = "\n---\n" }) => {
    cache?.invalidate("*");
    const destPath = await notePath(destination);
    try {
      await fs.access(destPath);
      throw new Error(`Destination already exists: ${destination}. Delete it first or choose a different path.`);
    } catch (e) {
      if (e.message.startsWith("Destination already exists")) throw e;
    }
    const parts = [];
    for (let i = 0; i < sources.length; i++) {
      const raw = await fs.readFile(await notePath(sources[i]), "utf-8");
      if (i > 0 && strip_frontmatter) {
        parts.push(matter(raw).content.trim());
      } else {
        parts.push(raw.trim());
      }
    }
    const merged = parts.join(separator);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, merged + "\n", "utf-8");
    return { content: [{ type: "text", text: `Merged ${sources.length} notes into: ${destination}` }] };
  }
);

server.tool(
  "split_note",
  "Split a note into multiple notes at a given heading level. Each section becomes its own file. The original note is preserved unchanged. Content before the first matching heading is not included in any split file.",
  {
    path: z.string().describe("Vault-relative path to the note to split."),
    heading_level: z.number().int().min(1).max(6).optional().describe("Heading level to split at (1–6). Defaults to 2."),
    destination_folder: z.string().optional().describe("Vault-relative folder for the new notes. Defaults to same folder as the source note."),
  },
  async ({ path: noteName, heading_level = 2, destination_folder }) => {
    cache?.invalidate("*");
    const fullPath = await notePath(noteName);
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

    // Check for pre-heading content that won't be included in any split file
    const firstHeadingIdx = content.split("\n").findIndex((l) => l.startsWith(marker) && !l.startsWith(marker + "#"));
    const preHeading = content.split("\n").slice(0, firstHeadingIdx).join("\n").trim();
    const droppedWarning = preHeading ? `\n\n⚠ Note: ${preHeading.split("\n").length} line(s) of content before the first heading were not included in any split file.` : "";

    const created = [];
    const usedNames = new Set();
    for (const section of sections) {
      let baseName = slugify(section.title);
      let filename = `${baseName}.md`;
      let suffix = 2;
      while (usedNames.has(filename.toLowerCase())) {
        filename = `${baseName}_${suffix}.md`;
        suffix++;
      }
      usedNames.add(filename.toLowerCase());
      const relPath = path.join(destFolder, filename);
      const sectionPath = await notePath(relPath);
      try {
        await fs.access(sectionPath);
        throw new Error(`Split would overwrite existing note: ${relPath}. Delete it first or use a different destination folder.`);
      } catch (e) {
        if (e.message.startsWith("Split would overwrite")) throw e;
      }
      await fs.mkdir(path.dirname(sectionPath), { recursive: true });
      await fs.writeFile(sectionPath, section.content + "\n", "utf-8");
      created.push(relPath);
    }

    return {
      content: [{
        type: "text",
        text: `Split into ${created.length} notes:\n${created.join("\n")}${droppedWarning}`,
      }],
    };
  }
);
}
