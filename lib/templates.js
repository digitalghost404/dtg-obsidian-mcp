import { z } from "zod";
import { fs, path, TEMPLATES_FOLDER, notePath, collectMarkdownFiles, toRelative, formatDate } from "./helpers.js";

export function registerTemplatesTools(server, cache) {
server.tool(
  "list_templates",
  "List all notes in the Templates folder.",
  {},
  async () => {
    try {
      const tmplRoot = await notePath(TEMPLATES_FOLDER);
      const files = await collectMarkdownFiles(tmplRoot);
      return { content: [{ type: "text", text: files.map(toRelative).join("\n") || "No templates found." }] };
    } catch {
      return { content: [{ type: "text", text: "No templates found. Templates folder does not exist." }] };
    }
  }
);

server.tool(
  "create_from_template",
  "Create a new note from a template, substituting {{title}}, {{date}}, and custom {{key}} placeholders.",
  {
    template: z.string().describe("Vault-relative path to the template note."),
    destination: z.string().describe("Vault-relative path for the new note."),
    title: z.string().optional().describe("Value for {{title}}. Defaults to the destination filename stem."),
    extra_vars: z.record(z.string(), z.string()).optional().describe("Additional {{key}} substitutions. Keys 'title' and 'date' are reserved."),
  },
  async ({ template, destination, title, extra_vars = {} }) => {
    cache?.invalidate("*");
    const destPath = await notePath(destination);
    try {
      await fs.access(destPath);
      throw new Error(`Destination already exists: ${destination}. Use write_note to overwrite.`);
    } catch (e) {
      if (e.message.startsWith("Destination already exists")) throw e;
      /* doesn't exist — proceed */
    }
    const raw = await fs.readFile(await notePath(template), "utf-8");
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
}
