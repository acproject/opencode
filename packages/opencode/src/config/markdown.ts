import { NamedError } from "@opencode-ai/util/error"
import matter from "gray-matter"
import { z } from "zod"

export namespace ConfigMarkdown {
  export const FILE_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g
  export const SHELL_REGEX = /!`([^`]+)`/g
  export const FENCED_CODE_BLOCK_REGEX = /```([^\n`]*)\n([\s\S]*?)\n```/g

  export function files(template: string) {
    return Array.from(template.matchAll(FILE_REGEX))
  }

  export function shell(template: string) {
    return Array.from(template.matchAll(SHELL_REGEX))
  }

  export function fencedCodeBlocks(template: string) {
    return Array.from(template.matchAll(FENCED_CODE_BLOCK_REGEX)).map((m) => {
      const rawLang = (m[1] ?? "").trim()
      const lang = rawLang.split(/\s+/)[0]?.toLowerCase() ?? ""
      const content = (m[2] ?? "").trimEnd()
      return { lang, rawLang, content }
    })
  }

  export async function parse(filePath: string) {
    const template = await Bun.file(filePath).text()

    try {
      const md = matter(template)
      return md
    } catch (err) {
      throw new FrontmatterError(
        {
          path: filePath,
          message: `Failed to parse YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
        },
        { cause: err },
      )
    }
  }

  export const FrontmatterError = NamedError.create(
    "ConfigFrontmatterError",
    z.object({
      path: z.string(),
      message: z.string(),
    }),
  )
}
