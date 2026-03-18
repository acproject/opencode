import { describe, expect, test } from "bun:test"
import path from "path"
import { ReadTool } from "../../src/tool/read"
import { GrepTool } from "../../src/tool/grep"
import { GlobTool } from "../../src/tool/glob"
import { EditTool } from "../../src/tool/edit"
import { WriteTool } from "../../src/tool/write"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"
import { LangChainToolRuntime } from "../../src/runtime/tool-runtime-langchain"
import { Tool } from "../../src/tool/tool"
import z from "zod"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  metadata: async () => {},
  ask: async () => {},
}

describe("runtime.langchain", () => {
  test("executes base tools via LangChain runtime", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { lsp: false },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("readFile")
        expect(ids).toContain("writeFile")
        expect(ids).toContain("editFile")

        const { ToolRuntime } = await import("../../src/runtime/tool-runtime")
        const runtime = await ToolRuntime.current()
        const enabled =
          process.env.OPENCODE_EXPERIMENTAL?.toLowerCase() === "true" ||
          process.env.OPENCODE_EXPERIMENTAL === "1" ||
          process.env.OPENCODE_EXPERIMENTAL_LANGCHAIN_TOOL_RUNTIME?.toLowerCase() === "true" ||
          process.env.OPENCODE_EXPERIMENTAL_LANGCHAIN_TOOL_RUNTIME === "1"
        expect(runtime.id).toBe(enabled ? "langchain" : "direct")

        const filePath = path.join(tmp.path, "a.txt")

        const write = { id: WriteTool.id, ...(await WriteTool.init()) }
        await runtime.execute({
          tool: write,
          args: { filePath, content: "hello\nworld\n" },
          ctx,
        })
        expect(await Bun.file(filePath).text()).toBe("hello\nworld\n")

        const read = { id: ReadTool.id, ...(await ReadTool.init()) }
        const readResult = await runtime.execute({
          tool: read,
          args: { filePath },
          ctx,
        })
        expect(readResult.output).toContain("hello")

        const grep = { id: GrepTool.id, ...(await GrepTool.init()) }
        const grepResult = await runtime.execute({
          tool: grep,
          args: { pattern: "world", path: tmp.path },
          ctx,
        })
        expect(grepResult.metadata.matches).toBeGreaterThan(0)

        const glob = { id: GlobTool.id, ...(await GlobTool.init()) }
        const globResult = await runtime.execute({
          tool: glob,
          args: { pattern: "*.txt", path: tmp.path },
          ctx,
        })
        expect(globResult.output).toContain(filePath)

        const edit = { id: EditTool.id, ...(await EditTool.init()) }
        await runtime.execute({
          tool: edit,
          args: { filePath, oldString: "world", newString: "bun" },
          ctx,
        })
        expect(await Bun.file(filePath).text()).toContain("bun")
      },
    })
  }, 60000)

  test("passes metadata and ask through LangChain runtime", async () => {
    const metadataCalls: Array<{ title?: string; metadata?: any }> = []
    const askCalls: any[] = []

    const runtime = LangChainToolRuntime.create()
    expect(runtime.id).toBe("langchain")

    const TestTool = Tool.define("test", {
      description: "test",
      parameters: z.object({ value: z.string() }),
      async execute(_params, toolCtx) {
        await toolCtx.metadata({ title: "t1", metadata: { step: 1 } })
        await toolCtx.ask({
          permission: "read",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        } as any)
        await toolCtx.metadata({ title: "t2", metadata: { step: 2 } })
        return { title: "ok", metadata: {}, output: "ok" }
      },
    })

    const tool = { id: TestTool.id, ...(await TestTool.init()) }
    await runtime.execute({
      tool,
      args: { value: "x" },
      ctx: {
        ...ctx,
        metadata: async (val) => {
          metadataCalls.push(val)
        },
        ask: async (req) => {
          askCalls.push(req)
        },
      },
    })

    expect(metadataCalls.map((c) => c.title)).toEqual(["t1", "t2"])
    expect(askCalls.length).toBe(1)
  })

  test("propagates abort signal through LangChain runtime", async () => {
    const runtime = LangChainToolRuntime.create()

    const AbortableTool = Tool.define("abortable", {
      description: "abortable",
      parameters: z.object({}),
      async execute(_params, toolCtx) {
        await new Promise<void>((resolve, reject) => {
          if (toolCtx.abort.aborted) reject(toolCtx.abort.reason ?? new Error("aborted"))
          const t = setTimeout(resolve, 5000)
          toolCtx.abort.addEventListener(
            "abort",
            () => {
              clearTimeout(t)
              reject(toolCtx.abort.reason ?? new Error("aborted"))
            },
            { once: true },
          )
        })
        return { title: "ok", metadata: {}, output: "ok" }
      },
    })

    const tool = { id: AbortableTool.id, ...(await AbortableTool.init()) }
    const ac = new AbortController()

    const p = runtime.execute({
      tool,
      args: {},
      ctx: {
        ...ctx,
        abort: ac.signal,
      },
    })
    ac.abort(new Error("aborted"))

    await expect(p).rejects.toBeDefined()
  })

  test("keeps validation error messages consistent for aliased tools", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { lsp: false },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools("opencode")
        const editFile = tools.find((t) => t.id === "editFile")
        expect(editFile).toBeDefined()

        let directMessage = ""
        try {
          await (editFile as any).execute({ newString: "x" }, ctx)
        } catch (e: any) {
          directMessage = e?.message ?? String(e)
        }

        const runtime = LangChainToolRuntime.create()
        let langchainMessage = ""
        try {
          await runtime.execute({ tool: editFile as any, args: { newString: "x" }, ctx })
        } catch (e: any) {
          langchainMessage = e?.message ?? String(e)
        }

        expect(directMessage).toContain("The edit tool was called with invalid arguments")
        expect(langchainMessage).toContain("The edit tool was called with invalid arguments")
      },
    })
  })
})
