import type { ToolRuntime } from "./tool-runtime"
import z from "zod"

export namespace LangChainToolRuntime {
  async function importAny(specifier: string): Promise<any> {
    return new Function("s", "return import(s)")(specifier)
  }

  let toolFactoryPromise: Promise<undefined | ((fn: any, opts: any) => any)> | undefined
  const toolCache = new WeakMap<ToolRuntime.ToolInstance, any>()

  async function getToolFactory() {
    toolFactoryPromise ??= importAny("@langchain/core/tools")
      .then((mod) => (mod as any)?.tool as undefined | ((fn: any, opts: any) => any))
      .catch(() => undefined)
    return toolFactoryPromise
  }

  function validationErrorToolID(toolID: string) {
    if (toolID === "readFile") return "read"
    if (toolID === "editFile") return "edit"
    if (toolID === "writeFile") return "write"
    return toolID
  }

  function validateArgs(input: ToolRuntime.ExecuteInput) {
    try {
      ;(input.tool.parameters as any).parse(input.args)
    } catch (error) {
      const formatter = (input.tool as any)?.formatValidationError as undefined | ((e: z.ZodError) => string)
      if (error instanceof z.ZodError && formatter) {
        throw new Error(formatter(error), { cause: error })
      }
      throw new Error(
        `The ${validationErrorToolID(input.tool.id)} tool was called with invalid arguments: ${error}.\nPlease rewrite the input so it satisfies the expected schema.`,
        { cause: error as any },
      )
    }
  }

  export function create(): ToolRuntime.Runtime {
    return {
      id: "langchain",
      async execute(input) {
        const toolFactory = await getToolFactory()
        if (!toolFactory) {
          throw new Error(
            `LangChain tool runtime is enabled but @langchain/core is not available. Disable OPENCODE_EXPERIMENTAL_LANGCHAIN_TOOL_RUNTIME or install LangChain.`,
          )
        }

        validateArgs(input)

        let lc = toolCache.get(input.tool)
        if (!lc) {
          lc = toolFactory(
            async (args: any, config: any) => {
              const ctx = (config as any)?.context?.opencode ?? input.ctx
              return input.tool.execute(args, ctx)
            },
            {
              name: input.tool.id,
              description: input.tool.description,
              schema: input.tool.parameters,
            },
          )
          toolCache.set(input.tool, lc)
        }

        return lc.invoke(input.args, { context: { opencode: input.ctx }, signal: input.ctx.abort })
      },
    }
  }
}
