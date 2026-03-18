#!/usr/bin/env bun

// 权限配置验证脚本

import { Config } from "./src/config/config"
import path from "path"

console.log("🔐 验证 OpenCode 权限配置")
console.log("==============================\n")

try {
  const config = await Config.get()

  // 检查权限配置
  if (config.agent?.build?.permission) {
    console.log("✅ 构建代理权限配置:")
    const permissions = config.agent.build.permission
    const bashPerms = typeof permissions.bash === "object" ? permissions.bash : {}
    console.log(`   - Bash 自动批准命令: ${Object.keys(bashPerms).length} 个`)
    console.log(`   - LSP 自动批准: ${typeof permissions.lsp === "string" && permissions.lsp === "allow" ? "✓" : "✗"}`)
    console.log(`   - Read 自动批准: ${typeof permissions.read === "string" && permissions.read === "allow" ? "✓" : "✗"}`)
    console.log(`   - Glob 自动批准: ${typeof permissions.glob === "string" && permissions.glob === "allow" ? "✓" : "✗"}`)
    console.log(`   - Grep 自动批准: ${typeof permissions.grep === "string" && permissions.grep === "allow" ? "✓" : "✗"}`)
  } else {
    console.log("❌ 未找到构建代理权限配置")
  }

  // 检查构建模式配置
  if (config.agent?.mode?.build) {
    console.log("\n✅ 构建模式配置:")
    console.log(`   - 模型: ${config.agent.mode.build.model || "未设置"}`)
    console.log(`   - Bash 自动批准: ${config.agent.mode.build.permissions?.bash?.auto_approve ? "✓" : "✗"}`)
    console.log(`   - LSP 自动批准: ${config.agent.mode.build.permissions?.lsp?.auto_approve ? "✓" : "✗"}`)
  } else {
    console.log("\n❌ 未找到构建模式配置")
  }

  // 检查 Ollama provider
  if (config.provider?.["owiseman"]) {
    console.log("\n✅ Ollama Provider 配置:")
    const owisemanConfig = config.provider["owiseman"]
    const apiKey = owisemanConfig.api
    console.log(`   - API Key: ${apiKey ? "已设置" : "未设置"}`)
    console.log(`   - Base URL: ${owisemanConfig.options?.baseURL || "默认"}`)
  } else {
    console.log("\n⚠️  未配置 Ollama Provider")
  }

  console.log("\n📋 权限优化建议:")
  console.log("   1. 常用命令已设置为自动批准（ls, cat, grep 等）")
  console.log("   2. LSP 操作已设置为始终允许")
  console.log("   3. 构建模式启用了自动批准功能")
  console.log("\n💡 使用说明:")
  console.log("   - 只读命令（如 ls）将不再提示")
  console.log("   - 修改性命令（如 rm, mv）仍需手动批准")
  console.log("   - LSP 工具调用将自动获得许可")
  console.log("   - 首次使用修改性命令时会询问是否永久批准")

} catch (error) {
  console.error("❌ 配置验证失败:", error)
  process.exit(1)
}
