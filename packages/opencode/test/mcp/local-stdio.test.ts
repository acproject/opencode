import { test, expect } from "bun:test"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { tmpdir } from "../fixture/fixture"

test(
  "local MCP stdio server lists tools and fails fast on interactive permissions",
  async () => {
  await using tmp = await tmpdir({
    config: {
      permission: {
        bash: "ask",
      },
    },
  })

  const opencodeDir = path.resolve(import.meta.dir, "..", "..")
  const env: Record<string, string> = {
    BUN_TEST: "1",
    NODE_ENV: "test",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  }
  for (const key of [
    "OPENCODE_TEST_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "OPENCODE_DISABLE_MODELS_FETCH",
  ]) {
    const value = process.env[key]
    if (value) env[key] = value
  }

  const transport = new StdioClientTransport({
    command: "bun",
    args: ["./src/index.ts", "mcp", "start", "--directory", tmp.path],
    cwd: opencodeDir,
    stderr: "ignore",
    env,
  })

  const client = new Client({ name: "mcp-local-test", version: "0.0.0" })
  await client.connect(transport)

  try {
    const tools = await client.listTools()
    expect(tools.tools.length).toBeGreaterThan(0)
    expect(tools.tools.some((t) => t.name === "read")).toBe(true)
    const readTool = tools.tools.find((t) => t.name === "read")
    expect(readTool).toBeDefined()
    expect(readTool?.inputSchema && typeof readTool.inputSchema === "object").toBe(true)
    const readSchema = readTool?.inputSchema as any
    expect(readSchema.type).toBe("object")
    expect(readSchema.properties?.filePath).toBeDefined()

    const result = (await client.callTool(
      {
        name: "terminal",
        arguments: { command: "echo hi", keepAlive: false },
      },
      CallToolResultSchema,
    )) as CallToolResult

    expect(result.isError).toBe(true)
    const first = result.content[0]
    expect(first?.type).toBe("text")
    if (first?.type === "text") {
      expect(first.text).toContain("non-interactive")
    }
  } finally {
    await client.close()
  }
  },
  20_000,
)
