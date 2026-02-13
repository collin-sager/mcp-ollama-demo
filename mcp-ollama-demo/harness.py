import json
import asyncio
import re
import traceback
import requests
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

# Change model if desired
MODEL = "qwen2.5:7b"
OLLAMA_CHAT = "http://localhost:11434/api/chat"

SYSTEM = """You are an MCP assistant that can either chat or take actions with tools.

Decide the best next step based on the user request and tool results so far.

Return EXACTLY ONE JSON object (no markdown, no prose outside JSON) in one of these forms:

1) Conversational reply:
{"mode":"chat","message":"<your response to the user>"}

2) Tool call:
{"mode":"action","tool":"<tool_name>","args":{...}}

Rules:
- Use "chat" for normal conversation, clarifying questions, and when no tool is needed.
- Use "action" when a tool call is needed to fulfill the request.
- If using "action", call exactly one tool per response.
- If the user asks to list/read/write/edit/move/delete files or directories, prefer "action" with the relevant file tool.
- For "list ... in workspace" style requests, call "list_dir" with {"dir":"."} unless the user specifies a subdirectory.
- Do not return an empty chat message.
- Keep responses concise and helpful.
"""


REPAIR_SYSTEM = """You fix malformed JSON.

Given model output that should be a single JSON object, return a corrected single JSON object.

Rules:
- Output JSON only.
- Do not wrap in markdown/code fences.
- Preserve original intent and fields.
- Escape newlines and control characters inside strings.
"""


def ollama_decide(tools_schema, messages):
    payload = {
        "model": MODEL,
        "stream": False,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "system", "content": "Available tools:\n" + json.dumps(tools_schema)},
            *messages,
        ],
    }

    r = requests.post(OLLAMA_CHAT, json=payload, timeout=120)
    r.raise_for_status()
    return r.json()["message"]["content"]


def ollama_repair_json(raw_text):
    payload = {
        "model": MODEL,
        "stream": False,
        "messages": [
            {"role": "system", "content": REPAIR_SYSTEM},
            {
                "role": "user",
                "content": "Repair this into one valid JSON object only:\n" + raw_text,
            },
        ],
    }

    r = requests.post(OLLAMA_CHAT, json=payload, timeout=120)
    r.raise_for_status()
    return r.json()["message"]["content"]


def decide_with_repair(tools_schema, messages):
    raw = ollama_decide(tools_schema, messages)
    try:
        return parse_first_json_object(raw), raw
    except Exception:
        repaired = ollama_repair_json(raw)
        try:
            return parse_first_json_object(repaired), repaired
        except Exception as exc:
            raise RuntimeError(
                "Ollama returned malformed JSON and repair failed.\n"
                f"Original:\n{raw}\n\nRepaired:\n{repaired}"
            ) from exc


DEFERRED_ACTION_RE = re.compile(
    r"\b(let me|i(?:'| wi)ll|allow me|i can check|i can look|i can verify)\b",
    re.IGNORECASE,
)


def looks_like_deferred_action_chat(message: str) -> bool:
    return bool(message and DEFERRED_ACTION_RE.search(message))


async def run(prompt: str, max_steps: int = 8):
    # Launch MCP server as child process
    server_params = StdioServerParameters(
        command="npx",
        args=["tsx", "server.ts"],
    )

    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            tools = await session.list_tools()
            tools_schema = [
                {
                    "name": t.name,
                    "description": t.description,
                    "inputSchema": t.inputSchema,
                }
                for t in tools.tools
            ]

            messages = [{"role": "user", "content": prompt}]

            try:
                for step in range(max_steps):
                    decision, raw = decide_with_repair(tools_schema, messages)

                    mode = decision.get("mode")

                    # Backward compatibility with old schema:
                    # {"tool": "...", "args": {...}} or {"final": "..."}
                    if mode is None:
                        if decision.get("tool") is not None:
                            mode = "action"
                        else:
                            mode = "chat"

                    if mode == "chat":
                        message = decision.get("message") or decision.get("final", "")
                        # Avoid ending the turn on "I'll check..." planning chatter.
                        if message and looks_like_deferred_action_chat(message) and step < max_steps - 1:
                            messages.append({"role": "assistant", "content": raw})
                            messages.append(
                                {
                                    "role": "user",
                                    "content": (
                                        "Do not narrate intent. Either call one tool now, "
                                        "or return a direct final answer based on available context."
                                    ),
                                }
                            )
                            continue

                        if message:
                            return message
                        return f"(empty chat response)\nRaw model output:\n{raw}"

                    if mode != "action":
                        raise RuntimeError(f"Invalid decision mode: {mode!r}\nRaw:\n{raw}")

                    tool_name = decision.get("tool")
                    if not tool_name:
                        raise RuntimeError(f"Action mode missing tool name.\nRaw:\n{raw}")

                    args = decision.get("args", {})
                    if isinstance(args, dict):
                        args_list = [args]
                    elif isinstance(args, list) and all(isinstance(a, dict) for a in args):
                        args_list = args
                    else:
                        raise RuntimeError(
                            "Action args must be a JSON object or a list of JSON objects.\n"
                            f"Raw:\n{raw}"
                        )

                    if len(args_list) > 20:
                        raise RuntimeError(
                            f"Refusing oversized batched action with {len(args_list)} calls (max 20)."
                        )

                    tool_results = []
                    for one_args in args_list:
                        result = await session.call_tool(tool_name, one_args)
                        tool_text = "\n".join(
                            c.text
                            for c in result.content
                            if getattr(c, "type", None) == "text"
                        )
                        tool_results.append(tool_text)

                    # Feed tool result(s) back into conversation
                    messages.append({"role": "assistant", "content": raw})
                    joined_results = "\n\n".join(
                        f"Result {idx + 1}:\n{txt}" for idx, txt in enumerate(tool_results)
                    )
                    messages.append(
                        {"role": "user", "content": f"Tool result:\n{joined_results}"}
                    )
            except Exception as exc:
                return (
                    "Tool loop error.\n"
                    f"{type(exc).__name__}: {exc}\n"
                    f"{traceback.format_exc(limit=3)}"
                )

            return "(stopped: max steps reached)"

def parse_first_json_object(s: str):
    s = s.strip()
    decoder = json.JSONDecoder()
    obj, _idx = decoder.raw_decode(s)   # raw_decode parses the first JSON value only
    return obj

async def main():
    print("Type 'exit' to quit.\n")

    while True:
        user_input = input(">>> ")

        if user_input.lower() in ["exit", "quit"]:
            break

        try:
            result = await run(user_input)
            print("\n--- RESULT ---")
            print(result)
            print()
        except Exception as exc:
            print("\n--- ERROR ---")
            print(exc)
            print()

if __name__ == "__main__":
    asyncio.run(main())
