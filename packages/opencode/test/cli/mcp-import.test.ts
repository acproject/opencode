import { test, expect, mock, beforeEach } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"

const xdgRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-mcp-import-"))
process.env["XDG_CONFIG_HOME"] = xdgRoot
process.env["XDG_DATA_HOME"] = xdgRoot
process.env["XDG_STATE_HOME"] = xdgRoot
process.env["XDG_CACHE_HOME"] = xdgRoot

const logs: string[] = []

mock.module("@clack/prompts", () => ({
  intro: () => {},
  outro: () => {},
  log: {
    info: (msg: unknown) => logs.push(String(msg)),
    success: (msg: unknown) => logs.push(String(msg)),
    warn: (msg: unknown) => logs.push(String(msg)),
    error: (msg: unknown) => logs.push(String(msg)),
  },
  confirm: async () => false,
  select: async () => {
    throw new Error("select should not be called in these tests")
  },
  text: async () => {
    throw new Error("text should not be called in these tests")
  },
  password: async () => {
    throw new Error("password should not be called in these tests")
  },
  spinner: () => ({
    start: () => {},
    stop: () => {},
  }),
  isCancel: () => false,
}))

const { McpImportCommand } = await import("../../src/cli/cmd/mcp")

beforeEach(() => {
  logs.length = 0
})

test("imports mcp map into project config", async () => {
  await using tmp = await tmpdir()
  const prev = process.cwd()
  process.chdir(tmp.path)
  try {
    await McpImportCommand.handler({
      project: true,
      overwrite: true,
      json: JSON.stringify({
        mcp: {
          alpha: {
            type: "local",
            command: ["node", "/tmp/mcp-bridge.js"],
            enabled: true,
          },
        },
      }),
    } as any)

    const filepath = path.join(tmp.path, ".opencode", "opencode.json")
    const raw = await fs.readFile(filepath, "utf8")
    const parsed = JSON.parse(raw)
    expect(parsed.$schema).toBe("https://opencode.ai/config.json")
    expect(parsed.mcp.alpha).toEqual({
      type: "local",
      command: ["node", "/tmp/mcp-bridge.js"],
      enabled: true,
    })
  } finally {
    process.chdir(prev)
  }
})

test("skips existing server when overwrite is false", async () => {
  await using tmp = await tmpdir()
  const prev = process.cwd()
  process.chdir(tmp.path)
  try {
    const filepath = path.join(tmp.path, ".opencode", "opencode.json")
    await fs.mkdir(path.dirname(filepath), { recursive: true })
    await fs.writeFile(
      filepath,
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          mcp: {
            alpha: {
              type: "local",
              command: ["node", "/original.js"],
              enabled: false,
            },
          },
        },
        null,
        2,
      ),
    )

    await McpImportCommand.handler({
      project: true,
      overwrite: false,
      json: JSON.stringify({
        mcp: {
          alpha: {
            type: "local",
            command: ["node", "/new.js"],
            enabled: true,
          },
        },
      }),
    } as any)

    const raw = await fs.readFile(filepath, "utf8")
    const parsed = JSON.parse(raw)
    expect(parsed.mcp.alpha).toEqual({
      type: "local",
      command: ["node", "/original.js"],
      enabled: false,
    })
  } finally {
    process.chdir(prev)
  }
})

test("imports a single entry with --name", async () => {
  await using tmp = await tmpdir()
  const prev = process.cwd()
  process.chdir(tmp.path)
  try {
    await McpImportCommand.handler({
      project: true,
      overwrite: true,
      name: "remote1",
      json: JSON.stringify({
        type: "remote",
        url: "https://example.com/mcp",
        oauth: false,
        enabled: true,
      }),
    } as any)

    const filepath = path.join(tmp.path, ".opencode", "opencode.json")
    const raw = await fs.readFile(filepath, "utf8")
    const parsed = JSON.parse(raw)
    expect(parsed.mcp.remote1).toEqual({
      type: "remote",
      url: "https://example.com/mcp",
      oauth: false,
      enabled: true,
    })
  } finally {
    process.chdir(prev)
  }
})

