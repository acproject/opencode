import { describe, expect, mock, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"

let lastStreamInput: any
let scenario: "default" | "toolcall" = "default"
let callIndex = 0

mock.module("../../src/session/llm", () => ({
  LLM: {
    stream: async (input: any) => {
      lastStreamInput = input
      const idx = callIndex++
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          if (scenario === "toolcall" && idx === 0) {
            yield {
              type: "tool-call",
              toolCallId: "tc1",
              toolName: "echo",
              input: { text: "hi" },
            }
          }
          yield { type: "finish" }
        })(),
        response: Promise.resolve({ messages: [] }),
      }
    },
  },
}))

describe("runtime.orchestrator.langchain", () => {
  test("selects runtime by flag and injects maxSteps", async () => {
    scenario = "default"
    callIndex = 0
    const enabled =
      process.env.OPENCODE_EXPERIMENTAL?.toLowerCase() === "true" ||
      process.env.OPENCODE_EXPERIMENTAL === "1" ||
      process.env.OPENCODE_EXPERIMENTAL_LANGCHAIN_ORCHESTRATOR?.toLowerCase() === "true" ||
      process.env.OPENCODE_EXPERIMENTAL_LANGCHAIN_ORCHESTRATOR === "1"

    await using tmp = await tmpdir({ git: true, config: { lsp: false } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { OrchestratorRuntime } = await import("../../src/runtime/orchestrator-runtime")
        const runtime = await OrchestratorRuntime.current()
        expect(runtime.id).toBe(enabled ? "langchain" : "direct")

        lastStreamInput = undefined
        const stream = await runtime.stream({
          user: {
            id: "m-user",
            sessionID: "s",
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model: {},
          },
          sessionID: "s",
          model: { id: "m", providerID: "p", capabilities: { toolcall: true } } as any,
          agent: { name: "build", options: {}, permission: [], mode: "primary" } as any,
          system: [],
          abort: AbortSignal.any([]),
          messages: [],
          tools: {},
        } as any)
        for await (const _ of stream.fullStream) {
          break
        }

        if (enabled) {
          expect(lastStreamInput?.orchestrator?.maxSteps).toBe(1)
          expect(lastStreamInput?.step?.max).toBe(8)
        } else {
          expect(lastStreamInput?.orchestrator?.maxSteps).toBe(8)
        }
      },
    })
  })

  test("binds and unbinds LSP session around stream", async () => {
    scenario = "default"
    callIndex = 0
    const { LSP } = await import("../../src/lsp")
    const bindSession = mock(() => Promise.resolve())
    const unbindSession = mock(() => Promise.resolve())
    const prevBind = LSP.bindSession
    const prevUnbind = LSP.unbindSession
    ;(LSP as any).bindSession = bindSession
    ;(LSP as any).unbindSession = unbindSession

    try {
      const { OrchestratorRuntimeLangChain } = await import("../../src/runtime/orchestrator-runtime-langchain")
      const runtime = OrchestratorRuntimeLangChain.create()
      const stream = await runtime.stream({
        user: {
          id: "m-user",
          sessionID: "s",
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: {},
        },
        sessionID: "s",
        model: { id: "m", providerID: "p", capabilities: { toolcall: true } } as any,
        agent: { name: "build", options: {}, permission: [], mode: "primary", steps: 1 } as any,
        system: [],
        abort: AbortSignal.any([]),
        messages: [],
        tools: {},
      } as any)

      for await (const _ of stream.fullStream) {
      }

      expect(bindSession).toHaveBeenCalledTimes(1)
      expect(unbindSession).toHaveBeenCalledTimes(1)
    } finally {
      ;(LSP as any).bindSession = prevBind
      ;(LSP as any).unbindSession = prevUnbind
    }
  })

  test("langchain orchestrator executes toolcall and continues steps", async () => {
    scenario = "toolcall"
    callIndex = 0

    const { LSP } = await import("../../src/lsp")
    const bindSession = mock(() => Promise.resolve())
    const unbindSession = mock(() => Promise.resolve())
    const prevBind = LSP.bindSession
    const prevUnbind = LSP.unbindSession
    ;(LSP as any).bindSession = bindSession
    ;(LSP as any).unbindSession = unbindSession

    const { OrchestratorRuntimeLangChain } = await import("../../src/runtime/orchestrator-runtime-langchain")
    const runtime = OrchestratorRuntimeLangChain.create()

    try {
      const stream = await runtime.stream({
        user: {
          id: "m-user",
          sessionID: "s",
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: {},
        },
        sessionID: "s",
        model: { id: "m", providerID: "p", capabilities: { toolcall: true } } as any,
        agent: { name: "build", options: {}, permission: [], mode: "primary", steps: 2 } as any,
        system: [],
        abort: AbortSignal.any([]),
        messages: [],
        tools: {
          echo: {
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
            description: "echo",
            execute: async (args: any) => ({ title: "t", metadata: {}, output: `echo:${args.text}` }),
            toModelOutput: (result: any) => ({ type: "text", value: result.output }),
          } as any,
        },
      } as any)

      const events: any[] = []
      for await (const ev of stream.fullStream) {
        events.push(ev)
      }

      expect(events.some((x) => x.type === "tool-call")).toBe(true)
      expect(events.some((x) => x.type === "tool-result" && x.toolName === "echo")).toBe(true)
      expect(callIndex).toBe(2)
      expect(bindSession).toHaveBeenCalledTimes(1)
      expect(unbindSession).toHaveBeenCalledTimes(1)
    } finally {
      ;(LSP as any).bindSession = prevBind
      ;(LSP as any).unbindSession = prevUnbind
    }
  })
})
