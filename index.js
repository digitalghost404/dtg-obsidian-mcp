#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VAULT_PATH } from "./lib/helpers.js";
import { VaultCache } from "./lib/cache.js";
import { registerNotesTools } from "./lib/notes.js";
import { registerFrontmatterTools } from "./lib/frontmatter.js";
import { registerLinksTools } from "./lib/links.js";
import { registerFoldersTools } from "./lib/folders.js";
import { registerDailyTools } from "./lib/daily.js";
import { registerTemplatesTools } from "./lib/templates.js";
import { registerSearchTools } from "./lib/search.js";
import { registerAiTools } from "./lib/ai.js";
import { registerGraphTools } from "./lib/graph.js";
import { registerTasksTools } from "./lib/tasks.js";
import { registerSurgeryTools } from "./lib/surgery.js";
import { registerHealthTools } from "./lib/health.js";
import { registerBulkTools } from "./lib/bulk.js";

void VAULT_PATH;

const vaultCache = new VaultCache(
  Number(process.env.VAULT_CACHE_MAX ?? 100),
  Number(process.env.VAULT_CACHE_TTL ?? 30000),
);

const server = new McpServer({
  name: "obsidian-vault",
  version: "3.0.0",
});

server.setResourceRequestHandlers();
server.setPromptRequestHandlers();

const ENABLED_TOOLS = process.env.ENABLED_TOOLS
  ? new Set(process.env.ENABLED_TOOLS.split(",").map((t) => t.trim()))
  : null;

const _originalTool = server.tool.bind(server);
server.tool = (name, ...args) => {
  if (ENABLED_TOOLS && !ENABLED_TOOLS.has(name)) return;
  return _originalTool(name, ...args);
};

registerNotesTools(server, vaultCache);
registerFrontmatterTools(server, vaultCache);
registerLinksTools(server, vaultCache);
registerFoldersTools(server, vaultCache);
registerDailyTools(server, vaultCache);
registerTemplatesTools(server, vaultCache);
registerSearchTools(server, vaultCache);
registerAiTools(server, vaultCache);
registerGraphTools(server, vaultCache);
registerTasksTools(server, vaultCache);
registerSurgeryTools(server, vaultCache);
registerHealthTools(server, vaultCache);
registerBulkTools(server, vaultCache);

const transport = new StdioServerTransport();
await server.connect(transport);
