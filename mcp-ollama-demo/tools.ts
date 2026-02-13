import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const MAX_FILE_BYTES = 1024 * 1024; // 1 MiB
export const DEFAULT_READ_MAX_BYTES = 256 * 1024; // 256 KiB
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024; // 64 KiB
export const MAX_OUTPUT_BYTES = 256 * 1024; // 256 KiB
export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_TIMEOUT_MS = 60_000;

export const ALLOWED_COMMANDS = new Set([
  "node",
  "npm",
  "npx",
  "python3",
  "pytest",
  "tsc",
]);

type ToolJson = Record<string, unknown>;

class ToolError extends Error {
  code: string;
  details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const ErrorShapeSchema = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        details: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();

function successShape<T extends z.ZodRawShape>(shape: T) {
  return z.object({ ok: z.literal(true), data: z.object(shape).strict() }).strict();
}

function makeError(code: string, message: string, details?: unknown): ToolJson {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

function mapError(error: unknown): ToolJson {
  if (error instanceof ToolError) {
    return makeError(error.code, error.message, error.details);
  }

  const nodeErr = error as { code?: string; message?: string };
  const code = nodeErr?.code;
  if (code === "ENOENT") return makeError("NOT_FOUND", "Path not found");
  if (code === "EEXIST") return makeError("ALREADY_EXISTS", "Path already exists");
  if (code === "EISDIR") return makeError("IS_DIRECTORY", "Expected file but found directory");
  if (code === "ENOTDIR") return makeError("NOT_DIRECTORY", "Expected directory but found file");
  if (code === "ENOTEMPTY") return makeError("DIRECTORY_NOT_EMPTY", "Directory is not empty");

  return makeError("INTERNAL_ERROR", "Unhandled server error", {
    message: nodeErr?.message ?? String(error),
  });
}

function jsonContent(obj: ToolJson) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj) }],
  };
}

function logToolEvent(tool: string, status: "ok" | "error", meta: Record<string, unknown>) {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      tool,
      status,
      ...meta,
    }),
  );
}

export function normalizeWorkspaceRelativePath(
  rawInput: string,
  options: { allowDot?: boolean } = {},
): string {
  const allowDot = options.allowDot ?? false;

  if (typeof rawInput !== "string") {
    throw new ToolError("INVALID_PATH", "Path must be a string");
  }

  if (path.isAbsolute(rawInput) || path.win32.isAbsolute(rawInput)) {
    throw new ToolError("INVALID_PATH", "Absolute paths are not allowed");
  }

  let input = rawInput.trim();
  if (!input) {
    throw new ToolError("INVALID_PATH", "Path must not be empty");
  }

  if (input.includes("\0")) {
    throw new ToolError("INVALID_PATH", "Path contains invalid null bytes");
  }

  input = input.replace(/\\/g, "/");
  while (input.startsWith("./")) {
    input = input.slice(2);
  }

  while (input.toLowerCase().startsWith("workspace/")) {
    input = input.slice("workspace/".length);
  }
  if (input.toLowerCase() === "workspace") {
    input = ".";
  }

  const segments = input
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== ".");

  if (segments.some((segment) => segment === "..")) {
    throw new ToolError("INVALID_PATH", "Path segments must not contain '..'");
  }

  const normalized = segments.length > 0 ? segments.join("/") : ".";
  if (!allowDot && normalized === ".") {
    throw new ToolError("INVALID_PATH", "Path must refer to a workspace entry");
  }
  return normalized;
}

export function resolveWorkspacePath(
  workspaceRoot: string,
  rawPath: string,
  options: { allowDot?: boolean } = {},
): { relative: string; absolute: string } {
  const root = path.resolve(workspaceRoot);
  const relative = normalizeWorkspaceRelativePath(rawPath, options);
  const absolute = path.resolve(root, relative);

  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new ToolError("INVALID_PATH", "Path escapes workspace root");
  }

  return { relative, absolute };
}

export class ToolRuntime {
  workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  async ensureWorkspace() {
    await fs.mkdir(this.workspaceRoot, { recursive: true });
  }

  async listDir(input: unknown) {
    const schema = z
      .object({
        dir: z.string().default("."),
        recursive: z.boolean().default(false),
        maxEntries: z.number().int().min(1).max(2000).default(500),
      })
      .strict();
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw new ToolError("VALIDATION_ERROR", "Invalid list_dir input", parsed.error.flatten());
    }

    const { dir, recursive, maxEntries } = parsed.data;
    const { relative, absolute } = resolveWorkspacePath(this.workspaceRoot, dir, {
      allowDot: true,
    });
    const stat = await fs.stat(absolute);
    if (!stat.isDirectory()) {
      throw new ToolError("NOT_DIRECTORY", "dir must be a directory");
    }

    const entries: Array<{ path: string; type: "file" | "dir" | "symlink"; size: number }> = [];
    let truncated = false;
    const queue = [relative === "." ? "" : relative];

    while (queue.length > 0) {
      const relDir = queue.shift()!;
      const dirAbs = relDir ? path.resolve(this.workspaceRoot, relDir) : this.workspaceRoot;
      const dirEntries = await fs.readdir(dirAbs, { withFileTypes: true });

      for (const entry of dirEntries) {
        const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
        const childAbs = path.resolve(this.workspaceRoot, childRel);
        const childStat = await fs.lstat(childAbs);
        const type = entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "symlink" : "file";

        entries.push({ path: childRel, type, size: childStat.size });
        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }
        if (recursive && entry.isDirectory()) {
          queue.push(childRel);
        }
      }
      if (truncated) break;
    }

    return {
      ok: true as const,
      data: {
        dir: relative,
        entries,
        truncated,
      },
    };
  }

  async readFile(input: unknown) {
    const schema = z
      .object({
        file: z.string(),
        maxBytes: z.number().int().min(1).max(MAX_FILE_BYTES).default(DEFAULT_READ_MAX_BYTES),
      })
      .strict();
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw new ToolError("VALIDATION_ERROR", "Invalid read_file input", parsed.error.flatten());
    }

    const { file, maxBytes } = parsed.data;
    const { relative, absolute } = resolveWorkspacePath(this.workspaceRoot, file);
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) {
      throw new ToolError("NOT_FILE", "file must refer to a file");
    }
    if (stat.size > maxBytes) {
      throw new ToolError("FILE_TOO_LARGE", "File exceeds maxBytes limit", {
        size: stat.size,
        maxBytes,
      });
    }

    const content = await fs.readFile(absolute, "utf8");
    return {
      ok: true as const,
      data: {
        file: relative,
        content,
        bytes: Buffer.byteLength(content, "utf8"),
      },
    };
  }

  async writeFile(input: unknown) {
    const schema = z
      .object({
        file: z.string(),
        content: z.string(),
      })
      .strict();
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw new ToolError("VALIDATION_ERROR", "Invalid write_file input", parsed.error.flatten());
    }

    const { file, content } = parsed.data;
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES) {
      throw new ToolError("FILE_TOO_LARGE", "Content exceeds write size limit", {
        bytes,
        maxBytes: MAX_FILE_BYTES,
      });
    }

    const { relative, absolute } = resolveWorkspacePath(this.workspaceRoot, file);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf8");

    return {
      ok: true as const,
      data: {
        file: relative,
        bytesWritten: bytes,
      },
    };
  }

  async editFile(input: unknown) {
    const schema = z
      .object({
        file: z.string(),
        find: z.string().min(1),
        replace: z.string(),
        replaceAll: z.boolean().default(false),
        expectedOccurrences: z.number().int().min(1).max(1_000_000).optional(),
      })
      .strict();
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw new ToolError("VALIDATION_ERROR", "Invalid edit_file input", parsed.error.flatten());
    }

    const { file, find, replace, replaceAll, expectedOccurrences } = parsed.data;
    const { relative, absolute } = resolveWorkspacePath(this.workspaceRoot, file);

    const original = await fs.readFile(absolute, "utf8");
    const occurrences = original.split(find).length - 1;
    if (occurrences < 1) {
      throw new ToolError("PATTERN_NOT_FOUND", "find string does not exist in file");
    }
    if (expectedOccurrences !== undefined && occurrences !== expectedOccurrences) {
      throw new ToolError("EDIT_CONFLICT", "Occurrence count did not match expectedOccurrences", {
        occurrences,
        expectedOccurrences,
      });
    }

    const updated = replaceAll ? original.split(find).join(replace) : original.replace(find, replace);
    const bytes = Buffer.byteLength(updated, "utf8");
    if (bytes > MAX_FILE_BYTES) {
      throw new ToolError("FILE_TOO_LARGE", "Edited content exceeds size limit", {
        bytes,
        maxBytes: MAX_FILE_BYTES,
      });
    }

    await fs.writeFile(absolute, updated, "utf8");
    return {
      ok: true as const,
      data: {
        file: relative,
        replacements: replaceAll ? occurrences : 1,
      },
    };
  }

  async deletePath(input: unknown) {
    const schema = z
      .object({
        path: z.string(),
        recursive: z.boolean().default(false),
      })
      .strict();
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw new ToolError("VALIDATION_ERROR", "Invalid delete_file input", parsed.error.flatten());
    }

    const { path: inputPath, recursive } = parsed.data;
    const { relative, absolute } = resolveWorkspacePath(this.workspaceRoot, inputPath);
    const stat = await fs.lstat(absolute);

    if (stat.isDirectory()) {
      if (recursive) {
        await fs.rm(absolute, { recursive: true, force: false });
      } else {
        await fs.rmdir(absolute);
      }
      return {
        ok: true as const,
        data: { path: relative, deletedType: "dir" as const },
      };
    }

    await fs.unlink(absolute);
    return {
      ok: true as const,
      data: { path: relative, deletedType: "file" as const },
    };
  }

  async movePath(input: unknown) {
    const schema = z
      .object({
        from: z.string(),
        to: z.string(),
        overwrite: z.boolean().default(false),
      })
      .strict();
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw new ToolError("VALIDATION_ERROR", "Invalid move_file input", parsed.error.flatten());
    }

    const { from, to, overwrite } = parsed.data;
    const source = resolveWorkspacePath(this.workspaceRoot, from);
    const dest = resolveWorkspacePath(this.workspaceRoot, to);

    await fs.stat(source.absolute);

    const destExists = await fs
      .lstat(dest.absolute)
      .then(() => true)
      .catch(() => false);

    if (destExists && !overwrite) {
      throw new ToolError("ALREADY_EXISTS", "Destination already exists");
    }
    if (destExists && overwrite) {
      await fs.rm(dest.absolute, { recursive: true, force: false });
    }

    await fs.mkdir(path.dirname(dest.absolute), { recursive: true });
    await fs.rename(source.absolute, dest.absolute);

    return {
      ok: true as const,
      data: { from: source.relative, to: dest.relative, overwritten: destExists && overwrite },
    };
  }

  async mkdir(input: unknown) {
    const schema = z
      .object({
        dir: z.string(),
        recursive: z.boolean().default(true),
      })
      .strict();
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw new ToolError("VALIDATION_ERROR", "Invalid mkdir input", parsed.error.flatten());
    }

    const { dir, recursive } = parsed.data;
    const { relative, absolute } = resolveWorkspacePath(this.workspaceRoot, dir, {
      allowDot: true,
    });
    await fs.mkdir(absolute, { recursive });

    return {
      ok: true as const,
      data: { dir: relative, created: true },
    };
  }

  async runCommand(input: unknown) {
    const schema = z
      .object({
        command: z.string().min(1),
        args: z.array(z.string().max(400)).max(64).default([]),
        cwd: z.string().default("."),
        timeoutMs: z.number().int().min(100).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
        maxOutputBytes: z.number().int().min(1024).max(MAX_OUTPUT_BYTES).default(DEFAULT_MAX_OUTPUT_BYTES),
      })
      .strict();
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw new ToolError("VALIDATION_ERROR", "Invalid run_command input", parsed.error.flatten());
    }

    const { command, args, cwd, timeoutMs, maxOutputBytes } = parsed.data;
    if (!ALLOWED_COMMANDS.has(command)) {
      throw new ToolError("COMMAND_NOT_ALLOWED", "Command is not in allowlist", {
        command,
        allowed: [...ALLOWED_COMMANDS],
      });
    }

    const cwdPath = resolveWorkspacePath(this.workspaceRoot, cwd, { allowDot: true });
    const child = spawn(command, args, {
      cwd: cwdPath.absolute,
      shell: false,
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    const stdout = createLimitedCollector(maxOutputBytes);
    const stderr = createLimitedCollector(maxOutputBytes);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 500).unref();
    }, timeoutMs);

    try {
      const [exitCode, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
      return {
        ok: true as const,
        data: {
          command,
          args,
          cwd: cwdPath.relative,
          exitCode,
          signal,
          timedOut,
          stdout: stdout.text(),
          stderr: stderr.text(),
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function createLimitedCollector(maxBytes: number) {
  let used = 0;
  let truncated = false;
  const chunks: Buffer[] = [];

  return {
    push(chunk: Buffer) {
      if (used >= maxBytes) {
        truncated = true;
        return;
      }
      const remaining = maxBytes - used;
      if (chunk.length <= remaining) {
        chunks.push(chunk);
        used += chunk.length;
      } else {
        chunks.push(chunk.subarray(0, remaining));
        used += remaining;
        truncated = true;
      }
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    },
    get truncated() {
      return truncated;
    },
  };
}

const ListDirOutputSchema = successShape({
  dir: z.string(),
  entries: z.array(
    z
      .object({
        path: z.string(),
        type: z.enum(["file", "dir", "symlink"]),
        size: z.number(),
      })
      .strict(),
  ),
  truncated: z.boolean(),
});

const ReadFileOutputSchema = successShape({
  file: z.string(),
  content: z.string(),
  bytes: z.number(),
});

const WriteFileOutputSchema = successShape({
  file: z.string(),
  bytesWritten: z.number(),
});

const EditFileOutputSchema = successShape({
  file: z.string(),
  replacements: z.number(),
});

const DeleteOutputSchema = successShape({
  path: z.string(),
  deletedType: z.enum(["file", "dir"]),
});

const MoveOutputSchema = successShape({
  from: z.string(),
  to: z.string(),
  overwritten: z.boolean(),
});

const MkdirOutputSchema = successShape({
  dir: z.string(),
  created: z.boolean(),
});

const RunCommandOutputSchema = successShape({
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  exitCode: z.number().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
});

type AnyZodObject = z.ZodObject<Record<string, z.ZodTypeAny>>;

function registerTool(
  server: McpServer,
  runtime: ToolRuntime,
  options: {
    name: string;
    description: string;
    inputSchema: AnyZodObject;
    outputSchema: z.ZodTypeAny;
    handler: (input: unknown) => Promise<ToolJson>;
  },
) {
  const { name, description, inputSchema, outputSchema, handler } = options;
  const shape = inputSchema.shape;

  server.tool(name, description, shape, async (rawInput) => {
    try {
      const input = inputSchema.parse(rawInput);
      const result = await handler(input);
      outputSchema.parse(result);
      logToolEvent(name, "ok", {});
      return jsonContent(result);
    } catch (error) {
      const mapped = mapError(error);
      ErrorShapeSchema.parse(mapped);
      logToolEvent(name, "error", { code: (mapped.error as { code: string }).code });
      return jsonContent(mapped);
    }
  });
}

export async function registerAllTools(server: McpServer, runtime: ToolRuntime) {
  await runtime.ensureWorkspace();

  registerTool(server, runtime, {
    name: "list_dir",
    description: "List files and directories under workspace with optional recursion.",
    inputSchema: z
      .object({
        dir: z.string().default("."),
        recursive: z.boolean().default(false),
        maxEntries: z.number().int().min(1).max(2000).default(500),
      })
      .strict(),
    outputSchema: z.union([ListDirOutputSchema, ErrorShapeSchema]),
    handler: (input) => runtime.listDir(input),
  });

  registerTool(server, runtime, {
    name: "read_file",
    description: "Read UTF-8 text from a workspace file with file-size limit.",
    inputSchema: z
      .object({
        file: z.string(),
        maxBytes: z.number().int().min(1).max(MAX_FILE_BYTES).default(DEFAULT_READ_MAX_BYTES),
      })
      .strict(),
    outputSchema: z.union([ReadFileOutputSchema, ErrorShapeSchema]),
    handler: (input) => runtime.readFile(input),
  });

  registerTool(server, runtime, {
    name: "edit_file",
    description: "Apply targeted string replacement in a workspace file.",
    inputSchema: z
      .object({
        file: z.string(),
        find: z.string().min(1),
        replace: z.string(),
        replaceAll: z.boolean().default(false),
        expectedOccurrences: z.number().int().min(1).max(1_000_000).optional(),
      })
      .strict(),
    outputSchema: z.union([EditFileOutputSchema, ErrorShapeSchema]),
    handler: (input) => runtime.editFile(input),
  });

  registerTool(server, runtime, {
    name: "write_file",
    description: "Create or overwrite a UTF-8 workspace file.",
    inputSchema: z
      .object({
        file: z.string(),
        content: z.string(),
      })
      .strict(),
    outputSchema: z.union([WriteFileOutputSchema, ErrorShapeSchema]),
    handler: (input) => runtime.writeFile(input),
  });

  registerTool(server, runtime, {
    name: "delete_file",
    description: "Delete a workspace file or directory (recursive optional).",
    inputSchema: z
      .object({
        path: z.string(),
        recursive: z.boolean().default(false),
      })
      .strict(),
    outputSchema: z.union([DeleteOutputSchema, ErrorShapeSchema]),
    handler: (input) => runtime.deletePath(input),
  });

  registerTool(server, runtime, {
    name: "move_file",
    description: "Move or rename files/directories within workspace.",
    inputSchema: z
      .object({
        from: z.string(),
        to: z.string(),
        overwrite: z.boolean().default(false),
      })
      .strict(),
    outputSchema: z.union([MoveOutputSchema, ErrorShapeSchema]),
    handler: (input) => runtime.movePath(input),
  });

  registerTool(server, runtime, {
    name: "mkdir",
    description: "Create a workspace directory.",
    inputSchema: z
      .object({
        dir: z.string(),
        recursive: z.boolean().default(true),
      })
      .strict(),
    outputSchema: z.union([MkdirOutputSchema, ErrorShapeSchema]),
    handler: (input) => runtime.mkdir(input),
  });

  registerTool(server, runtime, {
    name: "run_command",
    description:
      "Run an allowlisted command inside workspace with cwd sandboxing, timeout, and output limits.",
    inputSchema: z
      .object({
        command: z.string().min(1),
        args: z.array(z.string().max(400)).max(64).default([]),
        cwd: z.string().default("."),
        timeoutMs: z.number().int().min(100).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
        maxOutputBytes: z.number().int().min(1024).max(MAX_OUTPUT_BYTES).default(DEFAULT_MAX_OUTPUT_BYTES),
      })
      .strict(),
    outputSchema: z.union([RunCommandOutputSchema, ErrorShapeSchema]),
    handler: (input) => runtime.runCommand(input),
  });
}

