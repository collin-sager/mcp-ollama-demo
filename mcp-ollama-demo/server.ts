import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { ToolRuntime, registerAllTools } from "./tools.js";

const workspaceRoot = path.resolve(process.cwd(), "workspace");
const runtime = new ToolRuntime(workspaceRoot);
const server = new McpServer({ name: "mcp-ollama-demo", version: "0.1.0" });

await registerAllTools(server, runtime);
await server.connect(new StdioServerTransport());
