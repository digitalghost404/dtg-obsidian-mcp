import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import matter from "gray-matter";

export const execFileAsync = promisify(execFile);

if (!process.env.VAULT_PATH) {
  throw new Error("VAULT_PATH environment variable is required. Set it to the absolute path of your Obsidian vault.");
}
export const VAULT_PATH = process.env.VAULT_PATH;
export const DAILY_NOTES_FOLDER = process.env.DAILY_NOTES_FOLDER ?? "Daily Notes";
export const TEMPLATES_FOLDER = process.env.TEMPLATES_FOLDER ?? "Templates";

export const VAULT_ROOT = path.resolve(VAULT_PATH);
export let REAL_VAULT_ROOT;
try { REAL_VAULT_ROOT = await fs.realpath(VAULT_ROOT); } catch { REAL_VAULT_ROOT = VAULT_ROOT; }

export function isWithinVault(targetPath, root = VAULT_ROOT) {
  return targetPath === root || targetPath.startsWith(root + path.sep);
}

/** Resolve a note path safely within the vault (prevents path traversal and symlink escape). */
export async function notePath(relativePath) {
  const resolved = path.resolve(VAULT_ROOT, relativePath);
  if (!isWithinVault(resolved, VAULT_ROOT)) {
    throw new Error("Path is outside the vault");
  }
  try {
    const real = await fs.realpath(resolved);
    if (!isWithinVault(real, REAL_VAULT_ROOT)) {
      throw new Error("Path is outside the vault (symlink escape)");
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return resolved;
}

/** Recursively collect all .md files under a directory. */
export async function collectMarkdownFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") throw new Error(`Folder not found: ${dir}`);
    throw e;
  }
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      files.push(...(await collectMarkdownFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

/** Recursively collect all subdirectories under a directory. */
export async function collectFolders(dir, baseDir = dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") throw new Error(`Folder not found: ${dir}`);
    throw e;
  }
  const folders = [];
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      const fullPath = path.join(dir, entry.name);
      folders.push(path.relative(baseDir, fullPath));
      folders.push(...(await collectFolders(fullPath, baseDir)));
    }
  }
  return folders;
}

/** Convert an absolute vault file path to a vault-relative path. */
export function toRelative(absolutePath) {
  return path.relative(VAULT_ROOT, absolutePath);
}

/** Extract [[wikilinks]] from content. */
export function parseWikilinks(content) {
  const matches = [...content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)];
  return [...new Set(matches.map((m) => m[1].trim()))];
}

/** Format today or a given date as YYYY-MM-DD (local time for new dates, UTC for Date objects from frontmatter). */
export function formatDate(date) {
  if (!date) {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  if (date instanceof Date) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }
  return String(date).slice(0, 10);
}

/** Parse tags from frontmatter and inline #tags in content. */
export function extractTags(parsedMatter) {
  const tags = new Set();
  const fmTags = parsedMatter.data.tags;
  if (Array.isArray(fmTags)) fmTags.forEach((t) => tags.add(String(t).toLowerCase()));
  else if (typeof fmTags === "string") fmTags.split(/[\s,]+/).filter(Boolean).forEach((t) => tags.add(t.toLowerCase()));
  const inlineMatches = [...parsedMatter.content.matchAll(/#([\w/-]+)/g)];
  inlineMatches.forEach((m) => tags.add(m[1].toLowerCase()));
  return [...tags];
}

/** Sanitize a string for use as a filename stem. */
export function slugify(str) {
  return str.replace(/[\/\\?%*:|"<>]/g, "-").trim() || "untitled";
}

export const STOP_WORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for","of","with","by",
  "from","is","was","are","were","be","been","being","have","has","had","do",
  "does","did","will","would","could","should","may","might","must","shall",
  "can","that","this","these","those","it","its","i","you","he","she","we",
  "they","what","which","who","how","when","where","why","not","no","so","if",
  "as","up","out","about","into","than","then","there","their","my","your",
  "his","her","our","just","also","more","some","any","all","each","both",
  "few","other","such","same","own","new","first","last","much","many","very",
]);

export function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

export function jaccardSimilarity(setA, setB) {
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

/** Build a stem→[linked stems] adjacency map for the whole vault. */
export async function buildLinkGraph(files) {
  const graph = {};
  for (const file of files) {
    const stem = path.basename(file, ".md").toLowerCase();
    const content = await fs.readFile(file, "utf-8");
    graph[stem] = parseWikilinks(content).map((l) => l.toLowerCase());
  }
  return graph;
}

/** BFS to find shortest wikilink path between two note stems. */
export function bfsPath(graph, startStem, endStem) {
  const queue = [[startStem]];
  const visited = new Set([startStem]);
  while (queue.length) {
    const route = queue.shift();
    const current = route[route.length - 1];
    for (const neighbor of graph[current] ?? []) {
      if (visited.has(neighbor)) continue;
      const newPath = [...route, neighbor];
      if (neighbor === endStem) return newPath;
      visited.add(neighbor);
      queue.push(newPath);
    }
  }
  return null;
}

export const QUALITY_RUBRIC = [
  { label: "Has frontmatter", points: 15, check: (d) => Object.keys(d.data).length > 0 },
  { label: "Has tags", points: 15, check: (d) => !!d.data.tags },
  { label: "Has date field", points: 5, check: (d) => !!d.data.date },
  { label: "Has title heading", points: 10, check: (d) => /^# .+/m.test(d.content) },
  { label: "Has body content", points: 20, check: (d) => d.content.trim().length > 0 },
  { label: "Body ≥ 100 words", points: 15, check: (d) => tokenize(d.content).length >= 100 },
  { label: "Has outgoing links", points: 10, check: (d, raw) => parseWikilinks(raw).length > 0 },
  { label: "Has summary field", points: 5, check: (d) => !!d.data.summary },
  { label: "Has no broken H-levels", points: 5, check: (d) => {
    const levels = d.content.split("\n").filter((l) => /^#{1,6}\s/.test(l)).map((h) => h.match(/^(#+)/)[1].length);
    for (let i = 1; i < levels.length; i++) if (levels[i] - levels[i-1] > 1) return false;
    return true;
  }},
];
export const QUALITY_MAX = QUALITY_RUBRIC.reduce((s, r) => s + r.points, 0);

export { fs, path, matter };
