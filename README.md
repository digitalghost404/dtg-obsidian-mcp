# dtg-obsidian-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that gives Claude direct read/write access to an [Obsidian](https://obsidian.md) vault. Supports note management, frontmatter editing, wikilink graph traversal, daily notes, templates, and more.

## Tools

### Note Management

| Tool | Description |
|------|-------------|
| `list_notes` | List all notes in the vault, optionally filtered by folder |
| `read_note` | Read the full content of a note |
| `write_note` | Create or overwrite a note (creates parent folders automatically) |
| `delete_note` | Delete a note by path |
| `rename_note` | Rename or move a note to a new path |
| `append_to_note` | Append content to a note without overwriting it |
| `patch_note` | Find and replace text within a note |

### Frontmatter / Metadata

| Tool | Description |
|------|-------------|
| `get_frontmatter` | Return a note's YAML frontmatter as structured JSON |
| `set_frontmatter` | Update specific frontmatter fields (preserves existing fields) |
| `list_tags` | Aggregate all tags across the vault with usage counts |

### Links & Graph

| Tool | Description |
|------|-------------|
| `get_outgoing_links` | List all `[[wikilinks]]` in a note |
| `get_backlinks` | Find all notes that link to a given note |
| `get_orphans` | List notes with no incoming or outgoing links |

### Folders

| Tool | Description |
|------|-------------|
| `list_folders` | List all folders in the vault |
| `create_folder` | Create a folder (and any missing parents) |
| `delete_folder` | Delete a folder (safe by default; `force: true` for recursive delete) |

### Daily Notes

| Tool | Description |
|------|-------------|
| `get_daily_note` | Read the daily note for today or a specific date |
| `create_daily_note` | Create a daily note, optionally from a template |

### Templates

| Tool | Description |
|------|-------------|
| `list_templates` | List all notes in the Templates folder |
| `create_from_template` | Create a new note from a template with placeholder substitution |

`create_from_template` substitutes `{{title}}`, `{{date}}`, and any custom `{{key}}` placeholders passed via `extra_vars`.

### Search

| Tool | Description |
|------|-------------|
| `search_notes` | Full-text search across note contents and filenames |
| `search_by_tag` | Find notes by tag(s), with `any` or `all` match modes |
| `search_by_frontmatter` | Find notes matching specific frontmatter key-value pairs |

## Setup

**Prerequisites:** Node.js 18+

```bash
git clone https://github.com/digitalghost404/dtg-obsidian-mcp.git
cd dtg-obsidian-mcp
npm install
```

Copy the example MCP config and fill in your paths:

```bash
cp .mcp.json.example .mcp.json
```

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "command": "node",
      "args": ["/path/to/dtg-obsidian-mcp/index.js"],
      "env": {
        "VAULT_PATH": "/path/to/your/obsidian/vault",
        "DAILY_NOTES_FOLDER": "Daily Notes",
        "TEMPLATES_FOLDER": "Templates"
      }
    }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VAULT_PATH` | `/path/to/your/obsidian/vault` | Absolute path to your Obsidian vault |
| `DAILY_NOTES_FOLDER` | `Daily Notes` | Vault-relative folder for daily notes |
| `TEMPLATES_FOLDER` | `Templates` | Vault-relative folder for templates |

## Usage with Claude Code

Place `.mcp.json` in your project root (or `~/.claude/`) and Claude Code will automatically connect to the server. You can then ask Claude to read, write, search, and organize your vault directly in conversation.

**Example prompts:**
- *"Summarize all notes tagged #project in my vault"*
- *"Create a daily note for today using my meeting template"*
- *"Find all notes that link to 'Zettelkasten' and list their backlinks"*
- *"Set the status field to 'done' in Projects/Q1 Review.md"*
