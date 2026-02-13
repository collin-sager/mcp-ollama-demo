# Security Model

## Scope

This MCP server provides constrained filesystem and command tools inside `workspace/`.
It is designed to reduce risk from path traversal, command injection, oversized outputs, and accidental destructive actions.

## Threat Model

Primary threats:
- Path traversal (`../`, absolute paths, symlink tricks).
- Duplicate root confusion (`workspace/workspace/...`) causing unintended paths.
- Command injection via shell metacharacters.
- Output flooding (very large stdout/stderr).
- Resource abuse (long-running commands or large file payloads).
- Supply-chain risk from package managers and external executables.

Non-goals:
- Full sandboxing against a fully malicious local user.
- OS/container isolation beyond workspace path enforcement and allowlists.

## Guardrails

## 1) Path Traversal Controls

- Every tool path goes through `normalizeWorkspaceRelativePath()` and `resolveWorkspacePath()`.
- Rejections:
  - Absolute paths.
  - Any `..` segment.
  - Null bytes.
  - Any path that resolves outside workspace.
- Normalization:
  - Leading `workspace/` prefixes are stripped repeatedly, preventing `workspace/workspace/...` duplication.
- Filesystem actions run only on canonicalized workspace paths.

## 2) Schema Validation

- All tool inputs use strict Zod schemas (`.strict()`).
- Unknown keys are rejected.
- Numeric limits enforce safe ranges (timeouts, output caps, entry counts).
- Tool responses are validated against output schemas before returning.

## 3) File Safety Limits

- Max read/write file size is capped (`MAX_FILE_BYTES`).
- `read_file` additionally enforces caller-provided `maxBytes` within server bounds.
- `list_dir` enforces `maxEntries` to avoid unbounded traversal.

## 4) Command Execution Controls

- `run_command` uses allowlisted binaries only:
  - `node`, `npm`, `npx`, `python3`, `pytest`, `tsc`.
- Spawn uses `shell:false` and argument arrays; shell metacharacters are not interpreted.
- `cwd` is canonicalized to workspace-relative path only.
- Timeout enforced with SIGTERM then SIGKILL.
- Stdout/stderr captured with byte caps and truncation flags.

## 5) Logging Strategy

- Structured logs are emitted to stderr with:
  - timestamp
  - tool name
  - status (`ok` / `error`)
  - error code (on failure)
- Logs intentionally omit file contents and command output payloads.

## Residual Risks

- Allowlisted commands can still execute risky operations within workspace (for example `npm install` side effects).
- Symlink handling is constrained by root checks but depends on host filesystem semantics.
- Dependencies of allowlisted tools may introduce supply-chain risk.

## Operational Recommendations

- Keep allowlist minimal; review periodically.
- Prefer read/write/edit/delete tools over `run_command` when possible.
- Run this server in an isolated environment for untrusted prompts.
- Pin dependencies and scan lockfiles for vulnerable packages.
