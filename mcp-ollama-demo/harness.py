import json
import asyncio
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
                    return decision.get("message") or decision.get("final", "")

                if mode != "action":
                    raise RuntimeError(f"Invalid decision mode: {mode!r}\nRaw:\n{raw}")

                tool_name = decision["tool"]
                args = decision.get("args", {})

                result = await session.call_tool(tool_name, args)

                tool_text = "\n".join(
                    c.text
                    for c in result.content
                    if getattr(c, "type", None) == "text"
                )

                # Feed tool result back into conversation
                messages.append({"role": "assistant", "content": raw})
                messages.append(
                    {"role": "user", "content": f"Tool result:\n{tool_text}"}
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
