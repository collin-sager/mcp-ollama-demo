import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "workspace");

function safePath(rel: string) {
  const p = path.resolve(ROOT, rel);
  if (!p.startsWith(ROOT)) throw new Error("Path escapes workspace/");
  return p;
}

await fs.mkdir(ROOT, { recursive: true });

const server = new McpServer({ name: "mcp-ollama-demo", version: "0.1.0" });

server.tool(
  "list_dir",
  "List files under workspace/ (relative path).",
  { dir: z.string().default(".") },
  async ({ dir }) => {
    const full = safePath(dir);
    const entries = await fs.readdir(full, { withFileTypes: true });
    const out = entries.map(e => `${e.isDirectory() ? "d" : "f"}  ${e.name}`).join("\n");
    return { content: [{ type: "text", text: out || "(empty)" }] };
  }
);

server.tool(
  "read_file",
  "Read a UTF-8 text file under workspace/.",
  { file: z.string() },
  async ({ file }) => {
    const full = safePath(file);
    const text = await fs.readFile(full, "utf8");
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "write_file",
  "Write a UTF-8 text file under workspace/. Creates parent dirs.",
  { file: z.string(), content: z.string() },
  async ({ file, content }) => {
    const full = safePath(file);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf8");
    return { content: [{ type: "text", text: `Wrote ${file}` }] };
  }
);

await server.connect(new StdioServerTransport());