import { z } from "zod";
import { fs, path, matter, VAULT_ROOT, notePath, collectMarkdownFiles, toRelative, parseWikilinks, tokenize, jaccardSimilarity, buildLinkGraph } from "./helpers.js";

function getCached(cache, key) {
  return cache?.get(key) ?? null;
}

export function registerGraphTools(server, cache) {
server.tool(
  "find_duplicates",
  "Identify pairs of notes with highly similar content using Jaccard similarity. Returns pairs above the similarity threshold.",
  {
    threshold: z.number().min(0).max(1).optional().describe("Similarity threshold between 0 and 1. Defaults to 0.5."),
    folder: z.string().optional().describe("Limit search to a specific folder."),
  },
  async ({ threshold = 0.5, folder }) => {
    const cacheKey = `find_duplicates:${JSON.stringify({ threshold, folder })}`;
    const cached = getCached(cache, cacheKey);
    if (cached) return cached;

    const searchRoot = folder ? await notePath(folder) : VAULT_ROOT;
    const files = await collectMarkdownFiles(searchRoot);

    // Pre-tokenize all files
    const tokenSets = [];
    for (const f of files) {
      const raw = await fs.readFile(f, "utf-8");
      tokenSets.push(new Set(tokenize(matter(raw).content)));
    }

    const pairs = [];
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const sim = jaccardSimilarity(tokenSets[i], tokenSets[j]);
        if (sim >= threshold) {
          pairs.push({
            a: toRelative(files[i]),
            b: toRelative(files[j]),
            similarity: Math.round(sim * 1000) / 1000,
          });
        }
      }
    }

    pairs.sort((a, b) => b.similarity - a.similarity);

    const result = {
      content: [{
        type: "text",
        text: pairs.length
          ? pairs.map((p) => `${p.similarity} — "${p.a}" ↔ "${p.b}"`).join("\n")
          : `No duplicate pairs found above threshold ${threshold}.`,
      }],
    };
    cache?.set(cacheKey, result, 120000);
    return result;
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// VAULT INTELLIGENCE
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  "get_graph_stats",
  "Return vault-wide graph statistics: note count, link counts, most-connected notes, and isolated clusters.",
  {},
  async () => {
    const cacheKey = "get_graph_stats";
    const cached = getCached(cache, cacheKey);
    if (cached) return cached;

    const files = await collectMarkdownFiles(VAULT_ROOT);
    const graph = await buildLinkGraph(files);

    const inDegree = {};
    const outDegree = {};
    for (const [stem, links] of Object.entries(graph)) {
      outDegree[stem] = links.length;
      for (const link of links) {
        inDegree[link] = (inDegree[link] ?? 0) + 1;
      }
    }

    const stems = Object.keys(graph);
    const totalLinks = Object.values(outDegree).reduce((a, b) => a + b, 0);
    const avgConnections = stems.length ? (totalLinks / stems.length).toFixed(2) : 0;

    const topByIn = Object.entries(inDegree)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([s, c]) => `  ${s} (${c} backlinks)`);

    const topByOut = [...stems]
      .sort((a, b) => (outDegree[b] ?? 0) - (outDegree[a] ?? 0))
      .slice(0, 5)
      .map((s) => `  ${s} (${outDegree[s]} outgoing)`);

    const isolated = stems.filter((s) => !inDegree[s] && !outDegree[s]);

    const stats = [
      `**Total notes:** ${files.length}`,
      `**Total links:** ${totalLinks}`,
      `**Avg connections per note:** ${avgConnections}`,
      `\n**Most linked-to (by backlinks):**\n${topByIn.join("\n") || "  none"}`,
      `\n**Most outgoing links:**\n${topByOut.join("\n") || "  none"}`,
      `\n**Isolated notes (no links):** ${isolated.length}`,
    ].join("\n");

    const result = { content: [{ type: "text", text: stats }] };
    cache?.set(cacheKey, result, 60000);
    return result;
  }
);

server.tool(
  "get_hub_notes",
  "Return the most-linked-to notes in the vault (the knowledge graph's pillars), ranked by backlink count.",
  { limit: z.number().int().min(1).optional().describe("Number of hub notes to return. Defaults to 10.") },
  async ({ limit = 10 }) => {
    const cacheKey = `get_hub_notes:${JSON.stringify({ limit })}`;
    const cached = getCached(cache, cacheKey);
    if (cached) return cached;

    const files = await collectMarkdownFiles(VAULT_ROOT);
    const inDegree = {};
    for (const file of files) {
      const content = await fs.readFile(file, "utf-8");
      for (const link of parseWikilinks(content)) {
        const key = link.toLowerCase();
        inDegree[key] = (inDegree[key] ?? 0) + 1;
      }
    }

    const hubs = Object.entries(inDegree)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([stem, count]) => `${stem}: ${count} backlinks`);

    const result = { content: [{ type: "text", text: hubs.length ? hubs.join("\n") : "No links found in vault." }] };
    cache?.set(cacheKey, result, 60000);
    return result;
  }
);

server.tool(
  "cluster_notes",
  "Group all vault notes into thematic clusters based on shared vocabulary. Uses union-find on Jaccard similarity.",
  {
    threshold: z.number().min(0).max(1).optional().describe("Minimum similarity to place two notes in the same cluster (0–1). Defaults to 0.15."),
    folder: z.string().optional().describe("Limit clustering to a specific folder."),
    min_cluster_size: z.number().int().min(1).optional().describe("Only return clusters with at least this many notes. Defaults to 2."),
  },
  async ({ threshold = 0.15, folder, min_cluster_size = 2 }) => {
    const cacheKey = `cluster_notes:${JSON.stringify({ threshold, folder, min_cluster_size })}`;
    const cached = getCached(cache, cacheKey);
    if (cached) return cached;

    const searchRoot = folder ? await notePath(folder) : VAULT_ROOT;
    const files = await collectMarkdownFiles(searchRoot);

    const tokenSets = [];
    for (const f of files) {
      tokenSets.push(new Set(tokenize(matter(await fs.readFile(f, "utf-8")).content)));
    }

    // Union-Find (iterative to avoid stack overflow on large vaults)
    const parent = files.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (i, j) => { parent[find(i)] = find(j); };

    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        if (jaccardSimilarity(tokenSets[i], tokenSets[j]) >= threshold) union(i, j);
      }
    }

    const clusters = {};
    for (let i = 0; i < files.length; i++) {
      const root = find(i);
      (clusters[root] ??= []).push(toRelative(files[i]));
    }

    const clustersResult = Object.values(clusters)
      .filter((c) => c.length >= min_cluster_size)
      .sort((a, b) => b.length - a.length);

    const result = {
      content: [{
        type: "text",
        text: clustersResult.length
          ? clustersResult.map((c, i) => `**Cluster ${i + 1}** (${c.length} notes):\n${c.map((r) => `  - ${r}`).join("\n")}`).join("\n\n")
          : `No clusters found at threshold ${threshold}.`,
      }],
    };
    cache?.set(cacheKey, result, 120000);
    return result;
  }
);
}
