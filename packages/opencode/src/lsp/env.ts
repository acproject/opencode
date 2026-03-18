import path from "path"
import os from "os"

export function getLspEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BUN_BE_BUN: "1",
  }

  // 确保 PATH 包含必要的路径
  if (env.PATH) {
    // 添加常见的 LSP 服务器路径
    const additionalPaths = [
      "/usr/local/bin",
      "/usr/bin",
      "/opt/homebrew/bin",
      path.join(os.homedir(), ".local", "bin"),
      path.join(os.homedir(), "bin"),
    ].filter(Boolean)

    // 去重并组合路径
    const existingPaths = env.PATH.split(path.delimiter)
    const uniquePaths = [...new Set([...additionalPaths, ...existingPaths])]
    env.PATH = uniquePaths.join(path.delimiter)
  }

  // 确保 HOME 环境变量存在
  if (!env.HOME) {
    env.HOME = os.homedir()
  }

  // 确保 XDG 变量存在（用于 LSP 服务器的配置存储）
  if (!env.XDG_DATA_HOME) {
    env.XDG_DATA_HOME = path.join(os.homedir(), ".local", "share")
  }

  if (!env.XDG_CONFIG_HOME) {
    env.XDG_CONFIG_HOME = path.join(os.homedir(), ".config")
  }

  // 禁用可能导致 LSP 服务器问题的环境变量
  delete env.BUN_ENV
  delete env.NODE_ENV  // 让 LSP 服务器自己决定

  return env
}

// 获取系统临时目录，用于 LSP 服务器的临时文件
export function getLspTempDir(): string {
  const tempDir = path.join(os.tmpdir(), "opencode-lsp")
  
  // 确保临时目录存在
  try {
    const { mkdir } = require("fs/promises")
    mkdir(tempDir, { recursive: true }).catch(() => {})
  } catch {
    // 忽略错误
  }
  
  return tempDir
}
