import z from "zod"
import fuzzysort from "fuzzysort"
import { Config } from "../config/config"
import { mapValues, mergeDeep, omit, pickBy, sortBy } from "remeda"
import { NoSuchModelError, type Provider as SDK } from "ai"
import { Log } from "../util/log"
import { BunProc } from "../bun"
import { Plugin } from "../plugin"
import { ModelsDev } from "./models"
import { NamedError } from "@opencode-ai/util/error"
import { Auth } from "../auth"
import { Env } from "../env"
import { Instance } from "../project/instance"
import { Flag } from "../flag/flag"
import { iife } from "@/util/iife"
import { Installation } from "@/installation"
import {
  APICallError,
  type LanguageModelV2 as CoreLanguageModelV2,
  type LanguageModelV2CallWarning,
  type LanguageModelV2Content,
  type LanguageModelV2FinishReason,
  type LanguageModelV2Prompt,
  type LanguageModelV2StreamPart,
  type LanguageModelV2Usage,
  type SharedV2ProviderMetadata,
} from "@ai-sdk/provider"

// Direct imports for bundled providers
import { createAmazonBedrock, type AmazonBedrockProviderSettings } from "@ai-sdk/amazon-bedrock"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createAzure } from "@ai-sdk/azure"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createVertex } from "@ai-sdk/google-vertex"
import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createOpenRouter, type LanguageModelV2 } from "@openrouter/ai-sdk-provider"
import { createOpenaiCompatible as createGitHubCopilotOpenAICompatible } from "./sdk/openai-compatible/src"
import { createXai } from "@ai-sdk/xai"
import { createMistral } from "@ai-sdk/mistral"
import { createGroq } from "@ai-sdk/groq"
import { createDeepInfra } from "@ai-sdk/deepinfra"
import { createCerebras } from "@ai-sdk/cerebras"
import { createCohere } from "@ai-sdk/cohere"
import { createGateway } from "@ai-sdk/gateway"
import { createTogetherAI } from "@ai-sdk/togetherai"
import { createPerplexity } from "@ai-sdk/perplexity"
import { createVercel } from "@ai-sdk/vercel"
import { ProviderTransform } from "./transform"
import { ProviderExtensions } from "./extensions"

export namespace Provider {
  const log = Log.create({ service: "provider" })

  const BUNDLED_PROVIDERS: Record<string, (options: any) => SDK> = {
    "@ai-sdk/amazon-bedrock": createAmazonBedrock,
    "@ai-sdk/anthropic": createAnthropic,
    "@ai-sdk/azure": createAzure,
    "@ai-sdk/google": createGoogleGenerativeAI,
    "@ai-sdk/google-vertex": createVertex,
    "@ai-sdk/google-vertex/anthropic": createVertexAnthropic,
    "@ai-sdk/openai": createOpenAI,
    "@ai-sdk/openai-compatible": createOpenAICompatible,
    "@openrouter/ai-sdk-provider": createOpenRouter,
    "@ai-sdk/xai": createXai,
    "@ai-sdk/mistral": createMistral,
    "@ai-sdk/groq": createGroq,
    "@ai-sdk/deepinfra": createDeepInfra,
    "@ai-sdk/cerebras": createCerebras,
    "@ai-sdk/cohere": createCohere,
    "@ai-sdk/gateway": createGateway,
    "@ai-sdk/togetherai": createTogetherAI,
    "@ai-sdk/perplexity": createPerplexity,
    "@ai-sdk/vercel": createVercel,
    // @ts-ignore (TODO: kill this code so we dont have to maintain it)
    "@ai-sdk/github-copilot": createGitHubCopilotOpenAICompatible,
  }

  type CustomModelLoader = (sdk: any, modelID: string, options?: Record<string, any>) => Promise<any>
  type CustomLoader = (provider: Info) => Promise<{
    autoload: boolean
    getModel?: CustomModelLoader
    options?: Record<string, any>
  }>

  const CUSTOM_LOADERS: Record<string, CustomLoader> = {
    ollama: async (input) => {
      const cfg = await Config.get()
      const providerCfg = cfg.provider?.["ollama"]
      const baseURLRaw =
        providerCfg?.options?.baseURL ??
        providerCfg?.options?.api ??
        Env.get("OLLAMA_BASE_URL") ??
        Env.get("OLLAMA_HOST") ??
        "http://127.0.0.1:11434"

      const baseURL = (() => {
        if (typeof baseURLRaw !== "string" || baseURLRaw.length === 0) return "http://127.0.0.1:11434"
        if (baseURLRaw.startsWith("http://") || baseURLRaw.startsWith("https://")) return baseURLRaw
        return `http://${baseURLRaw}`
      })()

      const promptToolCall =
        providerCfg?.options?.toolCallMode === "prompt" ||
        providerCfg?.options?.promptToolCall === true ||
        providerCfg?.options?.toolcall === "prompt"

      if (promptToolCall) {
        for (const model of Object.values(input.models)) {
          model.capabilities.toolcall = true
        }
      }

      function headersToRecord(headers: Headers): Record<string, string> {
        const out: Record<string, string> = {}
        headers.forEach((value, key) => {
          out[key] = value
        })
        return out
      }

      function extractJson(text: string): any | undefined {
        const trimmed = text.trim()
        if (!trimmed) return undefined
        const start = trimmed.indexOf("{")
        const end = trimmed.lastIndexOf("}")
        if (start < 0 || end < 0 || end <= start) return undefined
        const slice = trimmed.slice(start, end + 1)
        try {
          return JSON.parse(slice)
        } catch {
          return undefined
        }
      }

      function parsePromptToolCall(text: string):
        | { kind: "tool"; calls: Array<{ name: string; arguments: any }> }
        | { kind: "final"; text: string } {
        const json = extractJson(text)
        const root = json?.opencode ?? json
        const toolCalls = root?.tool_calls ?? root?.toolCalls ?? root?.toolcalls
        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
          const calls = toolCalls
            .map((call: any) => {
              const name = typeof call?.name === "string" ? call.name : typeof call?.tool === "string" ? call.tool : undefined
              const args = call?.arguments ?? call?.args ?? call?.input ?? {}
              if (!name) return undefined
              return { name, arguments: args }
            })
            .filter(Boolean) as Array<{ name: string; arguments: any }>
          if (calls.length > 0) return { kind: "tool", calls }
        }
        const finalText =
          (typeof root?.final === "string" ? root.final : undefined) ??
          (typeof root?.content === "string" ? root.content : undefined) ??
          (typeof root?.text === "string" ? root.text : undefined)
        if (typeof finalText === "string") return { kind: "final", text: finalText }
        return { kind: "final", text }
      }

      function toolInstruction(tools: any, toolChoice: any) {
        const list = Array.isArray(tools) ? tools : tools ? Object.values(tools) : []
        const rendered = list
          .map((t: any) => {
            const name = t?.name ?? t?.toolName ?? t?.id
            const description = t?.description
            const parameters = t?.parameters ?? t?.schema ?? t?.inputSchema
            return JSON.stringify({ name, description, parameters })
          })
          .join("\n")

        const choice = toolChoice ? JSON.stringify(toolChoice) : "auto"
        return [
          "Respond with exactly one JSON object and nothing else.",
          "Do not wrap in markdown fences. Do not include extra text.",
          "If calling a tool, respond with exactly:",
          '{"opencode":{"tool_calls":[{"name":"<toolName>","arguments":{}}]}}',
          "If responding normally, respond with exactly:",
          '{"opencode":{"final":"<text>"}}',
          `tool_choice=${choice}`,
          "tools:",
          rendered,
        ].join("\n")
      }

      function extractModelNames(payload: any): string[] {
        const list: any = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.models)
            ? payload.models
            : Array.isArray(payload?.data)
              ? payload.data
              : []

        const out: string[] = []
        for (const item of list) {
          if (typeof item === "string") {
            out.push(item)
            continue
          }
          const name =
            (typeof item?.name === "string" ? item.name : undefined) ??
            (typeof item?.model === "string" ? item.model : undefined) ??
            (typeof item?.id === "string" ? item.id : undefined)
          if (name) out.push(name)
        }
        return Array.from(new Set(out)).filter(Boolean)
      }

      const templateModel = Object.values(input.models)[0]
      const templateCapabilities =
        templateModel?.capabilities ??
        ({
          temperature: true,
          reasoning: false,
          attachment: false,
          toolcall: false,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        } as any)
      const templateLimit = templateModel?.limit ?? ({ context: 16384, output: 4096 } as any)
      const templateReleaseDate = templateModel?.release_date ?? "2026-01-01"

      const discovered = await (async () => {
        try {
          const url = new URL("/api/tags", baseURL).toString()
          const response = await fetch(url, {
            method: "GET",
            headers: {
              "User-Agent": Installation.USER_AGENT,
            },
            signal: AbortSignal.timeout(2500),
          })
          const raw = await response.text()
          if (!response.ok) return []
          let parsed: any
          try {
            parsed = JSON.parse(raw)
          } catch {
            parsed = undefined
          }
          return extractModelNames(parsed)
        } catch {
          return []
        }
      })()

      for (const modelID of discovered) {
        if (input.models[modelID]) continue
        input.models[modelID] = {
          id: modelID,
          providerID: input.id,
          api: {
            id: modelID,
            url: baseURL,
            npm: "@ai-sdk/openai-compatible",
          },
          name: modelID,
          family: "ollama",
          capabilities: { ...templateCapabilities, toolcall: promptToolCall ? true : templateCapabilities.toolcall },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: templateLimit,
          status: "active",
          options: {},
          headers: {},
          release_date: templateReleaseDate,
          variants: {},
        }
      }

      if (Object.keys(input.models).length === 0) {
        const fallbackModelId = typeof providerCfg?.options?.fallbackModel === "string" ? providerCfg.options.fallbackModel : "llama3.1:8b-instruct"
        input.models[fallbackModelId] = {
          id: fallbackModelId,
          providerID: input.id,
          api: {
            id: fallbackModelId,
            url: baseURL,
            npm: "@ai-sdk/openai-compatible",
          },
          name: fallbackModelId,
          family: "ollama",
          capabilities: { ...templateCapabilities, toolcall: promptToolCall ? true : templateCapabilities.toolcall },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: templateLimit,
          status: "active",
          options: {},
          headers: {},
          release_date: templateReleaseDate,
          variants: {},
        }
      }

      class OllamaChatModel implements CoreLanguageModelV2 {
        readonly specificationVersion = "v2"
        readonly modelId: string
        readonly supportedUrls: Record<string, RegExp[]> = {}
        private readonly cfg: { baseURL: string; promptToolCall: boolean }

        constructor(modelId: string, cfg: { baseURL: string; promptToolCall: boolean }) {
          this.modelId = modelId
          this.cfg = cfg
        }

        get provider(): string {
          return "ollama"
        }

        private toOllamaMessages(prompt: LanguageModelV2Prompt) {
          return prompt.map((msg) => {
            const content =
              typeof msg.content === "string"
                ? msg.content
                : msg.content
                    .map((part: any) => {
                      if (part?.type === "text") return String(part.text ?? "")
                      if (part?.type === "tool-result") return JSON.stringify(part.result ?? {})
                      return ""
                    })
                    .join("")
            const role =
              msg.role === "system" || msg.role === "user" || msg.role === "assistant" || msg.role === "tool"
                ? msg.role
                : "user"
            return { role, content }
          })
        }

        private async callOllama({
          stream,
          prompt,
          headers,
          abortSignal,
          temperature,
          topP,
          maxOutputTokens,
          tools,
          toolChoice,
        }: {
          stream: boolean
          prompt: LanguageModelV2Prompt
          headers?: Record<string, string | undefined>
          abortSignal?: AbortSignal
          temperature?: number
          topP?: number
          maxOutputTokens?: number
          tools?: any
          toolChoice?: any
        }) {
          const mergedHeaders = new Headers()
          for (const [k, v] of Object.entries(headers ?? {})) {
            if (v == null) continue
            mergedHeaders.set(k, v)
          }
          mergedHeaders.set("Content-Type", "application/json")
          mergedHeaders.set("User-Agent", Installation.USER_AGENT)

          const shouldPromptToolCall = this.cfg.promptToolCall && tools && (Array.isArray(tools) ? tools.length > 0 : true)
          const injectedPrompt: LanguageModelV2Prompt = shouldPromptToolCall
            ? [
                {
                  role: "system",
                  content: toolInstruction(tools, toolChoice),
                } as any,
                ...prompt,
              ]
            : prompt

          const body: any = {
            model: this.modelId,
            messages: this.toOllamaMessages(injectedPrompt),
            stream,
          }
          if (shouldPromptToolCall) body.format = "json"

          if (typeof temperature === "number") body.options = { ...(body.options ?? {}), temperature }
          if (typeof topP === "number") body.options = { ...(body.options ?? {}), top_p: topP }
          if (typeof maxOutputTokens === "number") body.options = { ...(body.options ?? {}), num_predict: maxOutputTokens }

          const url = new URL("/api/chat", this.cfg.baseURL).toString()
          const response = await fetch(url, {
            method: "POST",
            headers: mergedHeaders,
            body: JSON.stringify(body),
            signal: abortSignal,
          })
          return { response, body, shouldPromptToolCall }
        }

        async doGenerate(
          options: Parameters<CoreLanguageModelV2["doGenerate"]>[0],
        ): Promise<Awaited<ReturnType<CoreLanguageModelV2["doGenerate"]>>> {
          const warnings: LanguageModelV2CallWarning[] = []

          const { response, body, shouldPromptToolCall } = await this.callOllama({
            stream: false,
            prompt: options.prompt,
            headers: options.headers,
            abortSignal: options.abortSignal,
            temperature: (options as any).temperature,
            topP: (options as any).topP,
            maxOutputTokens: (options as any).maxOutputTokens,
            tools: (options as any).tools,
            toolChoice: (options as any).toolChoice,
          })

          const rawText = await response.text()
          if (!response.ok) {
            throw new APICallError({
              message: `Ollama request failed (${response.status})`,
              url: response.url,
              requestBodyValues: body,
              statusCode: response.status,
              responseHeaders: headersToRecord(response.headers),
              responseBody: rawText,
              isRetryable: response.status >= 500,
            })
          }

          let parsed: any
          try {
            parsed = JSON.parse(rawText)
          } catch {
            parsed = undefined
          }

          const text: string =
            (parsed?.message && typeof parsed.message.content === "string" ? parsed.message.content : undefined) ??
            (typeof parsed?.response === "string" ? parsed.response : "") ??
            ""

          const inputTokens: number | undefined =
            typeof parsed?.prompt_eval_count === "number" ? parsed.prompt_eval_count : undefined
          const outputTokens: number | undefined = typeof parsed?.eval_count === "number" ? parsed.eval_count : undefined
          const usage: LanguageModelV2Usage = {
            inputTokens,
            outputTokens,
            totalTokens:
              typeof inputTokens === "number" && typeof outputTokens === "number" ? inputTokens + outputTokens : undefined,
          }

          if (shouldPromptToolCall) {
            const parsedToolCall = parsePromptToolCall(text)
            if (parsedToolCall.kind === "tool") {
              const content: LanguageModelV2Content[] = parsedToolCall.calls.map((call) => ({
                type: "tool-call",
                toolCallId: crypto.randomUUID(),
                toolName: call.name,
                input: JSON.stringify(call.arguments ?? {}),
              }))
              return {
                content,
                finishReason: "tool-calls",
                usage,
                request: { body },
                response: {
                  id: typeof parsed?.id === "string" ? parsed.id : undefined,
                  timestamp: new Date(Date.now()),
                  modelId: typeof parsed?.model === "string" ? parsed.model : this.modelId,
                  headers: headersToRecord(response.headers),
                  body: rawText,
                },
                providerMetadata: {} satisfies SharedV2ProviderMetadata,
                warnings,
              }
            }
            const content: LanguageModelV2Content[] = [{ type: "text", text: parsedToolCall.text }]
            return {
              content,
              finishReason: "stop",
              usage,
              request: { body },
              response: {
                id: typeof parsed?.id === "string" ? parsed.id : undefined,
                timestamp: new Date(Date.now()),
                modelId: typeof parsed?.model === "string" ? parsed.model : this.modelId,
                headers: headersToRecord(response.headers),
                body: rawText,
              },
              providerMetadata: {} satisfies SharedV2ProviderMetadata,
              warnings,
            }
          }

          const content: LanguageModelV2Content[] = [{ type: "text", text }]
          return {
            content,
            finishReason: "stop",
            usage,
            request: { body },
            response: {
              id: typeof parsed?.id === "string" ? parsed.id : undefined,
              timestamp: new Date(Date.now()),
              modelId: typeof parsed?.model === "string" ? parsed.model : this.modelId,
              headers: headersToRecord(response.headers),
              body: rawText,
            },
            providerMetadata: {} satisfies SharedV2ProviderMetadata,
            warnings,
          }
        }

        async doStream(
          options: Parameters<CoreLanguageModelV2["doStream"]>[0],
        ): Promise<Awaited<ReturnType<CoreLanguageModelV2["doStream"]>>> {
          const warnings: LanguageModelV2CallWarning[] = []

          const { response, body, shouldPromptToolCall } = await this.callOllama({
            stream: true,
            prompt: options.prompt,
            headers: options.headers,
            abortSignal: options.abortSignal,
            temperature: (options as any).temperature,
            topP: (options as any).topP,
            maxOutputTokens: (options as any).maxOutputTokens,
            tools: (options as any).tools,
            toolChoice: (options as any).toolChoice,
          })

          if (!response.ok) {
            const rawText = await response.text().catch(() => "")
            throw new APICallError({
              message: `Ollama request failed (${response.status})`,
              url: response.url,
              requestBodyValues: body,
              statusCode: response.status,
              responseHeaders: headersToRecord(response.headers),
              responseBody: rawText,
              isRetryable: response.status >= 500,
            })
          }

          let currentTextId: string | null = null
          let finishReason: LanguageModelV2FinishReason = "unknown"
          const usage: LanguageModelV2Usage = { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined }

          const stream = new ReadableStream<LanguageModelV2StreamPart>({
            async start(controller) {
              controller.enqueue({ type: "stream-start", warnings })

              const reader = response.body?.getReader()
              if (!reader) {
                finishReason = "error"
                controller.enqueue({ type: "finish", finishReason, usage, providerMetadata: {} satisfies SharedV2ProviderMetadata })
                controller.close()
                return
              }

              const decoder = new TextDecoder()
              let buffer = ""
              let isDone = false
              let fullText = ""

              while (true) {
                const { value, done } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })
                const lines = buffer.split("\n")
                buffer = lines.pop() ?? ""

                for (const line of lines) {
                  const trimmed = line.trim()
                  if (!trimmed) continue
                  if (options.includeRawChunks) controller.enqueue({ type: "raw", rawValue: trimmed })

                  let chunk: any
                  try {
                    chunk = JSON.parse(trimmed)
                  } catch (e) {
                    finishReason = "error"
                    controller.enqueue({ type: "error", error: e })
                    continue
                  }

                  const delta: string | undefined =
                    (chunk?.message && typeof chunk.message.content === "string" ? chunk.message.content : undefined) ??
                    (typeof chunk?.response === "string" ? chunk.response : undefined)

                  if (delta) {
                    if (shouldPromptToolCall) {
                      fullText += delta
                    } else {
                      if (!currentTextId) {
                        currentTextId = "ollama-text"
                        controller.enqueue({ type: "text-start", id: currentTextId, providerMetadata: {} })
                      }
                      controller.enqueue({ type: "text-delta", id: currentTextId, delta })
                    }
                  }

                  if (chunk?.done === true) {
                    isDone = true
                    const inTok = typeof chunk?.prompt_eval_count === "number" ? chunk.prompt_eval_count : undefined
                    const outTok = typeof chunk?.eval_count === "number" ? chunk.eval_count : undefined
                    usage.inputTokens = inTok
                    usage.outputTokens = outTok
                    usage.totalTokens = typeof inTok === "number" && typeof outTok === "number" ? inTok + outTok : undefined
                    break
                  }
                }

                if (isDone) break
              }

              if (shouldPromptToolCall) {
                const parsedToolCall = parsePromptToolCall(fullText)
                if (parsedToolCall.kind === "tool") {
                  finishReason = "tool-calls"
                  for (const call of parsedToolCall.calls) {
                    controller.enqueue({
                      type: "tool-call",
                      toolCallId: crypto.randomUUID(),
                      toolName: call.name,
                      input: JSON.stringify(call.arguments ?? {}),
                      providerMetadata: {},
                    } as any)
                  }
                } else {
                  finishReason = "stop"
                  currentTextId = "ollama-text"
                  controller.enqueue({ type: "text-start", id: currentTextId, providerMetadata: {} })
                  controller.enqueue({ type: "text-delta", id: currentTextId, delta: parsedToolCall.text })
                  controller.enqueue({ type: "text-end", id: currentTextId })
                  currentTextId = null
                }
              } else if (currentTextId) {
                controller.enqueue({ type: "text-end", id: currentTextId })
                currentTextId = null
                finishReason = "stop"
              } else {
                finishReason = "stop"
              }

              controller.enqueue({ type: "finish", finishReason, usage, providerMetadata: {} satisfies SharedV2ProviderMetadata })
              controller.close()
            },
          })

          return {
            stream,
            request: { body },
            response: { headers: headersToRecord(response.headers) },
          }
        }
      }

      return {
        autoload: true,
        options: {
          baseURL,
        },
        async getModel(_sdk: any, modelID: string, options?: Record<string, any>) {
          const cfgBaseURL = typeof options?.baseURL === "string" ? options.baseURL : baseURL
          const cfgPromptToolCall =
            options?.toolCallMode === "prompt" || options?.promptToolCall === true || options?.toolcall === "prompt" || promptToolCall
          return new OllamaChatModel(modelID, { baseURL: cfgBaseURL, promptToolCall: cfgPromptToolCall })
        },
      }
    },
    async anthropic() {
      return {
        autoload: false,
        options: {
          headers: {
            "anthropic-beta":
              "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
          },
        },
      }
    },
    async opencode(input) {
      const hasKey = await (async () => {
        const env = Env.all()
        if (input.env.some((item) => env[item])) return true
        if (await Auth.get(input.id)) return true
        const config = await Config.get()
        if (config.provider?.["opencode"]?.options?.apiKey) return true
        return false
      })()

      if (!hasKey) {
        for (const [key, value] of Object.entries(input.models)) {
          if (value.cost.input === 0) continue
          delete input.models[key]
        }
      }

      return {
        autoload: Object.keys(input.models).length > 0,
        options: hasKey ? {} : { apiKey: "public" },
      }
    },
    openai: async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.responses(modelID)
        },
        options: {},
      }
    },
    "github-copilot": async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          if (modelID.includes("codex")) {
            return sdk.responses(modelID)
          }
          return sdk.chat(modelID)
        },
        options: {},
      }
    },
    "github-copilot-enterprise": async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          if (modelID.includes("codex")) {
            return sdk.responses(modelID)
          }
          return sdk.chat(modelID)
        },
        options: {},
      }
    },
    azure: async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          if (options?.["useCompletionUrls"]) {
            return sdk.chat(modelID)
          } else {
            return sdk.responses(modelID)
          }
        },
        options: {},
      }
    },
    "azure-cognitive-services": async () => {
      const resourceName = Env.get("AZURE_COGNITIVE_SERVICES_RESOURCE_NAME")
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          if (options?.["useCompletionUrls"]) {
            return sdk.chat(modelID)
          } else {
            return sdk.responses(modelID)
          }
        },
        options: {
          baseURL: resourceName ? `https://${resourceName}.cognitiveservices.azure.com/openai` : undefined,
        },
      }
    },
    "amazon-bedrock": async () => {
      const config = await Config.get()
      const providerConfig = config.provider?.["amazon-bedrock"]

      const auth = await Auth.get("amazon-bedrock")

      // Region precedence: 1) config file, 2) env var, 3) default
      const configRegion = providerConfig?.options?.region
      const envRegion = Env.get("AWS_REGION")
      const defaultRegion = configRegion ?? envRegion ?? "us-east-1"

      // Profile: config file takes precedence over env var
      const configProfile = providerConfig?.options?.profile
      const envProfile = Env.get("AWS_PROFILE")
      const profile = configProfile ?? envProfile

      const awsAccessKeyId = Env.get("AWS_ACCESS_KEY_ID")

      const awsBearerToken = iife(() => {
        const envToken = Env.get("AWS_BEARER_TOKEN_BEDROCK")
        if (envToken) return envToken
        if (auth?.type === "api") {
          Env.set("AWS_BEARER_TOKEN_BEDROCK", auth.key)
          return auth.key
        }
        return undefined
      })

      if (!profile && !awsAccessKeyId && !awsBearerToken) return { autoload: false }

      const { fromNodeProviderChain } = await import(await BunProc.install("@aws-sdk/credential-providers"))

      // Build credential provider options (only pass profile if specified)
      const credentialProviderOptions = profile ? { profile } : {}

      const providerOptions: AmazonBedrockProviderSettings = {
        region: defaultRegion,
        credentialProvider: fromNodeProviderChain(credentialProviderOptions),
      }

      // Add custom endpoint if specified (endpoint takes precedence over baseURL)
      const endpoint = providerConfig?.options?.endpoint ?? providerConfig?.options?.baseURL
      if (endpoint) {
        providerOptions.baseURL = endpoint
      }

      return {
        autoload: true,
        options: providerOptions,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          // Skip region prefixing if model already has a cross-region inference profile prefix
          if (modelID.startsWith("global.") || modelID.startsWith("jp.")) {
            return sdk.languageModel(modelID)
          }

          // Region resolution precedence (highest to lowest):
          // 1. options.region from opencode.json provider config
          // 2. defaultRegion from AWS_REGION environment variable
          // 3. Default "us-east-1" (baked into defaultRegion)
          const region = options?.region ?? defaultRegion

          let regionPrefix = region.split("-")[0]

          switch (regionPrefix) {
            case "us": {
              const modelRequiresPrefix = [
                "nova-micro",
                "nova-lite",
                "nova-pro",
                "nova-premier",
                "claude",
                "deepseek",
              ].some((m) => modelID.includes(m))
              const isGovCloud = region.startsWith("us-gov")
              if (modelRequiresPrefix && !isGovCloud) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "eu": {
              const regionRequiresPrefix = [
                "eu-west-1",
                "eu-west-2",
                "eu-west-3",
                "eu-north-1",
                "eu-central-1",
                "eu-south-1",
                "eu-south-2",
              ].some((r) => region.includes(r))
              const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "llama3", "pixtral"].some((m) =>
                modelID.includes(m),
              )
              if (regionRequiresPrefix && modelRequiresPrefix) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "ap": {
              const isAustraliaRegion = ["ap-southeast-2", "ap-southeast-4"].includes(region)
              const isTokyoRegion = region === "ap-northeast-1"
              if (
                isAustraliaRegion &&
                ["anthropic.claude-sonnet-4-5", "anthropic.claude-haiku"].some((m) => modelID.includes(m))
              ) {
                regionPrefix = "au"
                modelID = `${regionPrefix}.${modelID}`
              } else if (isTokyoRegion) {
                // Tokyo region uses jp. prefix for cross-region inference
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                  modelID.includes(m),
                )
                if (modelRequiresPrefix) {
                  regionPrefix = "jp"
                  modelID = `${regionPrefix}.${modelID}`
                }
              } else {
                // Other APAC regions use apac. prefix
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                  modelID.includes(m),
                )
                if (modelRequiresPrefix) {
                  regionPrefix = "apac"
                  modelID = `${regionPrefix}.${modelID}`
                }
              }
              break
            }
          }

          return sdk.languageModel(modelID)
        },
      }
    },
    openrouter: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://opencode.ai/",
            "X-Title": "opencode",
          },
        },
      }
    },
    vercel: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "http-referer": "https://opencode.ai/",
            "x-title": "opencode",
          },
        },
      }
    },
    "google-vertex": async () => {
      const project = Env.get("GOOGLE_CLOUD_PROJECT") ?? Env.get("GCP_PROJECT") ?? Env.get("GCLOUD_PROJECT")
      const location = Env.get("GOOGLE_CLOUD_LOCATION") ?? Env.get("VERTEX_LOCATION") ?? "us-east5"
      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      return {
        autoload: true,
        options: {
          project,
          location,
        },
        async getModel(sdk: any, modelID: string) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    },
    "google-vertex-anthropic": async () => {
      const project = Env.get("GOOGLE_CLOUD_PROJECT") ?? Env.get("GCP_PROJECT") ?? Env.get("GCLOUD_PROJECT")
      const location = Env.get("GOOGLE_CLOUD_LOCATION") ?? Env.get("VERTEX_LOCATION") ?? "global"
      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      return {
        autoload: true,
        options: {
          project,
          location,
        },
        async getModel(sdk: any, modelID) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    },
    "sap-ai-core": async () => {
      const auth = await Auth.get("sap-ai-core")
      const envServiceKey = iife(() => {
        const envAICoreServiceKey = Env.get("AICORE_SERVICE_KEY")
        if (envAICoreServiceKey) return envAICoreServiceKey
        if (auth?.type === "api") {
          Env.set("AICORE_SERVICE_KEY", auth.key)
          return auth.key
        }
        return undefined
      })
      const deploymentId = Env.get("AICORE_DEPLOYMENT_ID")
      const resourceGroup = Env.get("AICORE_RESOURCE_GROUP")

      return {
        autoload: !!envServiceKey,
        options: envServiceKey ? { deploymentId, resourceGroup } : {},
        async getModel(sdk: any, modelID: string) {
          return sdk(modelID)
        },
      }
    },
    zenmux: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://opencode.ai/",
            "X-Title": "opencode",
          },
        },
      }
    },
    "cloudflare-ai-gateway": async (input) => {
      const accountId = Env.get("CLOUDFLARE_ACCOUNT_ID")
      const gateway = Env.get("CLOUDFLARE_GATEWAY_ID")

      if (!accountId || !gateway) return { autoload: false }

      // Get API token from env or auth prompt
      const apiToken = await (async () => {
        const envToken = Env.get("CLOUDFLARE_API_TOKEN")
        if (envToken) return envToken
        const auth = await Auth.get(input.id)
        if (auth?.type === "api") return auth.key
        return undefined
      })()

      return {
        autoload: true,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.languageModel(modelID)
        },
        options: {
          baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gateway}/compat`,
          headers: {
            // Cloudflare AI Gateway uses cf-aig-authorization for authenticated gateways
            // This enables Unified Billing where Cloudflare handles upstream provider auth
            ...(apiToken ? { "cf-aig-authorization": `Bearer ${apiToken}` } : {}),
            "HTTP-Referer": "https://opencode.ai/",
            "X-Title": "opencode",
          },
          // Custom fetch to strip Authorization header - AI Gateway uses cf-aig-authorization instead
          // Sending Authorization header with invalid value causes auth errors
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const headers = new Headers(init?.headers)
            headers.delete("Authorization")
            return fetch(input, { ...init, headers })
          },
        },
      }
    },
    cerebras: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "X-Cerebras-3rd-Party-Integration": "opencode",
          },
        },
      }
    },
    owiseman: async (input) => {
      const cfg = await Config.get()
      const auth = await Auth.get("owiseman")

      const apiKey =
        cfg.provider?.["owiseman"]?.options?.apiKey ??
        Env.get("OWISEMAN_API_KEY") ??
        (auth?.type === "api" ? auth.key : undefined)

      const baseURL =
        cfg.provider?.["owiseman"]?.options?.baseURL ??
        cfg.provider?.["owiseman"]?.options?.api ??
        Env.get("OWISEMAN_BASE_URL") ??
        "https://www.owiseman.com"

      const baseURLNormalized = baseURL.endsWith("/") ? baseURL.slice(0, -1) : baseURL
      const baseRoot = (() => {
        if (baseURLNormalized.endsWith("/api/v1")) return baseURLNormalized.slice(0, -7)
        if (baseURLNormalized.endsWith("/v1")) return baseURLNormalized.slice(0, -3)
        return baseURLNormalized
      })()
      const baseURLV1 = `${baseRoot}/v1`
      const baseURLInference = baseURLNormalized.endsWith("/api/v1") ? `${baseRoot}/api/v1` : baseURLV1

      const templateModel = input.models["nemotron-3-nano:30b"] ?? Object.values(input.models)[0]
      const templateCapabilities =
        templateModel?.capabilities ??
        ({
          temperature: true,
          reasoning: false,
          attachment: false,
          toolcall: false,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        } as any)
      const templateLimit = templateModel?.limit ?? ({ context: 128000, output: 4096 } as any)
      const templateReleaseDate = templateModel?.release_date ?? "2026-01-01"

      function extractModelIDs(payload: any): string[] {
        const list: any[] = Array.isArray(payload?.data) ? payload.data : []
        const ids = list
          .map((item) => {
            if (typeof item?.id === "string") return item.id
            return undefined
          })
          .filter((v): v is string => typeof v === "string" && v.length > 0)
        return Array.from(new Set(ids))
      }

      if (apiKey) {
        const discovered = await (async () => {
          try {
            const url = `${baseURLV1}/models`
            const response = await fetch(url, {
              method: "GET",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "api-key": apiKey,
                "User-Agent": Installation.USER_AGENT,
              },
              signal: AbortSignal.timeout(5000),
            })
            const raw = await response.text()
            if (!response.ok) return []
            let parsed: any
            try {
              parsed = JSON.parse(raw)
            } catch {
              parsed = undefined
            }
            return extractModelIDs(parsed)
          } catch {
            return []
          }
        })()

        for (const modelID of discovered) {
          if (input.models[modelID]) continue
          input.models[modelID] = {
            id: modelID,
            providerID: input.id,
            api: {
              id: modelID,
              url: baseURLInference,
              npm: "@ai-sdk/openai-compatible",
            },
            name: modelID,
            family: "openai-compatible",
            capabilities: templateCapabilities,
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            limit: templateLimit,
            status: "active",
            options: {},
            headers: {},
            release_date: templateReleaseDate,
            variants: {},
          }
        }
      }

      return {
        autoload: Boolean(apiKey),
        options: {
          baseURL: baseURLInference,
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const raw =
              typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.toString()
                  : ((input as Request).url ?? String(input))
            try {
              const url = new URL(raw)
              if (url.pathname === "/chat/completions") url.pathname = "/v1/chat/completions"
              return fetch(url.toString(), init)
            } catch {
              return fetch(input, init)
            }
          },
          ...(apiKey ? { apiKey, headers: { "api-key": apiKey } } : {}),
        },
      }
    },
  }

  export const Model = z
    .object({
      id: z.string(),
      providerID: z.string(),
      api: z.object({
        id: z.string(),
        url: z.string(),
        npm: z.string(),
      }),
      name: z.string(),
      family: z.string().optional(),
      capabilities: z.object({
        temperature: z.boolean(),
        reasoning: z.boolean(),
        attachment: z.boolean(),
        toolcall: z.boolean(),
        input: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        output: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        interleaved: z.union([
          z.boolean(),
          z.object({
            field: z.enum(["reasoning_content", "reasoning_details"]),
          }),
        ]),
      }),
      cost: z.object({
        input: z.number(),
        output: z.number(),
        cache: z.object({
          read: z.number(),
          write: z.number(),
        }),
        experimentalOver200K: z
          .object({
            input: z.number(),
            output: z.number(),
            cache: z.object({
              read: z.number(),
              write: z.number(),
            }),
          })
          .optional(),
      }),
      limit: z.object({
        context: z.number(),
        output: z.number(),
      }),
      status: z.enum(["alpha", "beta", "deprecated", "active"]),
      options: z.record(z.string(), z.any()),
      headers: z.record(z.string(), z.string()),
      release_date: z.string(),
      variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
    })
    .meta({
      ref: "Model",
    })
  export type Model = z.infer<typeof Model>

  export const Info = z
    .object({
      id: z.string(),
      name: z.string(),
      source: z.enum(["env", "config", "custom", "api"]),
      env: z.string().array(),
      key: z.string().optional(),
      options: z.record(z.string(), z.any()),
      models: z.record(z.string(), Model),
    })
    .meta({
      ref: "Provider",
    })
  export type Info = z.infer<typeof Info>

  function fromModelsDevModel(provider: ModelsDev.Provider, model: ModelsDev.Model): Model {
    const m: Model = {
      id: model.id,
      providerID: provider.id,
      name: model.name,
      family: model.family,
      api: {
        id: model.id,
        url: provider.api!,
        npm: model.provider?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible",
      },
      status: model.status ?? "active",
      headers: model.headers ?? {},
      options: model.options ?? {},
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cache: {
          read: model.cost?.cache_read ?? 0,
          write: model.cost?.cache_write ?? 0,
        },
        experimentalOver200K: model.cost?.context_over_200k
          ? {
              cache: {
                read: model.cost.context_over_200k.cache_read ?? 0,
                write: model.cost.context_over_200k.cache_write ?? 0,
              },
              input: model.cost.context_over_200k.input,
              output: model.cost.context_over_200k.output,
            }
          : undefined,
      },
      limit: {
        context: model.limit.context,
        output: model.limit.output,
      },
      capabilities: {
        temperature: model.temperature,
        reasoning: model.reasoning,
        attachment: model.attachment,
        toolcall: model.tool_call,
        input: {
          text: model.modalities?.input?.includes("text") ?? false,
          audio: model.modalities?.input?.includes("audio") ?? false,
          image: model.modalities?.input?.includes("image") ?? false,
          video: model.modalities?.input?.includes("video") ?? false,
          pdf: model.modalities?.input?.includes("pdf") ?? false,
        },
        output: {
          text: model.modalities?.output?.includes("text") ?? false,
          audio: model.modalities?.output?.includes("audio") ?? false,
          image: model.modalities?.output?.includes("image") ?? false,
          video: model.modalities?.output?.includes("video") ?? false,
          pdf: model.modalities?.output?.includes("pdf") ?? false,
        },
        interleaved: model.interleaved ?? false,
      },
      release_date: model.release_date,
      variants: {},
    }

    m.variants = mapValues(ProviderTransform.variants(m), (v) => v)

    return m
  }

  export function fromModelsDevProvider(provider: ModelsDev.Provider): Info {
    return {
      id: provider.id,
      source: "custom",
      name: provider.name,
      env: provider.env ?? [],
      options: {},
      models: mapValues(provider.models, (model) => fromModelsDevModel(provider, model)),
    }
  }

  const state = Instance.state(async () => {
    using _ = log.time("state")
    const config = await Config.get()
    const modelsDev = await ModelsDev.get()
    const database = mapValues(modelsDev, fromModelsDevProvider)

    if (!database["owiseman"]) {
      database["owiseman"] = {
        id: "owiseman",
        name: "Owiseman",
        source: "custom",
        env: ["OWISEMAN_API_KEY"],
        options: {},
        models: {
          "nemotron-3-nano:30b": {
            id: "nemotron-3-nano:30b",
            providerID: "owiseman",
            api: {
              id: "nemotron-3-nano:30b",
              url: "https://www.owiseman.com",
              npm: "@ai-sdk/openai-compatible",
            },
            name: "nemotron-3-nano:30b",
            family: "ollama",
            capabilities: {
              temperature: true,
              reasoning: false,
              attachment: false,
              toolcall: false,
              input: { text: true, audio: false, image: false, video: false, pdf: false },
              output: { text: true, audio: false, image: false, video: false, pdf: false },
              interleaved: false,
            },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            limit: { context: 128000, output: 4096 },
            status: "active",
            options: {},
            headers: {},
            release_date: "2026-01-01",
            variants: {},
          },
        },
      }
    }

    if (!database["ollama"]) {
      database["ollama"] = {
        id: "ollama",
        name: "Ollama",
        source: "custom",
        env: ["OLLAMA_BASE_URL", "OLLAMA_HOST"],
        options: {},
        models: {
          "llama3.1:8b-instruct": {
            id: "llama3.1:8b-instruct",
            providerID: "ollama",
            api: {
              id: "llama3.1:8b-instruct",
              url: "http://127.0.0.1:11434",
              npm: "@ai-sdk/openai-compatible",
            },
            name: "llama3.1:8b-instruct",
            family: "ollama",
            capabilities: {
              temperature: true,
              reasoning: false,
              attachment: false,
              toolcall: false,
              input: { text: true, audio: false, image: false, video: false, pdf: false },
              output: { text: true, audio: false, image: false, video: false, pdf: false },
              interleaved: false,
            },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            limit: { context: 16384, output: 4096 },
            status: "active",
            options: {},
            headers: {},
            release_date: "2026-01-01",
            variants: {},
          },
        },
      }
    }

    const disabled = new Set(config.disabled_providers ?? [])
    const enabled = config.enabled_providers ? new Set(config.enabled_providers) : null

    function isProviderAllowed(providerID: string): boolean {
      if (enabled && !enabled.has(providerID)) return false
      if (disabled.has(providerID)) return false
      return true
    }

    const providers: { [providerID: string]: Info } = {}
    const languages = new Map<string, LanguageModelV2>()
    const modelLoaders: {
      [providerID: string]: CustomModelLoader
    } = {}
    const sdk = new Map<number, SDK>()

    log.info("init")

    const configProviders = Object.entries(config.provider ?? {})

    // Add GitHub Copilot Enterprise provider that inherits from GitHub Copilot
    if (database["github-copilot"]) {
      const githubCopilot = database["github-copilot"]
      database["github-copilot-enterprise"] = {
        ...githubCopilot,
        id: "github-copilot-enterprise",
        name: "GitHub Copilot Enterprise",
        models: mapValues(githubCopilot.models, (model) => ({
          ...model,
          providerID: "github-copilot-enterprise",
        })),
      }
    }

    function mergeProvider(providerID: string, provider: Partial<Info>) {
      const existing = providers[providerID]
      if (existing) {
        // @ts-expect-error
        providers[providerID] = mergeDeep(existing, provider)
        return
      }
      const match = database[providerID]
      if (!match) return
      // @ts-expect-error
      providers[providerID] = mergeDeep(match, provider)
    }

    // extend database from config
    for (const [providerID, provider] of configProviders) {
      const existing = database[providerID]
      const parsed: Info = {
        id: providerID,
        name: provider.name ?? existing?.name ?? providerID,
        env: provider.env ?? existing?.env ?? [],
        options: mergeDeep(existing?.options ?? {}, provider.options ?? {}),
        source: "config",
        models: existing?.models ?? {},
      }

      for (const [modelID, model] of Object.entries(provider.models ?? {})) {
        const existingModel = parsed.models[model.id ?? modelID]
        const name = iife(() => {
          if (model.name) return model.name
          if (model.id && model.id !== modelID) return modelID
          return existingModel?.name ?? modelID
        })
        const cfgToolCall =
          model.tool_call ?? model.toolCall ?? model.toolcall ?? existingModel?.capabilities.toolcall ?? true
        const parsedModel: Model = {
          id: modelID,
          api: {
            id: model.id ?? existingModel?.api.id ?? modelID,
            npm:
              model.provider?.npm ??
              provider.npm ??
              existingModel?.api.npm ??
              modelsDev[providerID]?.npm ??
              "@ai-sdk/openai-compatible",
            url: provider?.api ?? existingModel?.api.url ?? modelsDev[providerID]?.api,
          },
          status: model.status ?? existingModel?.status ?? "active",
          name,
          providerID,
          capabilities: {
            temperature: model.temperature ?? existingModel?.capabilities.temperature ?? false,
            reasoning: model.reasoning ?? existingModel?.capabilities.reasoning ?? false,
            attachment: model.attachment ?? existingModel?.capabilities.attachment ?? false,
            toolcall: cfgToolCall,
            input: {
              text: model.modalities?.input?.includes("text") ?? existingModel?.capabilities.input.text ?? true,
              audio: model.modalities?.input?.includes("audio") ?? existingModel?.capabilities.input.audio ?? false,
              image: model.modalities?.input?.includes("image") ?? existingModel?.capabilities.input.image ?? false,
              video: model.modalities?.input?.includes("video") ?? existingModel?.capabilities.input.video ?? false,
              pdf: model.modalities?.input?.includes("pdf") ?? existingModel?.capabilities.input.pdf ?? false,
            },
            output: {
              text: model.modalities?.output?.includes("text") ?? existingModel?.capabilities.output.text ?? true,
              audio: model.modalities?.output?.includes("audio") ?? existingModel?.capabilities.output.audio ?? false,
              image: model.modalities?.output?.includes("image") ?? existingModel?.capabilities.output.image ?? false,
              video: model.modalities?.output?.includes("video") ?? existingModel?.capabilities.output.video ?? false,
              pdf: model.modalities?.output?.includes("pdf") ?? existingModel?.capabilities.output.pdf ?? false,
            },
            interleaved: model.interleaved ?? false,
          },
          cost: {
            input: model?.cost?.input ?? existingModel?.cost?.input ?? 0,
            output: model?.cost?.output ?? existingModel?.cost?.output ?? 0,
            cache: {
              read: model?.cost?.cache_read ?? existingModel?.cost?.cache.read ?? 0,
              write: model?.cost?.cache_write ?? existingModel?.cost?.cache.write ?? 0,
            },
          },
          options: mergeDeep(existingModel?.options ?? {}, model.options ?? {}),
          limit: {
            context: model.limit?.context ?? existingModel?.limit?.context ?? 0,
            output: model.limit?.output ?? existingModel?.limit?.output ?? 0,
          },
          headers: mergeDeep(existingModel?.headers ?? {}, model.headers ?? {}),
          family: model.family ?? existingModel?.family ?? "",
          release_date: model.release_date ?? existingModel?.release_date ?? "",
          variants: {},
        }
        const merged = mergeDeep(ProviderTransform.variants(parsedModel), model.variants ?? {})
        parsedModel.variants = mapValues(
          pickBy(merged, (v) => !v.disabled),
          (v) => omit(v, ["disabled"]),
        )
        parsed.models[modelID] = parsedModel
      }
      database[providerID] = parsed
    }

    // load env
    const env = Env.all()
    for (const [providerID, provider] of Object.entries(database)) {
      if (disabled.has(providerID)) continue
      const apiKey = provider.env.map((item) => env[item]).find(Boolean)
      if (!apiKey) continue
      mergeProvider(providerID, {
        source: "env",
        key: provider.env.length === 1 ? apiKey : undefined,
      })
    }

    // load apikeys
    for (const [providerID, provider] of Object.entries(await Auth.all())) {
      if (disabled.has(providerID)) continue
      if (provider.type === "api") {
        mergeProvider(providerID, {
          source: "api",
          key: provider.key,
        })
      }
    }

    for (const plugin of await Plugin.list()) {
      if (!plugin.auth) continue
      const providerID = plugin.auth.provider
      if (disabled.has(providerID)) continue

      // For github-copilot plugin, check if auth exists for either github-copilot or github-copilot-enterprise
      let hasAuth = false
      const auth = await Auth.get(providerID)
      if (auth) hasAuth = true

      // Special handling for github-copilot: also check for enterprise auth
      if (providerID === "github-copilot" && !hasAuth) {
        const enterpriseAuth = await Auth.get("github-copilot-enterprise")
        if (enterpriseAuth) hasAuth = true
      }

      if (!hasAuth) continue
      if (!plugin.auth.loader) continue

      // Load for the main provider if auth exists
      if (auth) {
        const options = await plugin.auth.loader(() => Auth.get(providerID) as any, database[plugin.auth.provider])
        mergeProvider(plugin.auth.provider, {
          source: "custom",
          options: options,
        })
      }

      // If this is github-copilot plugin, also register for github-copilot-enterprise if auth exists
      if (providerID === "github-copilot") {
        const enterpriseProviderID = "github-copilot-enterprise"
        if (!disabled.has(enterpriseProviderID)) {
          const enterpriseAuth = await Auth.get(enterpriseProviderID)
          if (enterpriseAuth) {
            const enterpriseOptions = await plugin.auth.loader(
              () => Auth.get(enterpriseProviderID) as any,
              database[enterpriseProviderID],
            )
            mergeProvider(enterpriseProviderID, {
              source: "custom",
              options: enterpriseOptions,
            })
          }
        }
      }
    }

    for (const [providerID, fn] of Object.entries({ ...CUSTOM_LOADERS, ...ProviderExtensions.customLoaders() })) {
      if (disabled.has(providerID)) continue
      const result = await fn(database[providerID])
      if (result && (result.autoload || providers[providerID])) {
        if (result.getModel) modelLoaders[providerID] = result.getModel
        mergeProvider(providerID, {
          source: "custom",
          options: result.options,
        })
      }
    }

    // load config
    for (const [providerID, provider] of configProviders) {
      const partial: Partial<Info> = { source: "config" }
      if (provider.env) partial.env = provider.env
      if (provider.name) partial.name = provider.name
      if (provider.options) partial.options = provider.options
      mergeProvider(providerID, partial)
    }

    for (const [providerID, provider] of Object.entries(providers)) {
      if (!isProviderAllowed(providerID)) {
        delete providers[providerID]
        continue
      }

      if (providerID === "github-copilot" || providerID === "github-copilot-enterprise") {
        provider.models = mapValues(provider.models, (model) => ({
          ...model,
          api: {
            ...model.api,
            npm: "@ai-sdk/github-copilot",
          },
        }))
      }

      const configProvider = config.provider?.[providerID]

      for (const [modelID, model] of Object.entries(provider.models)) {
        model.api.id = model.api.id ?? model.id ?? modelID
        if (modelID === "gpt-5-chat-latest" || (providerID === "openrouter" && modelID === "openai/gpt-5-chat"))
          delete provider.models[modelID]
        if (model.status === "alpha" && !Flag.OPENCODE_ENABLE_EXPERIMENTAL_MODELS) delete provider.models[modelID]
        if (model.status === "deprecated") delete provider.models[modelID]
        if (
          (configProvider?.blacklist && configProvider.blacklist.includes(modelID)) ||
          (configProvider?.whitelist && !configProvider.whitelist.includes(modelID))
        )
          delete provider.models[modelID]

        // Filter out disabled variants from config
        const configVariants = configProvider?.models?.[modelID]?.variants
        if (configVariants && model.variants) {
          const merged = mergeDeep(model.variants, configVariants)
          model.variants = mapValues(
            pickBy(merged, (v) => !v.disabled),
            (v) => omit(v, ["disabled"]),
          )
        }
      }

      if (Object.keys(provider.models).length === 0) {
        delete providers[providerID]
        continue
      }

      log.info("found", { providerID })
    }

    return {
      models: languages,
      providers,
      sdk,
      modelLoaders,
    }
  })

  export async function list() {
    return state().then((state) => state.providers)
  }

  async function getSDK(model: Model) {
    try {
      using _ = log.time("getSDK", {
        providerID: model.providerID,
      })
      const s = await state()
      const provider = s.providers[model.providerID]
      const options = { ...provider.options }

      const resolvedNpm = model.api.npm === "custom" ? "@ai-sdk/openai-compatible" : model.api.npm

      if (resolvedNpm.includes("@ai-sdk/openai-compatible") && options["includeUsage"] !== false) {
        options["includeUsage"] = true
      }

      if (!options["baseURL"]) options["baseURL"] = model.api.url
      if (options["apiKey"] === undefined && provider.key) options["apiKey"] = provider.key
      if (model.headers)
        options["headers"] = {
          ...options["headers"],
          ...model.headers,
        }

      const key = Bun.hash.xxHash32(JSON.stringify({ npm: resolvedNpm, options }))
      const existing = s.sdk.get(key)
      if (existing) return existing

      const customFetch = options["fetch"]

      options["fetch"] = async (input: any, init?: BunFetchRequestInit) => {
        // Preserve custom fetch if it exists, wrap it with timeout logic
        const fetchFn = customFetch ?? fetch
        const opts = init ?? {}

        if (options["timeout"] !== undefined && options["timeout"] !== null) {
          const signals: AbortSignal[] = []
          if (opts.signal) signals.push(opts.signal)
          if (options["timeout"] !== false) signals.push(AbortSignal.timeout(options["timeout"]))

          const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0]

          opts.signal = combined
        }

        return fetchFn(input, {
          ...opts,
          // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
          timeout: false,
        })
      }

      // Special case: google-vertex-anthropic uses a subpath import
      const bundledKey =
        model.providerID === "google-vertex-anthropic" ? "@ai-sdk/google-vertex/anthropic" : resolvedNpm
      const bundledFn = BUNDLED_PROVIDERS[bundledKey]
      if (bundledFn) {
        log.info("using bundled provider", { providerID: model.providerID, pkg: bundledKey })
        const loaded = bundledFn({
          name: model.providerID,
          ...options,
        })
        s.sdk.set(key, loaded)
        return loaded as SDK
      }

      let installedPath: string
      if (!resolvedNpm.startsWith("file://")) {
        installedPath = await BunProc.install(resolvedNpm, "latest")
      } else {
        log.info("loading local provider", { pkg: resolvedNpm })
        installedPath = resolvedNpm
      }

      const mod = await import(installedPath)

      const fn = mod[Object.keys(mod).find((key) => key.startsWith("create"))!]
      const loaded = fn({
        name: model.providerID,
        ...options,
      })
      s.sdk.set(key, loaded)
      return loaded as SDK
    } catch (e) {
      throw new InitError({ providerID: model.providerID }, { cause: e })
    }
  }

  export async function getProvider(providerID: string) {
    return state().then((s) => s.providers[providerID])
  }

  export async function getModel(providerID: string, modelID: string) {
    const s = await state()
    const provider = s.providers[providerID]
    if (!provider) {
      const availableProviders = Object.keys(s.providers)
      const matches = fuzzysort.go(providerID, availableProviders, { limit: 3, threshold: -10000 })
      const suggestions = matches.map((m) => m.target)
      throw new ModelNotFoundError({ providerID, modelID, suggestions })
    }

    const info = provider.models[modelID]
    if (!info) {
      const availableModels = Object.keys(provider.models)
      const matches = fuzzysort.go(modelID, availableModels, { limit: 3, threshold: -10000 })
      const suggestions = matches.map((m) => m.target)
      throw new ModelNotFoundError({ providerID, modelID, suggestions })
    }
    return info
  }

  export async function getLanguage(model: Model): Promise<LanguageModelV2> {
    const s = await state()
    const key = `${model.providerID}/${model.id}`
    if (s.models.has(key)) return s.models.get(key)!

    const provider = s.providers[model.providerID]
    const sdk = await getSDK(model)

    try {
      const language = await (async () => {
        if (s.modelLoaders[model.providerID]) {
          return s.modelLoaders[model.providerID](sdk, model.api.id, provider.options)
        }
        if ((model.family === "ollama" || model.providerID.includes("ollama")) && typeof (sdk as any).chat === "function") {
          return (sdk as any).chat(model.api.id)
        }
        return sdk.languageModel(model.api.id)
      })()
      s.models.set(key, language)
      return language
    } catch (e) {
      if (e instanceof NoSuchModelError)
        throw new ModelNotFoundError(
          {
            modelID: model.id,
            providerID: model.providerID,
          },
          { cause: e },
        )
      throw e
    }
  }

  export async function closest(providerID: string, query: string[]) {
    const s = await state()
    const provider = s.providers[providerID]
    if (!provider) return undefined
    for (const item of query) {
      for (const modelID of Object.keys(provider.models)) {
        if (modelID.includes(item))
          return {
            providerID,
            modelID,
          }
      }
    }
  }

  export async function getSmallModel(providerID: string) {
    const cfg = await Config.get()

    if (cfg.small_model) {
      const parsed = parseModel(cfg.small_model)
      return getModel(parsed.providerID, parsed.modelID)
    }

    const provider = await state().then((state) => state.providers[providerID])
    if (provider) {
      let priority = [
        "claude-haiku-4-5",
        "claude-haiku-4.5",
        "3-5-haiku",
        "3.5-haiku",
        "gemini-3-flash",
        "gemini-2.5-flash",
        "gpt-5-nano",
      ]
      if (providerID.startsWith("opencode")) {
        priority = ["gpt-5-nano"]
      }
      if (providerID.startsWith("github-copilot")) {
        // prioritize free models for github copilot
        priority = ["gpt-5-mini", "claude-haiku-4.5", ...priority]
      }
      for (const item of priority) {
        for (const model of Object.keys(provider.models)) {
          if (model.includes(item)) return getModel(providerID, model)
        }
      }
    }

    // Check if opencode provider is available before using it
    const opencodeProvider = await state().then((state) => state.providers["opencode"])
    if (opencodeProvider && opencodeProvider.models["gpt-5-nano"]) {
      return getModel("opencode", "gpt-5-nano")
    }

    return undefined
  }

  const priority = ["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]
  export function sort(models: Model[]) {
    return sortBy(
      models,
      [(model) => priority.findIndex((filter) => model.id.includes(filter)), "desc"],
      [(model) => (model.id.includes("latest") ? 0 : 1), "asc"],
      [(model) => model.id, "desc"],
    )
  }

  export async function defaultModel() {
    const cfg = await Config.get()
    if (cfg.model) return parseModel(cfg.model)

    const provider = await list()
      .then((val) => Object.values(val))
      .then((x) => x.find((p) => !cfg.provider || Object.keys(cfg.provider).includes(p.id)))
    if (!provider) throw new Error("no providers found")
    const [model] = sort(Object.values(provider.models))
    if (!model) throw new Error("no models found")
    return {
      providerID: provider.id,
      modelID: model.id,
    }
  }

  export function parseModel(model: string) {
    const [providerID, ...rest] = model.split("/")
    return {
      providerID: providerID,
      modelID: rest.join("/"),
    }
  }

  export const ModelNotFoundError = NamedError.create(
    "ProviderModelNotFoundError",
    z.object({
      providerID: z.string(),
      modelID: z.string(),
      suggestions: z.array(z.string()).optional(),
    }),
  )

  export const InitError = NamedError.create(
    "ProviderInitError",
    z.object({
      providerID: z.string(),
    }),
  )
}
