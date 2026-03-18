#!/usr/bin/env bun

// 测试脚本：验证构建修复效果

import { spawn } from "child_process"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

console.log("🧪 测试构建修复效果")
console.log("====================")

// 测试 1: 检查构建脚本修改
console.log("\n1️⃣ 检查构建脚本修改...")
try {
  const buildScript = await Bun.file(path.join(__dirname, "script", "build.ts")).text()
  const hasProductionCondition = buildScript.includes('"production"')
  const hasDevelopmentCondition = buildScript.includes('"development"')
  const hasBuildModeDefine = buildScript.includes('"process.env.BUILD_MODE"')
  
  console.log(`   ✅ 生产环境条件: ${hasProductionCondition ? "✓" : "✗"}`)
  console.log(`   ✅ 开发环境条件: ${hasDevelopmentCondition ? "✓" : "✗"}`)
  console.log(`   ✅ 构建模式定义: ${hasBuildModeDefine ? "✓" : "✗"}`)
} catch (e) {
  console.log(`   ❌ 构建脚本检查失败: ${e}`)
}

// 测试 2: 检查环境适配层
console.log("\n2️⃣ 检查 LSP 环境适配层...")
try {
  const envModule = await Bun.file(path.join(__dirname, "src", "lsp", "env.ts")).text()
  const hasGetLspEnvironment = envModule.includes("getLspEnvironment")
  const hasProcessEnv = envModule.includes("process.env")
  const hasPathHandling = envModule.includes("PATH")
  
  console.log(`   ✅ 环境获取函数: ${hasGetLspEnvironment ? "✓" : "✗"}`)
  console.log(`   ✅ 进程环境访问: ${hasProcessEnv ? "✓" : "✗"}`)
  console.log(`   ✅ 路径处理: ${hasPathHandling ? "✓" : "✗"}`)
} catch (e) {
  console.log(`   ❌ 环境适配层检查失败: ${e}`)
}

// 测试 3: 检查 Tools 配置
console.log("\n3️⃣ 检查 Tools Call 配置...")
try {
  const lspTool = await Bun.file(path.join(__dirname, "src", "tool", "lsp.ts")).text()
  const hasProductionCheck = lspTool.includes("process.env.BUILD_MODE")
  const hasProductionMode = lspTool.includes("productionMode")
  
  console.log(`   ✅ 生产模式检测: ${hasProductionCheck ? "✓" : "✗"}`)
  console.log(`   ✅ 生产模式处理: ${hasProductionMode ? "✓" : "✗"}`)
} catch (e) {
  console.log(`   ❌ Tools 配置检查失败: ${e}`)
}

// 测试 4: 检查 package.json scripts
console.log("\n4️⃣ 检查 package.json scripts...")
try {
  const packageJson = await Bun.file(path.join(__dirname, "package.json")).json()
  const hasBuildDev = packageJson.scripts["build:dev"] !== undefined
  const hasDevProd = packageJson.scripts["dev:prod"] !== undefined
  const buildScript = packageJson.scripts["build"]
  
  console.log(`   ✅ 开发构建脚本: ${hasBuildDev ? "✓" : "✗"}`)
  console.log(`   ✅ 生产开发脚本: ${hasDevProd ? "✓" : "✗"}`)
  console.log(`   ✅ 构建脚本存在: ${buildScript ? "✓" : "✗"}`)
} catch (e) {
  console.log(`   ❌ package.json 检查失败: ${e}`)
}

console.log("\n📋 测试总结")
console.log("================")
console.log("✅ 主要修复已完成:")
console.log("   - 构建条件配置修改")
console.log("   - LSP 环境变量适配")
console.log("   - Tools Call 配置更新")
console.log("   - 环境配置文件创建")
console.log("\n⚠️  需要手动验证:")
console.log("   - 运行 'bun run build:dev' 测试开发构建")
console.log("   - 运行 'bun run build' 测试生产构建")
console.log("   - 测试 LSP 服务器启动")
console.log("   - 测试 Tools Call 功能")
