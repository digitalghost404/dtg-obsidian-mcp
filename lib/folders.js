import { z } from "zod";
import { fs, VAULT_ROOT, notePath, collectMarkdownFiles, collectFolders, toRelative } from "./helpers.js";

export function registerFoldersTools(server, cache) {
server.tool(
  "list_folders",
  "List all subdirectories (folders) in the vault.",
  {},
  async () => {
    const folders = await collectFolders(VAULT_ROOT);
    return { content: [{ type: "text", text: folders.length ? folders.join("\n") : "No folders found." }] };
  }
);

server.tool(
  "create_folder",
  "Create a new folder (and any missing parent folders) in the vault.",
  { path: z.string().describe("Vault-relative folder path to create.") },
  async ({ path: folderName }) => {
    cache?.invalidate("*");
    await fs.mkdir(await notePath(folderName), { recursive: true });
    return { content: [{ type: "text", text: `Folder created: ${folderName}` }] };
  }
);

server.tool(
  "delete_folder",
  "Delete a folder. Fails if non-empty unless force is true. Use dry_run to preview what would be deleted.",
  {
    path: z.string().describe("Vault-relative path of the folder to delete."),
    force: z.boolean().optional().describe("Delete folder and all its contents. Defaults to false."),
    dry_run: z.boolean().optional().describe("If true, list contents without deleting. Defaults to false."),
  },
  async ({ path: folderName, force = false, dry_run = false }) => {
    if (!dry_run) cache?.invalidate("*");
    const fullPath = await notePath(folderName);
    if (dry_run) {
      try {
        const files = await collectMarkdownFiles(fullPath);
        const folders = await collectFolders(fullPath);
        return { content: [{ type: "text", text: `Dry run — would delete:\n  ${files.length} note(s)\n  ${folders.length} subfolder(s)\n\nNotes:\n${files.map((f) => `  - ${toRelative(f)}`).join("\n") || "  (none)"}` }] };
      } catch (e) {
        if (e.code === "ENOENT" || e.message.startsWith("Folder not found")) {
          return { content: [{ type: "text", text: `Folder not found: ${folderName}` }] };
        }
        throw e;
      }
    }
    let stat;
    try { stat = await fs.stat(fullPath); }
    catch (e) { if (e.code === "ENOENT") throw new Error(`Folder not found: ${folderName}`); throw e; }
    if (!stat.isDirectory()) throw new Error(`Not a folder: ${folderName}. Use delete_note to delete files.`);
    if (force) {
      await fs.rm(fullPath, { recursive: true, force: true });
    } else {
      try {
        await fs.rmdir(fullPath);
      } catch (e) {
        if (e.code === "ENOTEMPTY") throw new Error(`Folder is not empty: ${folderName}. Use force: true to delete recursively, or dry_run: true to preview contents.`);
        throw e;
      }
    }
    return { content: [{ type: "text", text: `Folder deleted: ${folderName}` }] };
  }
);
}
