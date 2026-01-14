import z from "zod"
import { Tool } from "./tool"
import { Ripgrep } from "../file/ripgrep"
import path from "path"
import { Global } from "../global"
import fs from "fs/promises"

import DESCRIPTION from "./grep.txt"
import { Instance } from "../project/instance"

const MAX_LINE_LENGTH = 2000

export const GrepTool = Tool.define("grep", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The regex pattern to search for in file contents"),
    path: z.string().optional().describe("The directory to search in. Defaults to the current working directory."),
    include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
  }),
  async execute(params, ctx) {
    if (!params.pattern) {
      throw new Error("pattern is required")
    }

    await ctx.ask({
      permission: "grep",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        pattern: params.pattern,
        path: params.path,
        include: params.include,
      },
    })

    const searchPath = params.path || Instance.directory

    const rgPath = Bun.which("rg") || (await getCachedRipgrepPath())
    const matches = rgPath
      ? await grepWithRipgrep({ rgPath, searchPath, pattern: params.pattern, include: params.include })
      : await grepFallback({ searchPath, pattern: params.pattern, include: params.include })

    matches.sort((a, b) => b.modTime - a.modTime)

    const limit = 100
    const truncated = matches.length > limit
    const finalMatches = truncated ? matches.slice(0, limit) : matches

    if (finalMatches.length === 0) {
      return {
        title: params.pattern,
        metadata: { matches: 0, truncated: false },
        output: "No files found",
      }
    }

    const outputLines = [`Found ${finalMatches.length} matches`]

    let currentFile = ""
    for (const match of finalMatches) {
      if (currentFile !== match.path) {
        if (currentFile !== "") {
          outputLines.push("")
        }
        currentFile = match.path
        outputLines.push(`${match.path}:`)
      }
      const truncatedLineText =
        match.lineText.length > MAX_LINE_LENGTH ? match.lineText.substring(0, MAX_LINE_LENGTH) + "..." : match.lineText
      outputLines.push(`  Line ${match.lineNum}: ${truncatedLineText}`)
    }

    if (truncated) {
      outputLines.push("")
      outputLines.push("(Results are truncated. Consider using a more specific path or pattern.)")
    }

    return {
      title: params.pattern,
      metadata: {
        matches: finalMatches.length,
        truncated,
      },
      output: outputLines.join("\n"),
    }
  },
})

async function getCachedRipgrepPath() {
  const candidate = path.join(Global.Path.bin, "rg" + (process.platform === "win32" ? ".exe" : ""))
  const exists = await fs
    .stat(candidate)
    .then((s) => s.isFile())
    .catch(() => false)
  return exists ? candidate : null
}

async function grepWithRipgrep(input: { rgPath: string; searchPath: string; pattern: string; include?: string }) {
  const args = ["-nH", "--field-match-separator=|", "--regexp", input.pattern]
  if (input.include) {
    args.push("--glob", input.include)
  }
  args.push(input.searchPath)

  const proc = Bun.spawn([input.rgPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })

  const output = await new Response(proc.stdout).text()
  const errorOutput = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  if (exitCode === 1) {
    return []
  }

  if (exitCode !== 0) {
    throw new Error(`ripgrep failed: ${errorOutput}`)
  }

  const lines = output.trim().split(/\r?\n/)
  const matches: Array<{ path: string; modTime: number; lineNum: number; lineText: string }> = []

  for (const line of lines) {
    if (!line) continue

    const [filePath, lineNumStr, ...lineTextParts] = line.split("|")
    if (!filePath || !lineNumStr || lineTextParts.length === 0) continue

    const lineNum = parseInt(lineNumStr, 10)
    const lineText = lineTextParts.join("|")

    const stats = await Bun.file(filePath).stat().catch(() => null)
    if (!stats) continue

    matches.push({
      path: filePath,
      modTime: stats.mtime.getTime(),
      lineNum,
      lineText,
    })
  }

  return matches
}

async function grepFallback(input: { searchPath: string; pattern: string; include?: string }) {
  const pattern = new RegExp(input.pattern)
  const stats = await fs.stat(input.searchPath)
  const files = stats.isFile() ? [input.searchPath] : await listFiles(input.searchPath, input.include)

  const matches: Array<{ path: string; modTime: number; lineNum: number; lineText: string }> = []

  for (const filePath of files) {
    const text = await Bun.file(filePath)
      .text()
      .catch(() => null)
    if (text === null) continue

    const fileStats = await fs.stat(filePath).catch(() => null)
    if (!fileStats) continue

    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i] ?? ""
      if (!pattern.test(lineText)) continue

      matches.push({
        path: filePath,
        modTime: fileStats.mtime.getTime(),
        lineNum: i + 1,
        lineText,
      })
    }
  }

  return matches
}

async function listFiles(root: string, include?: string) {
  const glob = include ? (include.includes("/") || include.startsWith("**") ? include : `**/${include}`) : "**/*"
  const entries = await Array.fromAsync(
    new Bun.Glob(glob).scan({
      cwd: root,
      absolute: true,
    }),
  )
  const files: string[] = []
  for (const p of entries) {
    const s = await fs
      .stat(p)
      .then((x) => (x.isFile() ? x : null))
      .catch(() => null)
    if (!s) continue
    files.push(p)
  }
  return files
}
