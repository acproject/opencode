import { test, expect } from "bun:test"
import { Skill } from "../../src/skill"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import fs from "fs/promises"

async function withTestHome<T>(homeDir: string, fn: () => Promise<T>) {
  const originalHome = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = homeDir
  try {
    return await fn()
  } finally {
    if (originalHome === undefined) {
      delete process.env.OPENCODE_TEST_HOME
    } else {
      process.env.OPENCODE_TEST_HOME = originalHome
    }
  }
}

async function createGlobalSkill(homeDir: string) {
  const skillDir = path.join(homeDir, ".claude", "skills", "global-test-skill")
  await fs.mkdir(skillDir, { recursive: true })
  await Bun.write(
    path.join(skillDir, "SKILL.md"),
    `---
name: global-test-skill
description: A global skill from ~/.claude/skills for testing.
---

# Global Test Skill

This skill is loaded from the global home directory.
`,
  )
}

async function createGlobalTraeSkill(homeDir: string) {
  const skillDir = path.join(homeDir, ".trae", "skills", "global-trae-skill")
  await fs.mkdir(skillDir, { recursive: true })
  await Bun.write(
    path.join(skillDir, "SKILL.md"),
    `---
name: global-trae-skill
description: A global skill from ~/.trae/skills for testing.
---

# Global Trae Skill

This skill is loaded from the global home directory.
`,
  )
}

test("discovers skills from .opencode/skill/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skill", "test-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: test-skill
description: A test skill for verification.
---

# Test Skill

Instructions here.
`,
      )
    },
  })

  await withTestHome(tmp.path, async () => {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        expect(skills.length).toBe(1)
        const testSkill = skills.find((s) => s.name === "test-skill")
        expect(testSkill).toBeDefined()
        expect(testSkill!.description).toBe("A test skill for verification.")
        expect(testSkill!.location).toContain("skill/test-skill/SKILL.md")
      },
    })
  })
})

test("discovers multiple skills from .opencode/skill/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir1 = path.join(dir, ".opencode", "skill", "skill-one")
      const skillDir2 = path.join(dir, ".opencode", "skill", "skill-two")
      await Bun.write(
        path.join(skillDir1, "SKILL.md"),
        `---
name: skill-one
description: First test skill.
---

# Skill One
`,
      )
      await Bun.write(
        path.join(skillDir2, "SKILL.md"),
        `---
name: skill-two
description: Second test skill.
---

# Skill Two
`,
      )
    },
  })

  await withTestHome(tmp.path, async () => {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        expect(skills.length).toBe(2)
        expect(skills.find((s) => s.name === "skill-one")).toBeDefined()
        expect(skills.find((s) => s.name === "skill-two")).toBeDefined()
      },
    })
  })
})

test("skips skills with missing frontmatter", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skill", "no-frontmatter")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `# No Frontmatter

Just some content without YAML frontmatter.
`,
      )
    },
  })

  await withTestHome(tmp.path, async () => {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        expect(skills).toEqual([])
      },
    })
  })
})

test("discovers skills from .claude/skills/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".claude", "skills", "claude-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
      )
    },
  })

  await withTestHome(tmp.path, async () => {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        expect(skills.length).toBe(1)
        const claudeSkill = skills.find((s) => s.name === "claude-skill")
        expect(claudeSkill).toBeDefined()
        expect(claudeSkill!.location).toContain(".claude/skills/claude-skill/SKILL.md")
      },
    })
  })
})

test("discovers global skills from ~/.claude/skills/ directory", async () => {
  await using tmp = await tmpdir({ git: true })

  await withTestHome(tmp.path, async () => {
    await createGlobalSkill(tmp.path)
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        expect(skills.length).toBe(1)
        expect(skills[0].name).toBe("global-test-skill")
        expect(skills[0].description).toBe("A global skill from ~/.claude/skills for testing.")
        expect(skills[0].location).toContain(".claude/skills/global-test-skill/SKILL.md")
      },
    })
  })
})

test("discovers skills from .trae/skills/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".trae", "skills", "trae-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: trae-skill
description: A skill in the .trae/skills directory.
---

# Trae Skill
`,
      )
    },
  })

  await withTestHome(tmp.path, async () => {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        expect(skills.length).toBe(1)
        const traeSkill = skills.find((s) => s.name === "trae-skill")
        expect(traeSkill).toBeDefined()
        expect(traeSkill!.location).toContain(".trae/skills/trae-skill/SKILL.md")
      },
    })
  })
})

test("discovers global skills from ~/.trae/skills/ directory", async () => {
  await using tmp = await tmpdir({ git: true })

  await withTestHome(tmp.path, async () => {
    await createGlobalTraeSkill(tmp.path)
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        expect(skills.length).toBe(1)
        expect(skills[0].name).toBe("global-trae-skill")
        expect(skills[0].description).toBe("A global skill from ~/.trae/skills for testing.")
        expect(skills[0].location).toContain(".trae/skills/global-trae-skill/SKILL.md")
      },
    })
  })
})

test("returns empty array when no skills exist", async () => {
  await using tmp = await tmpdir({ git: true })

  await withTestHome(tmp.path, async () => {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        expect(skills).toEqual([])
      },
    })
  })
})
