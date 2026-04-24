import { z } from "zod";
import { fs, VAULT_ROOT, notePath, collectMarkdownFiles, toRelative, formatDate, extractTags, matter } from "./helpers.js";

function getCached(cache, key) {
  return cache?.get(key) ?? null;
}

export function registerSearchTools(server, cache) {
server.tool(
  "search_notes",
  "Search note contents and filenames for a query string (case-insensitive).",
  { query: z.string().min(1).describe("Text to search for.") },
  async ({ query }) => {
    const cacheKey = `search_notes:${JSON.stringify({ query })}`;
    const cached = getCached(cache, cacheKey);
    if (cached) return cached;

    const files = await collectMarkdownFiles(VAULT_ROOT);
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
    const result = { content: [{ type: "text", text: results.length ? results.join("\n\n") : "No matches found." }] };
    cache?.set(cacheKey, result, 30000);
    return result;
  }
);

server.tool(
  "search_by_tag",
  "Find all notes that contain one or more specified tags (frontmatter or inline #tag).",
  {
    tags: z.array(z.string()).min(1).describe("Tags to search for (without the # prefix)."),
    match: z.enum(["any", "all"]).optional().describe("'any': at least one tag matches. 'all': all tags must match. Defaults to 'any'."),
  },
  async ({ tags, match = "any" }) => {
    const files = await collectMarkdownFiles(VAULT_ROOT);
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
  { criteria: z.record(z.string(), z.unknown()).describe("Key-value pairs that must match the note's frontmatter.") },
  async ({ criteria }) => {
    const files = await collectMarkdownFiles(VAULT_ROOT);
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
    limit: z.number().int().min(1).optional().describe("Maximum number of results to return."),
  },
  async ({ where, sort_by, sort_order = "asc", limit }) => {
    const cacheKey = `query_notes:${JSON.stringify({ where, sort_by, sort_order, limit })}`;
    const cached = getCached(cache, cacheKey);
    if (cached) return cached;

    const files = await collectMarkdownFiles(VAULT_ROOT);
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
      if (passes) {
        const normalized = Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, v instanceof Date ? formatDate(v) : v])
        );
        results.push({ rel: toRelative(file), data: normalized });
      }
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

    const result = {
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
    cache?.set(cacheKey, result, 30000);
    return result;
  }
);

server.tool(
  "get_timeline",
  "List notes sorted chronologically by a date frontmatter field.",
  {
    date_field: z.string().optional().describe("Frontmatter field containing the date. Defaults to 'date'."),
    order: z.enum(["asc", "desc"]).optional().describe("Sort order. Defaults to 'desc' (newest first)."),
    limit: z.number().int().min(1).optional().describe("Maximum number of results."),
    folder: z.string().optional().describe("Limit to a specific folder."),
  },
  async ({ date_field = "date", order = "desc", limit, folder }) => {
    const searchRoot = folder ? await notePath(folder) : VAULT_ROOT;
    const files = await collectMarkdownFiles(searchRoot);
    const entries = [];

    for (const file of files) {
      const { data } = matter(await fs.readFile(file, "utf-8"));
      if (data[date_field]) {
        const raw = data[date_field];
        const date = raw instanceof Date ? formatDate(raw) : String(raw).slice(0, 10);
        entries.push({ rel: toRelative(file), date, data });
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
}
