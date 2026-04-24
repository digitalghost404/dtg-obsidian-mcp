import { z } from "zod";
import { fs, path, matter, VAULT_ROOT, notePath, collectMarkdownFiles, toRelative, parseWikilinks, formatDate, extractTags, tokenize, jaccardSimilarity, execFileAsync, QUALITY_RUBRIC, QUALITY_MAX } from "./helpers.js";

export function registerAiTools(server) {
server.tool(
  "summarize_note",
  "Extract a structural outline of a note: headings, first sentence of each section, word count, and reading time. Use this as the basis for generating a summary.",
  { path: z.string().describe("Vault-relative path to the note.") },
  async ({ path: noteName }) => {
    const raw = await fs.readFile(await notePath(noteName), "utf-8");
    const { content, data } = matter(raw);
    const lines = content.split("\n");
    const words = tokenize(content).length;
    const readingTimeMins = Math.ceil(words / 200);

    const outline = [];
    let buffer = [];

    const flushBuffer = () => {
      const sentence = buffer.join(" ").replace(/\s+/g, " ").trim();
      if (sentence) {
        const first = sentence.match(/[^.!?]+[.!?]*/)?.[0]?.trim() ?? sentence.slice(0, 120);
        outline.push(`  → ${first}`);
      }
      buffer = [];
    };

    for (const line of lines) {
      if (/^#{1,6}\s/.test(line)) {
        flushBuffer();
        outline.push(line);
      } else if (line.trim()) {
        buffer.push(line.trim());
      } else {
        flushBuffer();
      }
    }
    flushBuffer();

    const meta = [
      `**Words:** ${words}`,
      `**Reading time:** ~${readingTimeMins} min`,
      data.tags ? `**Tags:** ${[].concat(data.tags).join(", ")}` : null,
      data.summary ? `**Existing summary:** ${data.summary}` : null,
    ].filter(Boolean).join(" | ");

    return {
      content: [{
        type: "text",
        text: `## Outline: ${path.basename(noteName, ".md")}\n${meta}\n\n${outline.join("\n")}`,
      }],
    };
  }
);

server.tool(
  "suggest_links",
  "Suggest existing vault notes that the given note should link to, based on content and title overlap. Returns ranked candidates not already linked.",
  {
    path: z.string().describe("Vault-relative path to the note."),
    limit: z.number().int().min(1).optional().describe("Max suggestions to return. Defaults to 10."),
  },
  async ({ path: noteName, limit = 10 }) => {
    const fullPath = await notePath(noteName);
    const sourceRaw = await fs.readFile(fullPath, "utf-8");
    const sourceTokens = new Set(tokenize(matter(sourceRaw).content));
    const sourceLinks = new Set(parseWikilinks(sourceRaw).map((l) => l.toLowerCase()));
    const sourceStem = path.basename(noteName, ".md").toLowerCase();

    const files = await collectMarkdownFiles(VAULT_ROOT);
    const candidates = [];

    for (const file of files) {
      const rel = toRelative(file);
      const stem = path.basename(rel, ".md").toLowerCase();
      if (stem === sourceStem || sourceLinks.has(stem)) continue; // skip self and already-linked

      const raw = await fs.readFile(file, "utf-8");
      const titleTokens = new Set(tokenize(stem));
      const contentTokens = new Set(tokenize(matter(raw).content));

      // Score: weighted combination of title overlap and content overlap
      const titleScore = jaccardSimilarity(sourceTokens, titleTokens) * 3; // title match weighted 3×
      const contentScore = jaccardSimilarity(sourceTokens, contentTokens);
      const score = titleScore + contentScore;

      if (score > 0.02) candidates.push({ rel, score: Math.round(score * 1000) / 1000 }); // noise floor — skip near-zero similarity
    }

    candidates.sort((a, b) => b.score - a.score);
    const top = candidates.slice(0, limit);

    return {
      content: [{
        type: "text",
        text: top.length
          ? top.map((c) => `${c.rel} (score: ${c.score})`).join("\n")
          : "No link suggestions found.",
      }],
    };
  }
);

server.tool(
  "generate_moc",
  "Generate a Map of Contents (MOC) note for a folder, listing all notes with their tags and first paragraph.",
  {
    folder: z.string().describe("Vault-relative folder to generate the MOC for."),
    destination: z.string().optional().describe("Vault-relative path to write the MOC note. Omit to return without saving."),
  },
  async ({ folder, destination }) => {
    const searchRoot = await notePath(folder);
    const files = await collectMarkdownFiles(searchRoot);

    const sections = [];
    for (const file of files) {
      const rel = toRelative(file);
      const raw = await fs.readFile(file, "utf-8");
      const { content, data } = matter(raw);
      const title = path.basename(rel, ".md");
      const tags = data.tags ? [].concat(data.tags).map((t) => `#${t}`).join(" ") : "";
      const firstPara = content.split(/\n\n+/).find((p) => p.trim() && !/^#/.test(p))?.trim().slice(0, 200) ?? "";
      sections.push(`### [[${title}]]\n${tags ? `${tags}\n` : ""}${firstPara ? `${firstPara}…` : ""}`);
    }

    const moc = `# Map of Contents — ${folder}\n*Generated: ${formatDate()}*\n\n${sections.join("\n\n")}`;

    if (destination) {
      const destPath = await notePath(destination);
      try { await fs.access(destPath); throw new Error(`Destination already exists: ${destination}. Use write_note to overwrite.`); }
      catch (e) { if (e.message.startsWith("Destination already exists")) throw e; }
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, moc, "utf-8");
      return { content: [{ type: "text", text: `MOC written to: ${destination}` }] };
    }

    return { content: [{ type: "text", text: moc }] };
  }
);

server.tool(
  "find_knowledge_gaps",
  "Identify concepts mentioned in a note (bold terms, capitalized phrases, wikilinks) that don't have a corresponding note in the vault.",
  {
    path: z.string().describe("Vault-relative path to the note to analyse."),
  },
  async ({ path: noteName }) => {
    const files = await collectMarkdownFiles(VAULT_ROOT);
    const existingStems = new Set(files.map((f) => path.basename(f, ".md").toLowerCase()));
    const raw = await fs.readFile(await notePath(noteName), "utf-8");
    const { content } = matter(raw);

    const candidates = new Set();

    // Explicit wikilinks that don't resolve
    for (const link of parseWikilinks(raw)) {
      if (!existingStems.has(link.toLowerCase())) candidates.add(link);
    }

    // Bold terms  (**term** or __term__)
    for (const [, term] of content.matchAll(/\*\*([^*]{2,40})\*\*/g)) candidates.add(term.trim());
    for (const [, term] of content.matchAll(/__([^_]{2,40})__/g)) candidates.add(term.trim());

    // Capitalised multi-word phrases (not at line start)
    for (const [, phrase] of content.matchAll(/(?<=[a-z,;:.?!]\s)([A-Z][a-z]+(?: [A-Z][a-z]+)+)/g)) {
      candidates.add(phrase.trim());
    }

    // Filter: only include candidates that don't already have a note
    const gaps = [...candidates].filter((c) => !existingStems.has(c.toLowerCase()));

    return {
      content: [{
        type: "text",
        text: gaps.length
          ? `Knowledge gaps in "${path.basename(noteName, ".md")}" (${gaps.length}):\n${gaps.map((g) => `  - ${g}`).join("\n")}`
          : "No knowledge gaps found — all mentioned concepts have corresponding notes.",
      }],
    };
  }
);

server.tool(
  "extract_concepts",
  "Extract key concepts from a note: wikilinked terms, bold terms, inline code/technical terms, and potential proper nouns. Returns a categorised list.",
  {
    path: z.string().describe("Vault-relative path to the note."),
  },
  async ({ path: noteName }) => {
    const raw = await fs.readFile(await notePath(noteName), "utf-8");
    const { content } = matter(raw);

    const wikilinks   = parseWikilinks(raw);
    const boldTerms   = [...new Set([...content.matchAll(/\*\*([^*]{2,60})\*\*/g)].map((m) => m[1].trim()))];
    const codeTerms   = [...new Set([...content.matchAll(/`([^`]{1,60})`/g)].map((m) => m[1].trim()))];
    const properNouns = [...new Set(
      [...content.matchAll(/(?<=[a-z,;:.?!\s])([A-Z][a-z]+(?: [A-Z][a-z]+)*)/g)]
        .map((m) => m[1].trim())
        .filter((t) => t.split(" ").length <= 4 && !boldTerms.includes(t))
    )];

    const sections = [
      wikilinks.length   ? `**Wikilinked concepts (${wikilinks.length}):**\n${wikilinks.map((t) => `  - ${t}`).join("\n")}` : null,
      boldTerms.length   ? `**Bold/key terms (${boldTerms.length}):**\n${boldTerms.map((t) => `  - ${t}`).join("\n")}` : null,
      codeTerms.length   ? `**Technical/code terms (${codeTerms.length}):**\n${codeTerms.map((t) => `  - ${t}`).join("\n")}` : null,
      properNouns.length ? `**Potential proper nouns (${properNouns.length}):**\n${properNouns.slice(0, 20).map((t) => `  - ${t}`).join("\n")}` : null,
    ].filter(Boolean);

    return {
      content: [{
        type: "text",
        text: sections.length ? sections.join("\n\n") : "No concepts found.",
      }],
    };
  }
);

server.tool(
  "generate_summary_note",
  "Synthesise multiple notes into a single structured overview note, preserving key themes, tags, and links from each source.",
  {
    sources: z.array(z.string()).min(1).describe("Vault-relative paths of the notes to synthesise."),
    destination: z.string().optional().describe("Vault-relative path to save the summary note. Omit to return without saving."),
    title: z.string().optional().describe("Title for the summary note. Defaults to 'Summary'."),
  },
  async ({ sources, destination, title = "Summary" }) => {
    const sections = [];
    const allTags = new Set();
    const allLinks = new Set();

    for (const src of sources) {
      const raw = await fs.readFile(await notePath(src), "utf-8");
      const { content, data } = matter(raw);
      const stem = path.basename(src, ".md");

      // Collect metadata
      if (data.tags) [].concat(data.tags).forEach((t) => allTags.add(t));
      parseWikilinks(raw).forEach((l) => allLinks.add(l));

      // First paragraph as excerpt
      const firstPara = content.split(/\n\n+/).find((p) => p.trim() && !/^#/.test(p.trim()))?.trim() ?? "";
      // All headings
      const headings = content.split("\n").filter((l) => /^#{1,6}\s/.test(l)).join("\n");

      sections.push(
        `## [[${stem}]]\n` +
        (firstPara ? `${firstPara.slice(0, 300)}${firstPara.length > 300 ? "…" : ""}\n` : "") +
        (headings ? `\n**Structure:**\n${headings}` : "")
      );
    }

    const fmData = {
      title,
      date: formatDate(),
      sources: sources.map((s) => path.basename(s, ".md")),
    };
    if (allTags.size) fmData.tags = [...allTags];

    const relatedLinks = allLinks.size
      ? `\n## Related Concepts\n${[...allLinks].map((l) => `- [[${l}]]`).join("\n")}`
      : "";

    const bodyContent = `# ${title}\n\n${sections.join("\n\n")}${relatedLinks}\n`;
    const note = matter.stringify(bodyContent, fmData);

    if (destination) {
      const destPath = await notePath(destination);
      try { await fs.access(destPath); throw new Error(`Destination already exists: ${destination}. Use write_note to overwrite.`); }
      catch (e) { if (e.message.startsWith("Destination already exists")) throw e; }
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, note, "utf-8");
      return { content: [{ type: "text", text: `Summary note written to: ${destination}` }] };
    }

    return { content: [{ type: "text", text: note }] };
  }
);

server.tool(
  "suggest_note_structure",
  "Analyse a note's current structure and return suggestions for improving its heading hierarchy, frontmatter, and organisation.",
  {
    path: z.string().describe("Vault-relative path to the note."),
  },
  async ({ path: noteName }) => {
    const raw = await fs.readFile(await notePath(noteName), "utf-8");
    const { content, data } = matter(raw);
    const lines = content.split("\n");

    const suggestions = [];
    const headings = lines.filter((l) => /^#{1,6}\s/.test(l));
    const paragraphs = content.split(/\n\n+/).filter((p) => p.trim() && !/^#/.test(p.trim()));
    const wordCount = tokenize(content).length;

    // Frontmatter suggestions
    if (!Object.keys(data).length)        suggestions.push("⚠ No frontmatter — consider adding `tags`, `date`, and `status` fields.");
    if (!data.tags)                        suggestions.push("⚠ No tags — adding tags improves discoverability and search.");
    if (!data.date)                        suggestions.push("⚠ No `date` field — useful for timeline queries.");
    if (wordCount > 300 && !data.summary)  suggestions.push("⚠ Note is long but has no `summary` frontmatter field.");

    // Heading suggestions
    if (wordCount > 200 && headings.length === 0) {
      suggestions.push("⚠ Long note with no headings — consider breaking it into sections.");
    }
    const h1s = headings.filter((h) => h.startsWith("# "));
    if (h1s.length > 1) suggestions.push(`⚠ Multiple H1 headings (${h1s.length}) — typically a note should have at most one H1.`);

    const levels = headings.map((h) => h.match(/^(#+)/)[1].length);
    for (let i = 1; i < levels.length; i++) {
      if (levels[i] - levels[i - 1] > 1) {
        suggestions.push(`⚠ Heading level jumps from H${levels[i-1]} to H${levels[i]} — consider using sequential levels.`);
        break;
      }
    }

    // Content suggestions
    const longParas = paragraphs.filter((p) => tokenize(p).length > 150);
    if (longParas.length > 0) {
      suggestions.push(`⚠ ${longParas.length} paragraph(s) exceed 150 words — consider splitting or adding sub-headings.`);
    }
    if (!parseWikilinks(raw).length) {
      suggestions.push("⚠ No outgoing [[wikilinks]] — linking to related notes strengthens the knowledge graph.");
    }

    // Positive feedback
    if (!suggestions.length) suggestions.push("✓ Note structure looks good — no major issues found.");

    // Suggested skeleton
    const skeleton = headings.length
      ? `\n**Current structure:**\n${headings.join("\n")}`
      : "\n**Current structure:** (no headings)";

    return {
      content: [{
        type: "text",
        text: `## Structure Analysis: ${path.basename(noteName, ".md")}\n\n${suggestions.join("\n")}\n${skeleton}`,
      }],
    };
  }
);

server.tool(
  "find_related_notes",
  "Find notes most thematically similar to a given note, ranked by content overlap. Broader than suggest_links — includes already-linked notes.",
  {
    path: z.string().describe("Vault-relative path to the source note."),
    limit: z.number().int().min(1).optional().describe("Max results to return. Defaults to 10."),
  },
  async ({ path: noteName, limit = 10 }) => {
    const files = await collectMarkdownFiles(VAULT_ROOT);
    const sourceStem = path.basename(noteName, ".md").toLowerCase();
    const sourceTokens = new Set(tokenize(matter(await fs.readFile(await notePath(noteName), "utf-8")).content));

    const scored = [];
    for (const file of files) {
      const rel = toRelative(file);
      if (path.basename(rel, ".md").toLowerCase() === sourceStem) continue;
      const tokens = new Set(tokenize(matter(await fs.readFile(file, "utf-8")).content));
      const score = jaccardSimilarity(sourceTokens, tokens);
      if (score > 0) scored.push({ rel, score: Math.round(score * 1000) / 1000 });
    }

    scored.sort((a, b) => b.score - a.score);

    return {
      content: [{
        type: "text",
        text: scored.slice(0, limit).length
          ? scored.slice(0, limit).map((s) => `${s.rel}  (similarity: ${s.score})`).join("\n")
          : "No related notes found.",
      }],
    };
  }
);

server.tool(
  "compare_notes",
  "Compare two notes side by side: shared concepts, unique content, tag overlap, and link overlap.",
  {
    path_a: z.string().describe("Vault-relative path to the first note."),
    path_b: z.string().describe("Vault-relative path to the second note."),
  },
  async ({ path_a, path_b }) => {
    const rawA = await fs.readFile(await notePath(path_a), "utf-8");
    const rawB = await fs.readFile(await notePath(path_b), "utf-8");
    const parsedA = matter(rawA);
    const parsedB = matter(rawB);

    const tokensA = new Set(tokenize(parsedA.content));
    const tokensB = new Set(tokenize(parsedB.content));
    const shared  = [...tokensA].filter((t) => tokensB.has(t));
    const onlyA   = [...tokensA].filter((t) => !tokensB.has(t));
    const onlyB   = [...tokensB].filter((t) => !tokensA.has(t));
    const similarity = jaccardSimilarity(tokensA, tokensB);

    const tagsA = new Set(extractTags(parsedA));
    const tagsB = new Set(extractTags(parsedB));
    const sharedTags = [...tagsA].filter((t) => tagsB.has(t));

    const linksA = new Set(parseWikilinks(rawA).map((l) => l.toLowerCase()));
    const linksB = new Set(parseWikilinks(rawB).map((l) => l.toLowerCase()));
    const sharedLinks = [...linksA].filter((l) => linksB.has(l));

    const stemA = path.basename(path_a, ".md");
    const stemB = path.basename(path_b, ".md");

    const report = [
      `## Comparison: "${stemA}" vs "${stemB}"`,
      `\n**Overall similarity:** ${(similarity * 100).toFixed(1)}%`,
      `**Word counts:** ${tokensA.size} vs ${tokensB.size}`,
      `\n**Shared concepts (top 20):** ${shared.slice(0, 20).join(", ") || "none"}`,
      `**Only in "${stemA}" (top 15):** ${onlyA.slice(0, 15).join(", ") || "none"}`,
      `**Only in "${stemB}" (top 15):** ${onlyB.slice(0, 15).join(", ") || "none"}`,
      `\n**Shared tags:** ${sharedTags.join(", ") || "none"}`,
      `**Tags only in "${stemA}":** ${[...tagsA].filter((t) => !tagsB.has(t)).join(", ") || "none"}`,
      `**Tags only in "${stemB}":** ${[...tagsB].filter((t) => !tagsA.has(t)).join(", ") || "none"}`,
      `\n**Shared links:** ${sharedLinks.join(", ") || "none"}`,
    ].join("\n");

    return { content: [{ type: "text", text: report }] };
  }
);

server.tool(
  "get_note_evolution",
  "Track how a note has evolved over time using git history. Returns word count, heading count, and link count per commit. Falls back to current stats if the vault isn't a git repo.",
  {
    path: z.string().describe("Vault-relative path to the note."),
    limit: z.number().int().min(1).max(100).optional().describe("Max number of commits to inspect (1–100). Defaults to 10."),
  },
  async ({ path: noteName, limit = 10 }) => {
    const fullPath = await notePath(noteName);

    // Check if vault is a git repo
    let isGit = false;
    try {
      await execFileAsync("git", ["-C", VAULT_ROOT, "rev-parse", "--git-dir"]);
      isGit = true;
    } catch { /* not a git repo */ }

    if (!isGit) {
      const raw = await fs.readFile(fullPath, "utf-8");
      const { content } = matter(raw);
      return {
        content: [{
          type: "text",
          text: [
            `## Current stats: ${noteName}`,
            `Words: ${tokenize(content).length}`,
            `Headings: ${content.split("\n").filter((l) => /^#/.test(l)).length}`,
            `Links: ${parseWikilinks(raw).length}`,
            `\n(Vault is not a git repository — historical evolution unavailable.)`,
          ].join("\n"),
        }],
      };
    }

    // Normalize path separators for git (always uses forward slashes)
    const gitPath = noteName.split(path.sep).join("/");
    const { stdout: logOut } = await execFileAsync("git", [
      "-C", VAULT_ROOT, "log", `--max-count=${limit}`, "--format=%H %as %s", "--", gitPath,
    ]);

    const commits = logOut.trim().split("\n").filter(Boolean);
    if (!commits.length) {
      return { content: [{ type: "text", text: `No git history found for ${noteName}.` }] };
    }

    const rows = ["| Date | Words | Headings | Links | Commit |"];
    rows.push("|------|-------|----------|-------|--------|");

    for (const line of commits) {
      const sp1 = line.indexOf(" ");
      const sp2 = sp1 > 0 ? line.indexOf(" ", sp1 + 1) : -1;
      if (sp1 < 0 || sp2 < 0) continue;
      const hash = line.slice(0, sp1);
      const date = line.slice(sp1 + 1, sp2);
      const msg = line.slice(sp2 + 1).slice(0, 40).replace(/\|/g, "\\|");
      if (!/^[0-9a-f]{7,40}$/i.test(hash)) continue;
      try {
        const { stdout: blob } = await execFileAsync("git", ["-C", VAULT_ROOT, "show", `${hash}:${gitPath}`]);
        const { content } = matter(blob);
        rows.push(`| ${date.slice(0,10)} | ${tokenize(content).length} | ${content.split("\n").filter((l) => /^#/.test(l)).length} | ${parseWikilinks(blob).length} | ${msg} |`);
      } catch { rows.push(`| ${date.slice(0,10)} | — | — | — | ${msg} (file not present) |`); }
    }

    return { content: [{ type: "text", text: `## Evolution: ${noteName}\n\n${rows.join("\n")}` }] };
  }
);

server.tool(
  "extract_quotes",
  "Pull all blockquotes from the vault (or a single note), optionally filtered by tag.",
  {
    path: z.string().optional().describe("Vault-relative path to a single note. Omit to scan the entire vault."),
    tag: z.string().optional().describe("Only return quotes from notes with this tag."),
  },
  async ({ path: noteName, tag }) => {
    const files = noteName ? [await notePath(noteName)] : await collectMarkdownFiles(VAULT_ROOT);
    const results = [];

    for (const file of files) {
      const raw = await fs.readFile(file, "utf-8");
      const parsed = matter(raw);

      if (tag && !extractTags(parsed).includes(tag.toLowerCase())) continue;

      const quotes = [];
      let current = [];
      for (const line of parsed.content.split("\n")) {
        if (line.startsWith(">")) {
          current.push(line.replace(/^(>\s?)+/, ""));
        } else if (current.length) {
          quotes.push(current.join(" ").trim());
          current = [];
        }
      }
      if (current.length) quotes.push(current.join(" ").trim());

      if (quotes.length) {
        results.push(`### ${toRelative(file)}\n${quotes.map((q) => `> ${q}`).join("\n\n")}`);
      }
    }

    return {
      content: [{ type: "text", text: results.length ? results.join("\n\n") : "No blockquotes found." }],
    };
  }
);

server.tool(
  "find_unsourced_claims",
  "Flag sentences that read as factual assertions but contain no [[wikilink]], URL, or citation marker. Useful for identifying claims that need sourcing.",
  {
    path: z.string().optional().describe("Vault-relative path to a single note. Omit to scan the entire vault."),
  },
  async ({ path: noteName }) => {
    const ASSERTION_WORDS = /\b(is|are|was|were|shows|show|proves|prove|demonstrates|always|never|must|causes|cause|leads to|results in|increases|decreases|improves|reduces)\b/i;
    const HAS_SOURCE = /\[\[|https?:\/\/|\[@|\(\d{4}\)|ibid|et al/i;

    const files = noteName ? [await notePath(noteName)] : await collectMarkdownFiles(VAULT_ROOT);
    const results = [];

    for (const file of files) {
      const raw = await fs.readFile(file, "utf-8");
      const parsed = matter(raw);
      const content = parsed.content;
      // Calculate line offset so reported line numbers are file-relative
      // gray-matter's .matter contains the raw YAML string (without delimiters)
      const fmLineCount = parsed.matter ? parsed.matter.split("\n").length + 2 : 0; // +2 for --- delimiters
      const flagged = [];

      let inCodeBlock = false;
      for (const [i, line] of content.split("\n").entries()) {
        if (line.trim().startsWith("```")) { inCodeBlock = !inCodeBlock; continue; }
        if (inCodeBlock) continue;
        // Skip headings, blockquotes, list markers, blank lines
        const trimmed = line.trim();
        if (!trimmed || /^[#>`\-*|]/.test(trimmed)) continue;

        const sentences = trimmed.split(/(?<=[.!?])\s+/);
        for (const sentence of sentences) {
          if (sentence.split(" ").length < 5) continue; // too short to be a claim
          if (ASSERTION_WORDS.test(sentence) && !HAS_SOURCE.test(sentence)) {
            flagged.push(`  L${i + 1 + fmLineCount}: ${sentence.trim().slice(0, 120)}`);
          }
        }
      }

      if (flagged.length) results.push(`### ${toRelative(file)}\n${flagged.join("\n")}`);
    }

    return {
      content: [{ type: "text", text: results.length ? results.join("\n\n") : "No unsourced claims found." }],
    };
  }
);

server.tool(
  "generate_flashcards",
  "Convert a note's content into Q&A flashcard pairs. Detects question/answer patterns, bold-term definitions, and heading + first-sentence pairs. Returns tab-separated Anki-compatible format.",
  {
    path: z.string().describe("Vault-relative path to the note."),
    destination: z.string().optional().describe("Vault-relative path to save the flashcard file (.md or .txt). Omit to return without saving."),
  },
  async ({ path: noteName, destination }) => {
    const raw = await fs.readFile(await notePath(noteName), "utf-8");
    const { content } = matter(raw);
    const lines = content.split("\n");
    const cards = [];

    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();

      // Pattern 1: Q: ... / A: ...
      if (/^Q:/i.test(line)) {
        const question = line.replace(/^Q:\s*/i, "").trim();
        const answerLine = lines[i + 1]?.trim() ?? "";
        if (/^A:/i.test(answerLine)) {
          cards.push({ q: question, a: answerLine.replace(/^A:\s*/i, "").trim() });
          i += 2; continue;
        }
      }

      // Pattern 2: Explicit question followed by answer paragraph
      if (line.endsWith("?") && line.split(" ").length >= 3) {
        const answer = lines[i + 1]?.trim();
        if (answer && !answer.endsWith("?") && answer.length > 10) {
          cards.push({ q: line, a: answer });
          i += 2; continue;
        }
      }

      // Pattern 3: **Term** — definition  or  **Term**: definition
      const boldDef = line.match(/^\*\*(.+?)\*\*\s*[—:-]\s*(.{10,})/);
      if (boldDef) {
        cards.push({ q: `What is ${boldDef[1]}?`, a: boldDef[2].trim() });
        i++; continue;
      }

      // Pattern 4: Heading → first content sentence
      if (/^#{2,4}\s/.test(line)) {
        const heading = line.replace(/^#+\s/, "").trim();
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        const body = lines[j]?.trim();
        if (body && !/^[#>*`-]/.test(body) && body.split(" ").length > 6) {
          const firstSentence = body.split(/(?<=[.!?])\s+/)[0];
          cards.push({ q: `What is "${heading}" about?`, a: firstSentence });
        }
      }

      i++;
    }

    if (!cards.length) {
      return { content: [{ type: "text", text: "No flashcard patterns detected in this note." }] };
    }

    const ankiFormat = cards.map((c) => `${c.q}\t${c.a}`).join("\n");
    const readableFormat = cards.map((c, n) => `**Q${n+1}:** ${c.q}\n**A:** ${c.a}`).join("\n\n");
    const output = `## Flashcards: ${path.basename(noteName, ".md")} (${cards.length} cards)\n\n${readableFormat}\n\n---\n*Anki import format (tab-separated):*\n\`\`\`\n${ankiFormat}\n\`\`\``;

    if (destination) {
      const destPath = await notePath(destination);
      try { await fs.access(destPath); throw new Error(`Destination already exists: ${destination}. Use write_note to overwrite.`); }
      catch (e) { if (e.message.startsWith("Destination already exists")) throw e; }
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, output, "utf-8");
      return { content: [{ type: "text", text: `Flashcards saved to: ${destination}` }] };
    }

    return { content: [{ type: "text", text: output }] };
  }
);

server.tool(
  "extract_definitions",
  "Find and compile all definition-like sentences across the vault (or a note) into a glossary. Detects 'X is a...', 'X refers to...', 'X: ...' and bold-dash patterns.",
  {
    path: z.string().optional().describe("Vault-relative path to a single note. Omit to scan the entire vault."),
    destination: z.string().optional().describe("Vault-relative path to save the glossary note. Omit to return without saving."),
  },
  async ({ path: noteName, destination }) => {
    const DEFINITION_PATTERNS = [
      /^([A-Z][^.]{1,60}?)\s+(?:is|are|refers? to|means?)\s+(?:a|an|the)?\s+(.{15,200}[.!])/,
      /^\*\*(.{2,50})\*\*\s*[—:-]\s*(.{10,200})/,
      /^`(.{2,50})`\s*[—:-]\s*(.{10,200})/,
    ];

    const files = noteName ? [await notePath(noteName)] : await collectMarkdownFiles(VAULT_ROOT);
    const definitions = [];

    for (const file of files) {
      const { content } = matter(await fs.readFile(file, "utf-8"));
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || /^[#>`|]/.test(trimmed)) continue;
        for (const pattern of DEFINITION_PATTERNS) {
          const match = trimmed.match(pattern);
          if (match) {
            definitions.push({ term: match[1].trim(), def: match[2].trim(), source: toRelative(file) });
            break;
          }
        }
      }
    }

    if (!definitions.length) {
      return { content: [{ type: "text", text: "No definitions found." }] };
    }

    definitions.sort((a, b) => a.term.localeCompare(b.term));
    const glossary = definitions
      .map((d) => `**${d.term}**\n${d.def}\n*Source: [[${path.basename(d.source, ".md")}]]*`)
      .join("\n\n");

    const output = `# Glossary\n*Generated: ${formatDate()} | ${definitions.length} terms*\n\n${glossary}`;

    if (destination) {
      const destPath = await notePath(destination);
      try { await fs.access(destPath); throw new Error(`Destination already exists: ${destination}. Use write_note to overwrite.`); }
      catch (e) { if (e.message.startsWith("Destination already exists")) throw e; }
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, output, "utf-8");
      return { content: [{ type: "text", text: `Glossary saved to: ${destination}` }] };
    }

    return { content: [{ type: "text", text: output }] };
  }
);

server.tool(
  "get_review_queue",
  "Find notes that are overdue for review: not modified in N+ days and flagged as active/in-progress via frontmatter.",
  {
    days: z.number().int().min(1).optional().describe("Notes not modified in this many days are considered overdue. Defaults to 14."),
    status_field: z.string().optional().describe("Frontmatter field to check for active status. Defaults to 'status'."),
    active_values: z.array(z.string()).optional().describe("Values that indicate a note is active. Defaults to ['active', 'in-progress', 'wip']."),
  },
  async ({ days = 14, status_field = "status", active_values = ["active", "in-progress", "wip"] }) => {
    const files = await collectMarkdownFiles(VAULT_ROOT);
    const cutoff = Date.now() - days * 86_400_000;
    const queue = [];

    for (const file of files) {
      const { mtimeMs } = await fs.stat(file);
      if (mtimeMs >= cutoff) continue; // recently modified — not overdue

      const { data } = matter(await fs.readFile(file, "utf-8"));
      const status = String(data[status_field] ?? data.review ?? "").toLowerCase();
      const isActive = active_values.some((v) => v.toLowerCase() === status) || data.review === true;

      if (isActive) {
        const daysStale = Math.floor((Date.now() - mtimeMs) / 86_400_000);
        queue.push({ rel: toRelative(file), daysStale, status });
      }
    }

    queue.sort((a, b) => b.daysStale - a.daysStale);

    return {
      content: [{
        type: "text",
        text: queue.length
          ? `${queue.length} note(s) overdue for review:\n\n` +
            queue.map((n) => `${n.daysStale}d ago  [${n.status}]  ${n.rel}`).join("\n")
          : "No notes overdue for review.",
      }],
    };
  }
);

server.tool(
  "score_note_quality",
  "Rate notes on a quality rubric: frontmatter completeness, tags, links, body length, heading structure, and summary. Returns a score and breakdown.",
  {
    path: z.string().optional().describe("Vault-relative path to score a single note. Omit to score all notes in the vault."),
    min_score: z.number().min(0).max(100).optional().describe("When scoring all notes, only return notes at or below this score (0–100). Defaults to 100 (return all)."),
  },
  async ({ path: noteName, min_score = 100 }) => {
    const scoreFile = async (file) => {
      const raw = await fs.readFile(file, "utf-8");
      const parsed = matter(raw);
      let score = 0;
      const breakdown = [];
      for (const item of QUALITY_RUBRIC) {
        const pass = item.check(parsed, raw);
        if (pass) score += item.points;
        breakdown.push(`  [${pass ? "✓" : "✗"}] ${item.label} (${item.points}pts)`);
      }
      return { rel: toRelative(file), score, max: QUALITY_MAX, breakdown };
    };

    if (noteName) {
      const result = await scoreFile(await notePath(noteName));
      return {
        content: [{
          type: "text",
          text: `## Quality Score: ${result.rel}\n**${result.score}/${result.max}** (${Math.round(result.score/result.max*100)}%)\n\n${result.breakdown.join("\n")}`,
        }],
      };
    }

    const files = await collectMarkdownFiles(VAULT_ROOT);
    const scores = [];
    for (const file of files) scores.push(await scoreFile(file));
    scores.sort((a, b) => a.score - b.score);
    const filtered = scores.filter((s) => Math.round(s.score / s.max * 100) <= min_score);

    return {
      content: [{
        type: "text",
        text: filtered.length
          ? filtered.map((s) => `${Math.round(s.score/s.max*100).toString().padStart(3)}%  ${s.rel}`).join("\n")
          : "No notes matched the score filter.",
      }],
    };
  }
);

server.tool(
  "suggest_tags",
  "Infer likely tags for a note by comparing its content to how similar notes in the vault are tagged.",
  {
    path: z.string().describe("Vault-relative path to the note."),
    limit: z.number().int().min(1).optional().describe("Max tag suggestions to return. Defaults to 10."),
  },
  async ({ path: noteName, limit = 10 }) => {
    const files = await collectMarkdownFiles(VAULT_ROOT);
    const sourceStem = path.basename(noteName, ".md").toLowerCase();
    const sourceRaw = await fs.readFile(await notePath(noteName), "utf-8");
    const sourceParsed = matter(sourceRaw);
    const sourceTokens = new Set(tokenize(sourceParsed.content));
    const existingTags = new Set(extractTags(sourceParsed));

    const tagScores = {};

    for (const file of files) {
      const rel = toRelative(file);
      if (path.basename(rel, ".md").toLowerCase() === sourceStem) continue;

      const raw = await fs.readFile(file, "utf-8");
      const parsed = matter(raw);
      const tags = extractTags(parsed);
      if (!tags.length) continue;

      const tokens = new Set(tokenize(parsed.content));
      const sim = jaccardSimilarity(sourceTokens, tokens);
      if (sim < 0.05) continue; // noise floor — skip near-zero similarity

      for (const tag of tags) {
        if (existingTags.has(tag)) continue;
        tagScores[tag] = (tagScores[tag] ?? 0) + sim;
      }
    }

    const sorted = Object.entries(tagScores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);

    return {
      content: [{
        type: "text",
        text: sorted.length
          ? `Suggested tags for "${path.basename(noteName, ".md")}":\n${sorted.map(([t, s]) => `  #${t}  (relevance: ${s.toFixed(3)})`).join("\n")}`
          : "No tag suggestions found (note may be too unique or vault has too few tagged notes).",
      }],
    };
  }
);
}
