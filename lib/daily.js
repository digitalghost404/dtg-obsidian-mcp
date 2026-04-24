import { z } from "zod";
import { fs, path, matter, DAILY_NOTES_FOLDER, VAULT_ROOT, notePath, collectMarkdownFiles, toRelative, formatDate, extractTags } from "./helpers.js";

export function registerDailyTools(server, cache) {
server.tool(
  "get_daily_note",
  "Read the daily note for today or a specific date.",
  { date: z.string().optional().describe("Date in YYYY-MM-DD format. Defaults to today.") },
  async ({ date }) => {
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be in YYYY-MM-DD format");
    const dateStr = date ?? formatDate();
    const relPath = path.join(DAILY_NOTES_FOLDER, `${dateStr}.md`);
    const content = await fs.readFile(await notePath(relPath), "utf-8");
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
    cache?.invalidate("*");
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be in YYYY-MM-DD format");
    const dateStr = date ?? formatDate();
    const relPath = path.join(DAILY_NOTES_FOLDER, `${dateStr}.md`);
    const fullPath = await notePath(relPath);
    try {
      await fs.access(fullPath);
      return { content: [{ type: "text", text: `Daily note already exists: ${relPath}` }] };
    } catch { /* doesn't exist — proceed */ }
    let content = `# ${dateStr}\n`;
    if (template) {
      const tmplRaw = await fs.readFile(await notePath(template), "utf-8");
      content = tmplRaw.replaceAll("{{date}}", dateStr).replaceAll("{{title}}", dateStr);
    }
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
    return { content: [{ type: "text", text: `Daily note created: ${relPath}` }] };
  }
);

server.tool(
  "get_recently_modified",
  "List notes modified within the last N days, most recent first.",
  { days: z.number().int().min(1).optional().describe("Lookback window in days. Defaults to 7.") },
  async ({ days = 7 }) => {
    const files = await collectMarkdownFiles(VAULT_ROOT);
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

server.tool(
  "generate_weekly_review",
  "Compile a weekly review report: notes created/modified, tasks completed and open, new tags, and most active folders.",
  {
    days: z.number().int().min(1).optional().describe("Lookback window in days. Defaults to 7."),
  },
  async ({ days = 7 }) => {
    const files = await collectMarkdownFiles(VAULT_ROOT);
    const cutoff = Date.now() - days * 86_400_000;

    const modified = [];
    const openTasks = [];
    const doneTasks = [];
    const newTags = new Set();
    const folderActivity = {};

    for (const file of files) {
      const { mtimeMs } = await fs.stat(file);
      const rel = toRelative(file);
      const raw = await fs.readFile(file, "utf-8");
      const parsed = matter(raw);

      // Tasks across entire vault (open) and within review window (done)
      for (const line of parsed.content.split("\n")) {
        if (/^(\s*)-\s+\[ \]\s+(.+)/.test(line)) openTasks.push({ rel, text: line.trim() });
        if (mtimeMs >= cutoff && /^(\s*)-\s+\[x\]\s+(.+)/i.test(line)) doneTasks.push({ rel, text: line.trim() });
      }

      if (mtimeMs >= cutoff) {
        modified.push({ rel, mtimeMs });
        const folder = path.dirname(rel);
        folderActivity[folder] = (folderActivity[folder] ?? 0) + 1;
        extractTags(parsed).forEach((t) => newTags.add(t));
      }
    }

    modified.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const topFolders = Object.entries(folderActivity).sort((a, b) => b[1] - a[1]).slice(0, 5);

    const report = [
      `# Weekly Review — ${formatDate()}`,
      `*Covering the last ${days} days*`,
      `\n## Activity`,
      `- Notes modified: ${modified.length}`,
      `- Open tasks (vault-wide): ${openTasks.length}`,
      `- Completed tasks (this period): ${doneTasks.length}`,
      modified.length ? `\n## Modified Notes\n${modified.slice(0, 20).map((n) => `- ${new Date(n.mtimeMs).toISOString().slice(0,10)}  ${n.rel}`).join("\n")}` : "",
      openTasks.length ? `\n## Open Tasks (first 20)\n${openTasks.slice(0, 20).map((t) => `- [ ] ${t.rel}: ${t.text.replace(/^\s*-\s+\[ \]\s+/i, "")}`).join("\n")}` : "",
      topFolders.length ? `\n## Most Active Folders\n${topFolders.map(([f, c]) => `- ${f}: ${c} notes`).join("\n")}` : "",
      newTags.size ? `\n## Tags Active This Period\n${[...newTags].join(", ")}` : "",
    ].filter((s) => s !== "").join("\n");

    return { content: [{ type: "text", text: report }] };
  }
);
}
