import { LLM } from "@/session/llm"
import type { ModelMessage, ToolContent, ToolResultPart, Tool } from "ai"
import type { OrchestratorRuntime } from "./orchestrator-runtime"
import { LSP } from "@/lsp"
import { Flag } from "@/flag/flag"

function defaultMaxSteps(input: LLM.StreamInput) {
  if (input.agent.steps && input.agent.steps > 0) return input.agent.steps
  return 8
}

function unknownToolMessage(toolName: string, providerID: string) {
  if (toolName !== "websearch" && toolName !== "codesearch") return `Unknown tool: ${toolName}`

  const canUse = providerID === "opencode" || Flag.OPENCODE_ENABLE_EXA
  const enableHint = canUse
    ? ""
    : `（当前 provider 未启用该工具；可设置 OPENCODE_ENABLE_EXA=1 后重启，或切到 provider=opencode）`
  const usageHint =
    toolName === "websearch"
      ? `如果你是要抓取某个 URL 的内容，请用 webfetch(url=...)。`
      : ``
  return `Unknown tool: ${toolName} ${enableHint}${usageHint ? " " + usageHint : ""}`.trim()
}

function withoutExecute(tools: Record<string, Tool>) {
  const result: Record<string, Tool> = {}
  for (const [id, t] of Object.entries(tools)) {
    const { execute, ...rest } = t as any
    result[id] = rest as Tool
  }
  return result
}

export namespace OrchestratorRuntimeLangChain {
  export function create(): OrchestratorRuntime.Runtime {
    return {
      id: "langchain",
      async stream(input) {
        const max = input.orchestrator?.maxSteps ?? defaultMaxSteps(input)
        const toolsExec = input.tools
        const toolsNoExec = withoutExecute(input.tools)

        async function* fullStream() {
          let messages: ModelMessage[] = input.messages
          await LSP.bindSession(input.sessionID)
          try {
            for (let step = 0; step < max; step++) {
              const res = await LLM.stream({
                ...input,
                messages,
                tools: toolsNoExec,
                orchestrator: {
                  ...input.orchestrator,
                  maxSteps: 1,
                },
                step: {
                  current: step + 1,
                  max,
                },
              })

              const toolResultParts: ToolResultPart[] = []

              for await (const ev of res.fullStream as any) {
                yield ev

                if (ev.type !== "tool-call") continue

                const tool = toolsExec[ev.toolName]
                const execute = tool && (tool as any).execute

                if (typeof execute !== "function") {
                  const error = new Error(unknownToolMessage(ev.toolName, input.model.providerID))
                  yield {
                    type: "tool-error",
                    toolCallId: ev.toolCallId,
                    toolName: ev.toolName,
                    input: ev.input,
                    error,
                  }
                  toolResultParts.push({
                    type: "tool-result",
                    toolCallId: ev.toolCallId,
                    toolName: ev.toolName,
                    output: { type: "text", value: error.message } as any,
                  })
                  continue
                }

                try {
                  const output = await execute(ev.input, {
                    toolCallId: ev.toolCallId,
                    messages,
                    abortSignal: input.abort,
                  })

                  yield {
                    type: "tool-result",
                    toolCallId: ev.toolCallId,
                    toolName: ev.toolName,
                    input: ev.input,
                    output,
                  }

                  const toModelOutput = tool && (tool as any).toModelOutput
                  toolResultParts.push({
                    type: "tool-result",
                    toolCallId: ev.toolCallId,
                    toolName: ev.toolName,
                    output:
                      typeof toModelOutput === "function" ? toModelOutput(output) : ({ type: "text", value: "" } as any),
                  })
                } catch (error) {
                  yield {
                    type: "tool-error",
                    toolCallId: ev.toolCallId,
                    toolName: ev.toolName,
                    input: ev.input,
                    error,
                  }

                  toolResultParts.push({
                    type: "tool-result",
                    toolCallId: ev.toolCallId,
                    toolName: ev.toolName,
                    output: { type: "text", value: (error as any)?.toString?.() ?? String(error) } as any,
                  })
                }
              }

              const response = await (res as any).response
              if (response?.messages) {
                messages = [...messages, ...response.messages]
              }

              if (toolResultParts.length === 0) break

              const toolMessage: ModelMessage = {
                role: "tool",
                content: toolResultParts as ToolContent,
              }
              messages = [...messages, toolMessage]
            }
          } finally {
            await LSP.unbindSession(input.sessionID)
          }
        }

        return { fullStream: fullStream() }
      },
    }
  }
}
