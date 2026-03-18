import { Flag } from "@/flag/flag"
import { Instance } from "@/project/instance"
import { LLM } from "@/session/llm"

export namespace OrchestratorRuntime {
  export type Stream = {
    fullStream: AsyncIterable<any>
  }

  export interface Runtime {
    id: string
    stream(input: LLM.StreamInput): Promise<Stream>
  }

  function defaultMaxSteps(input: LLM.StreamInput) {
    if (input.agent.steps && input.agent.steps > 0) return input.agent.steps
    return 8
  }

  const state = Instance.state(async () => {
    const direct: Runtime = {
      id: "direct",
      stream: (input) =>
        LLM.stream({
          ...input,
          orchestrator: {
            ...input.orchestrator,
            maxSteps: input.orchestrator?.maxSteps ?? defaultMaxSteps(input),
          },
        }),
    }

    return { direct, runtime: direct }
  })

  export async function current(): Promise<Runtime> {
    const s = await state()
    if (!Flag.OPENCODE_EXPERIMENTAL_LANGCHAIN_ORCHESTRATOR) return s.direct

    if (s.runtime.id === "langchain") return s.runtime

    const { OrchestratorRuntimeLangChain } = await import("./orchestrator-runtime-langchain")
    s.runtime = OrchestratorRuntimeLangChain.create()
    return s.runtime
  }
}
