import { z } from "zod";
import { fs, path, VAULT_ROOT, notePath, collectMarkdownFiles, toRelative, parseWikilinks, buildLinkGraph, bfsPath } from "./helpers.js";

function getCached(cache, key) {
  return cache?.get(key) ?? null;
}

export function registerLinksTools(server, cache) {
server.tool(
  "get_outgoing_links",
  "Return all [[wikilinks]] found in a note.",
  { path: z.string().describe("Vault-relative path to the note.") },
  async ({ path: noteName }) => {
    const content = await fs.readFile(await notePath(noteName), "utf-8");
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
    const files = await collectMarkdownFiles(VAULT_ROOT);
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
    const cacheKey = "get_orphans";
    const cached = getCached(cache, cacheKey);
    if (cached) return cached;

    const files = await collectMarkdownFiles(VAULT_ROOT);
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
    const result = { content: [{ type: "text", text: orphans.length ? orphans.join("\n") : "No orphaned notes found." }] };
    cache?.set(cacheKey, result, 60000);
    return result;
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
    const files = await collectMarkdownFiles(VAULT_ROOT);
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
  "find_broken_links",
  "List all [[wikilinks]] that point to notes that don't exist in the vault.",
  {},
  async () => {
    const cacheKey = "find_broken_links";
    const cached = getCached(cache, cacheKey);
    if (cached) return cached;

    const files = await collectMarkdownFiles(VAULT_ROOT);
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

    const result = {
      content: [{
        type: "text",
        text: broken.length ? broken.join("\n") : "No broken links found.",
      }],
    };
    cache?.set(cacheKey, result, 60000);
    return result;
  }
);
}
