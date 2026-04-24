import { z } from "zod";
import { fs, VAULT_ROOT, notePath, collectMarkdownFiles, toRelative } from "./helpers.js";

function getCached(cache, key) {
  return cache?.get(key) ?? null;
}

export function registerTasksTools(server, cache) {
server.tool(
  "extract_tasks",
  "Scan the vault (or a specific note) for markdown checkboxes and return a consolidated task list.",
  {
    path: z.string().optional().describe("Vault-relative path to a single note. Omit to scan the entire vault."),
    status: z.enum(["all", "open", "done"]).optional().describe("Filter by task status. Defaults to 'all'."),
  },
  async ({ path: noteName, status = "all" }) => {
    const cacheKey = `extract_tasks:${JSON.stringify({ path: noteName, status })}`;
    const cached = getCached(cache, cacheKey);
    if (cached) return cached;

    const files = noteName ? [await notePath(noteName)] : await collectMarkdownFiles(VAULT_ROOT);
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

    const result = {
      content: [{ type: "text", text: results.length ? results.join("\n\n") : "No tasks found." }],
    };
    cache?.set(cacheKey, result, 30000);
    return result;
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
    cache?.invalidate("*");
    const fullPath = await notePath(noteName);
    const content = await fs.readFile(fullPath, "utf-8");
    const escaped = task_text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^(\\s*)-\\s+\\[ \\]\\s+${escaped}`, "m");
    const match = content.match(pattern);
    if (!match) throw new Error(`Open task not found: "${task_text}"`);
    const updated = content.replace(pattern, `$1- [x] ${task_text}`);
    await fs.writeFile(fullPath, updated, "utf-8");
    return { content: [{ type: "text", text: `Task completed: "${task_text}"` }] };
  }
);
}
