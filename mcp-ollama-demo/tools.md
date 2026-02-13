# MCP Tools Reference

All tools return a JSON envelope in `content[0].text`.

## Shared Error Shape

```json
{
  "ok": false,
  "error": {
    "code": "STRING_CODE",
    "message": "Human-readable message",
    "details": {}
  }
}
```

Common error codes:
- `VALIDATION_ERROR`
- `INVALID_PATH`
- `NOT_FOUND`
- `NOT_FILE`
- `NOT_DIRECTORY`
- `ALREADY_EXISTS`
- `DIRECTORY_NOT_EMPTY`
- `FILE_TOO_LARGE`
- `PATTERN_NOT_FOUND`
- `EDIT_CONFLICT`
- `COMMAND_NOT_ALLOWED`
- `INTERNAL_ERROR`

Path handling for all path fields:
- Only workspace-relative paths are allowed.
- Absolute paths are rejected.
- Any `..` segment is rejected.
- Leading `workspace/` is normalized away (e.g. `workspace/workspace/a.txt` -> `a.txt`).

## `list_dir`

Input schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "dir": { "type": "string", "default": "." },
    "recursive": { "type": "boolean", "default": false },
    "maxEntries": { "type": "integer", "minimum": 1, "maximum": 2000, "default": 500 }
  }
}
```

Output schema:
```json
{
  "ok": true,
  "data": {
    "dir": "string",
    "entries": [
      { "path": "string", "type": "file|dir|symlink", "size": 123 }
    ],
    "truncated": false
  }
}
```

Error cases:
- `INVALID_PATH`, `NOT_DIRECTORY`, `NOT_FOUND`, `VALIDATION_ERROR`.

Security notes:
- Directory traversal blocked by canonicalization utility.
- Entry count bounded by `maxEntries`.

Manual tests:
- Request: `{"dir": ".", "recursive": false}` -> success with entries array.
- Request: `{"dir": "../"}` -> `ok:false`, `error.code:"INVALID_PATH"`.
- Request: `{"dir": "workspace/workspace"}` -> success, normalized dir `"."`.

## `read_file`

Input schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["file"],
  "properties": {
    "file": { "type": "string" },
    "maxBytes": { "type": "integer", "minimum": 1, "maximum": 1048576, "default": 262144 }
  }
}
```

Output schema:
```json
{
  "ok": true,
  "data": {
    "file": "string",
    "content": "string",
    "bytes": 10
  }
}
```

Error cases:
- `INVALID_PATH`, `NOT_FOUND`, `NOT_FILE`, `FILE_TOO_LARGE`, `VALIDATION_ERROR`.

Security notes:
- Read size bounded by `maxBytes`.
- Path canonicalization enforces workspace root.

Manual tests:
- Request: `{"file":"notes.txt"}` -> returns content and bytes.
- Request: `{"file":"/etc/passwd"}` -> `INVALID_PATH`.
- Request: `{"file":"big.txt","maxBytes":16}` (for a larger file) -> `FILE_TOO_LARGE`.

## `edit_file`

Input schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["file", "find", "replace"],
  "properties": {
    "file": { "type": "string" },
    "find": { "type": "string", "minLength": 1 },
    "replace": { "type": "string" },
    "replaceAll": { "type": "boolean", "default": false },
    "expectedOccurrences": { "type": "integer", "minimum": 1, "maximum": 1000000 }
  }
}
```

Output schema:
```json
{
  "ok": true,
  "data": {
    "file": "string",
    "replacements": 1
  }
}
```

Error cases:
- `INVALID_PATH`, `NOT_FOUND`, `PATTERN_NOT_FOUND`, `EDIT_CONFLICT`, `FILE_TOO_LARGE`, `VALIDATION_ERROR`.

Security notes:
- Uses explicit find/replace only (no shell, no regex execution).
- Enforces file size ceiling before write.

Manual tests:
- Request: `{"file":"a.txt","find":"old","replace":"new"}` -> success with `replacements:1`.
- Request: `{"file":"a.txt","find":"missing","replace":"x"}` -> `PATTERN_NOT_FOUND`.
- Request: `{"file":"a.txt","find":"x","replace":"y","expectedOccurrences":2}` when actual is 1 -> `EDIT_CONFLICT`.

## `write_file`

Input schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["file", "content"],
  "properties": {
    "file": { "type": "string" },
    "content": { "type": "string" }
  }
}
```

Output schema:
```json
{
  "ok": true,
  "data": {
    "file": "string",
    "bytesWritten": 42
  }
}
```

Error cases:
- `INVALID_PATH`, `FILE_TOO_LARGE`, `VALIDATION_ERROR`.

Security notes:
- Write size bounded to 1 MiB.
- Auto-creates parent directories under workspace only.

Manual tests:
- Request: `{"file":"src/index.html","content":"<h1>Hi</h1>"}` -> success.
- Request: `{"file":"../x.txt","content":"x"}` -> `INVALID_PATH`.

## `delete_file`

Input schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["path"],
  "properties": {
    "path": { "type": "string" },
    "recursive": { "type": "boolean", "default": false }
  }
}
```

Output schema:
```json
{
  "ok": true,
  "data": {
    "path": "string",
    "deletedType": "file|dir"
  }
}
```

Error cases:
- `INVALID_PATH`, `NOT_FOUND`, `DIRECTORY_NOT_EMPTY`, `VALIDATION_ERROR`.

Security notes:
- Delete restricted to canonicalized workspace path.
- Non-recursive directory delete fails safely.

Manual tests:
- Request: `{"path":"tmp/a.txt"}` -> success with `deletedType:"file"`.
- Request: `{"path":"tmp","recursive":false}` on non-empty dir -> `DIRECTORY_NOT_EMPTY`.
- Request: `{"path":"workspace/../secret"}` -> `INVALID_PATH`.

## `move_file`

Input schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["from", "to"],
  "properties": {
    "from": { "type": "string" },
    "to": { "type": "string" },
    "overwrite": { "type": "boolean", "default": false }
  }
}
```

Output schema:
```json
{
  "ok": true,
  "data": {
    "from": "string",
    "to": "string",
    "overwritten": false
  }
}
```

Error cases:
- `INVALID_PATH`, `NOT_FOUND`, `ALREADY_EXISTS`, `VALIDATION_ERROR`.

Security notes:
- Both source and destination are workspace-canonicalized.
- `overwrite` gate prevents accidental replacement.

Manual tests:
- Request: `{"from":"a.txt","to":"archive/a.txt"}` -> success.
- Request: `{"from":"a.txt","to":"b.txt","overwrite":false}` when `b.txt` exists -> `ALREADY_EXISTS`.
- Request: `{"from":"/tmp/a","to":"x"}` -> `INVALID_PATH`.

## `mkdir`

Input schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["dir"],
  "properties": {
    "dir": { "type": "string" },
    "recursive": { "type": "boolean", "default": true }
  }
}
```

Output schema:
```json
{
  "ok": true,
  "data": {
    "dir": "string",
    "created": true
  }
}
```

Error cases:
- `INVALID_PATH`, `NOT_FOUND` (for non-recursive parent missing), `VALIDATION_ERROR`.

Security notes:
- Directory creation constrained to workspace root.

Manual tests:
- Request: `{"dir":"src/components","recursive":true}` -> success.
- Request: `{"dir":"../outside"}` -> `INVALID_PATH`.

## `run_command`

Input schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["command"],
  "properties": {
    "command": { "type": "string", "minLength": 1 },
    "args": { "type": "array", "items": { "type": "string", "maxLength": 400 }, "maxItems": 64, "default": [] },
    "cwd": { "type": "string", "default": "." },
    "timeoutMs": { "type": "integer", "minimum": 100, "maximum": 60000, "default": 15000 },
    "maxOutputBytes": { "type": "integer", "minimum": 1024, "maximum": 262144, "default": 65536 }
  }
}
```

Output schema:
```json
{
  "ok": true,
  "data": {
    "command": "string",
    "args": ["string"],
    "cwd": "string",
    "exitCode": 0,
    "signal": null,
    "timedOut": false,
    "stdout": "string",
    "stderr": "string",
    "stdoutTruncated": false,
    "stderrTruncated": false
  }
}
```

Error cases:
- `COMMAND_NOT_ALLOWED`, `INVALID_PATH`, `VALIDATION_ERROR`, `NOT_FOUND` (cwd).

Security notes:
- Command allowlist only: `node`, `npm`, `npx`, `python3`, `pytest`, `tsc`.
- `shell:false` to prevent shell injection.
- CWD forced to workspace-relative path.
- Timeout enforced, process terminated on timeout.
- Stdout/stderr independently truncated by byte cap.
- Structured logging records tool name/status/error code only (no command output content).

Manual tests:
- Request: `{"command":"npm","args":["--version"]}` -> success, exitCode 0.
- Request: `{"command":"bash","args":["-lc","echo hi"]}` -> `COMMAND_NOT_ALLOWED`.
- Request: `{"command":"npm","args":["run","x"],"cwd":"../"}` -> `INVALID_PATH`.
- Request: `{"command":"node","args":["-e","setTimeout(()=>{},100000)"],"timeoutMs":200}` -> success with `timedOut:true` (if executed manually).
