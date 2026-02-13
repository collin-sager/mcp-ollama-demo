"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
var stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
var zod_1 = require("zod");
var promises_1 = require("node:fs/promises");
var node_path_1 = require("node:path");
var ROOT = node_path_1.default.resolve(process.cwd(), "workspace");
function safePath(rel) {
    var p = node_path_1.default.resolve(ROOT, rel);
    if (!p.startsWith(ROOT))
        throw new Error("Path escapes workspace/");
    return p;
}
await promises_1.default.mkdir(ROOT, { recursive: true });
var server = new mcp_js_1.McpServer({ name: "mcp-ollama-demo", version: "0.1.0" });
server.tool("list_dir", "List files under workspace/ (relative path).", { dir: zod_1.z.string().default(".") }, function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
    var full, entries, out;
    var dir = _b.dir;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0:
                full = safePath(dir);
                return [4 /*yield*/, promises_1.default.readdir(full, { withFileTypes: true })];
            case 1:
                entries = _c.sent();
                out = entries.map(function (e) { return "".concat(e.isDirectory() ? "d" : "f", "  ").concat(e.name); }).join("\n");
                return [2 /*return*/, { content: [{ type: "text", text: out || "(empty)" }] }];
        }
    });
}); });
server.tool("read_file", "Read a UTF-8 text file under workspace/.", { file: zod_1.z.string() }, function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
    var full, text;
    var file = _b.file;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0:
                full = safePath(file);
                return [4 /*yield*/, promises_1.default.readFile(full, "utf8")];
            case 1:
                text = _c.sent();
                return [2 /*return*/, { content: [{ type: "text", text: text }] }];
        }
    });
}); });
server.tool("write_file", "Write a UTF-8 text file under workspace/. Creates parent dirs.", { file: zod_1.z.string(), content: zod_1.z.string() }, function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
    var full;
    var file = _b.file, content = _b.content;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0:
                full = safePath(file);
                return [4 /*yield*/, promises_1.default.mkdir(node_path_1.default.dirname(full), { recursive: true })];
            case 1:
                _c.sent();
                return [4 /*yield*/, promises_1.default.writeFile(full, content, "utf8")];
            case 2:
                _c.sent();
                return [2 /*return*/, { content: [{ type: "text", text: "Wrote ".concat(file) }] }];
        }
    });
}); });
await server.connect(new stdio_js_1.StdioServerTransport());
