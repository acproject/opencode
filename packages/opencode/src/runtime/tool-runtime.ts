import type { Tool } from "@/tool/tool"
import { Flag } from "@/flag/flag"
import { Instance } from "@/project/instance"

export namespace ToolRuntime {
  export type ToolInstance = Awaited<ReturnType<Tool.Info["init"]>> & { id: string }
  export type ExecuteInput = {
    tool: ToolInstance
    args: unknown
    ctx: Tool.Context
  }

  export interface Runtime {
    id: string
    execute(input: ExecuteInput): Promise<Awaited<ReturnType<ToolInstance["execute"]>>>
  }

  const state = Instance.state(async () => {
    const direct: Runtime = {
      id: "direct",
      async execute(input) {
        return input.tool.execute(input.args as any, input.ctx)
      },
    }

    return { direct, runtime: direct }
  })

  export async function current(): Promise<Runtime> {
    const s = await state()
    if (!Flag.OPENCODE_EXPERIMENTAL_LANGCHAIN_TOOL_RUNTIME) return s.direct

    if (s.runtime.id === "langchain") return s.runtime

    const { LangChainToolRuntime } = await import("./tool-runtime-langchain")
    s.runtime = LangChainToolRuntime.create()
    return s.runtime
  }
}

