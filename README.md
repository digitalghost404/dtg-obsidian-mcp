# Synapse

> The connective layer for your Obsidian vault.

Your notes are full of ideas — but ideas in isolation are just text. **Synapse** is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that gives Claude a nervous system for your Obsidian vault. It doesn't just read and write files. It traces paths between ideas, surfaces missing connections, clusters notes by theme, flags weak points in your thinking, and helps you see your knowledge graph the way your brain was always meant to.

**56 tools. 9 categories. One vault that finally thinks back.**

---

## ⚡ What Synapse does differently

Every PKM tool lets you store notes. Synapse helps you *use* them.

| Without Synapse | With Synapse |
|-----------------|--------------|
| Manually hunting for related notes | `find_related_notes` ranks your vault by thematic similarity |
| Not knowing what's missing | `find_knowledge_gaps` surfaces concepts with no note yet |
| Links you forgot to make | `suggest_links` finds unlinked connections using content overlap |
| Notes that slowly go stale | `get_review_queue` surfaces overdue active notes automatically |
| No idea how healthy your vault is | `vault_report` gives a full diagnostic in one shot |
| Studying from raw notes | `generate_flashcards` converts any note to Anki-ready Q&A pairs |
| Wondering how two ideas connect | `trace_path` finds the shortest wikilink path between any two notes |

---

## 🛠 Tools

### Note Management
| Tool | Description |
|------|-------------|
| `list_notes` | List all notes, optionally filtered by folder |
| `read_note` | Read the full content of a note |
| `write_note` | Create or overwrite a note (auto-creates parent folders) |
| `delete_note` | Delete a note by path |
| `rename_note` | Rename or move a note to a new path |
| `append_to_note` | Append content without overwriting |
| `patch_note` | Find and replace text (first match or all occurrences) |

### Frontmatter & Metadata
| Tool | Description |
|------|-------------|
| `get_frontmatter` | Return a note's YAML frontmatter as structured JSON |
| `set_frontmatter` | Update specific fields while preserving the rest |
| `list_tags` | Aggregate every tag in the vault with usage counts |

### Links & Graph
| Tool | Description |
|------|-------------|
| `get_outgoing_links` | List all `[[wikilinks]]` in a note |
| `get_backlinks` | Find every note that links to a given note |
| `get_orphans` | Find notes with no incoming or outgoing links |

### Folders
| Tool | Description |
|------|-------------|
| `list_folders` | List all folders in the vault |
| `create_folder` | Create a folder (and any missing parents) |
| `delete_folder` | Delete a folder — safe by default, `force: true` for recursive |

### Daily Notes & Templates
| Tool | Description |
|------|-------------|
| `get_daily_note` | Read today's (or any date's) daily note |
| `create_daily_note` | Create a daily note, optionally from a template |
| `list_templates` | List all notes in the Templates folder |
| `create_from_template` | Instantiate a template with `{{title}}`, `{{date}}`, and custom `{{key}}` substitutions |

### Search & Query
| Tool | Description |
|------|-------------|
| `search_notes` | Full-text search across contents and filenames |
| `search_by_tag` | Find notes by tag(s) with `any` or `all` match modes |
| `search_by_frontmatter` | Find notes by frontmatter key-value pairs |
| `query_notes` | Filter by frontmatter with `eq`, `neq`, `contains`, `gt`, `lt`, `gte`, `lte`, `exists` — plus sort and limit |
| `get_timeline` | List notes sorted chronologically by any date frontmatter field |

### Writing & Workflow
| Tool | Description |
|------|-------------|
| `extract_tasks` | Scan for `- [ ]` checkboxes across the vault or a single note |
| `complete_task` | Check off an open task by matching its exact text |
| `merge_notes` | Combine multiple notes into one, with optional frontmatter stripping |
| `split_note` | Split a note at a heading level — each section becomes its own file |

### Vault Intelligence
| Tool | Description |
|------|-------------|
| `get_graph_stats` | Total notes, links, avg connections, top notes by in/out degree |
| `get_hub_notes` | The most-linked-to notes — the high-degree neurons of your graph |
| `trace_path` | Find the shortest wikilink path between any two notes |
| `get_recently_modified` | Notes modified in the last N days, most recent first |

### Vault Health
| Tool | Description |
|------|-------------|
| `find_broken_links` | Every `[[wikilink]]` pointing to a note that doesn't exist |
| `find_empty_notes` | Notes with no body content (empty or frontmatter-only) |
| `vault_report` | Full diagnostic: broken links, orphans, empty notes, top tags, folder sizes |

### Connective Intelligence
*The tools that make Synapse more than a file manager.*

| Tool | Description |
|------|-------------|
| `summarize_note` | Structural outline: headings, first sentence per section, word count, reading time |
| `suggest_links` | Rank unlinked notes by content and title overlap — fire new connections |
| `generate_moc` | Auto-generate a Map of Contents for any folder |
| `find_duplicates` | Identify similar note pairs using Jaccard similarity |
| `find_knowledge_gaps` | Surface bold terms, capitalized phrases, and wikilinks that have no corresponding note |
| `extract_concepts` | Categorize a note's content into wikilinks, bold terms, code terms, and proper nouns |
| `generate_summary_note` | Synthesize multiple notes into a single structured overview |
| `suggest_note_structure` | Analyze a note and recommend improvements to heading hierarchy, frontmatter, and organization |
| `cluster_notes` | Group notes into thematic clusters by shared vocabulary — see your vault's regions |
| `find_related_notes` | Find the most thematically similar notes to a given note |
| `compare_notes` | Side-by-side: shared concepts, unique content, tag and link overlap |
| `get_note_evolution` | Track word count, headings, and links across git history |
| `extract_quotes` | Collect all blockquotes from the vault, optionally filtered by tag |
| `find_unsourced_claims` | Flag assertive sentences with no wikilink, URL, or citation |
| `generate_flashcards` | Convert a note into Anki-compatible Q&A pairs — detects Q:/A: blocks, bold definitions, heading + summary pairs |
| `extract_definitions` | Compile a glossary from "X is a..." and `**Term** — definition` patterns |
| `get_review_queue` | Notes flagged as active that haven't been touched in N+ days |
| `generate_weekly_review` | Modified notes, open/done tasks, active tags, and most active folders for the past week |
| `score_note_quality` | Rate notes on a 9-point rubric: frontmatter, tags, links, body length, heading structure, and more |
| `suggest_tags` | Infer likely tags by comparing a note to how similar notes across the vault are tagged |

---

## 🚀 Setup

**Prerequisites:** Node.js 18+

```bash
git clone https://github.com/digitalghost404/obsidian-mcp.git
cd obsidian-mcp
npm install
```

Copy the example config and fill in your paths:

```bash
cp .mcp.json.example .mcp.json
```

```jsonc
{
  "mcpServers": {
    "obsidian-vault": {
      "command": "node",
      "args": ["/path/to/obsidian-mcp/index.js"],
      "env": {
        "VAULT_PATH": "/path/to/your/obsidian/vault",
        "DAILY_NOTES_FOLDER": "Daily Notes",
        "TEMPLATES_FOLDER": "Templates"
      }
    }
  }
}
```

Place `.mcp.json` in your project root or `~/.claude/` and Claude Code will connect automatically.

---

## ⚙️ Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VAULT_PATH` | *(required)* | Absolute path to your Obsidian vault |
| `DAILY_NOTES_FOLDER` | `Daily Notes` | Vault-relative folder for daily notes |
| `TEMPLATES_FOLDER` | `Templates` | Vault-relative folder for templates |

---

## 💬 Synapse in action

```
"Run a full vault health report and fix any broken links"

"Find all notes I haven't touched in 2 weeks that are still marked active"

"What's the shortest path between my 'Systems Thinking' note and 'Habit Tracking'?"

"Generate flashcards from my Calculus notes and save them to Study/Calculus Flashcards.md"

"Cluster all notes in my Research folder by theme and show me what emerges"

"Find knowledge gaps in my 'Machine Learning' note — what concepts am I missing?"

"Score all my notes for quality and show me the ones below 50%"

"Extract every definition from my vault and compile a glossary"

"Suggest tags for this draft note based on how the rest of my vault is tagged"

"Compare my 'Atomic Habits' and 'Deep Work' notes — where do these ideas overlap?"

"Flag any unsourced claims in my essay drafts"

"Generate a weekly review — what did I work on, what's still open?"
```

---

## 📄 License

[MIT](./LICENSE) with [Commons Clause](https://commonsclause.com/)

Free to use, modify, and distribute for personal and noncommercial purposes. You may not sell the software or offer it as a paid product or service.
