import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

// Find the ScrollBox implementation file from @opentui/core
function findScrollBoxFile(): string {
  // Check node_modules/@opentui/core directly
  const coreDir = path.resolve(dir, "node_modules/@opentui/core")
  if (fs.existsSync(coreDir)) {
    const entries = fs.readdirSync(coreDir)
    for (const f of entries) {
      if (!f.startsWith("index-") || !f.endsWith(".js")) continue
      const full = path.resolve(coreDir, f)
      const content = fs.readFileSync(full, "utf-8")
      if (content.includes("class ScrollBoxRenderable")) {
        return full
      }
    }
  }

  // Check bun cache
  const topDir = path.resolve(dir, "../node_modules/.bun")
  if (fs.existsSync(topDir)) {
    const packs = fs.readdirSync(topDir)
    for (const p of packs) {
      if (!p.startsWith("@opentui+core")) continue
      const pkgDir = path.resolve(topDir, p, "node_modules/@opentui/core")
      if (!fs.existsSync(pkgDir)) continue
      const entries = fs.readdirSync(pkgDir)
      for (const f of entries) {
        if (!f.startsWith("index-") || !f.endsWith(".js")) continue
        const full = path.resolve(pkgDir, f)
        const content = fs.readFileSync(full, "utf-8")
        if (content.includes("class ScrollBoxRenderable")) {
          return full
        }
      }
    }
  }

  return ""
}

const scrollBoxFile = findScrollBoxFile()
if (!scrollBoxFile) {
  console.error("[patch-opentui-scrollbox] Could not find ScrollBox implementation file")
  process.exit(1)
}

console.log(`[patch-opentui-scrollbox] Found ScrollBox in: ${path.basename(scrollBoxFile)}`)

let content = fs.readFileSync(scrollBoxFile, "utf-8")
let changed = false
let pending = 0

// Patch: Alt+MouseWheel 3x scroll speed
{
  const marker = "event.modifiers.alt ? 3 : 1"
  if (content.includes(marker)) {
    console.log("[patch-opentui-scrollbox] [1/1] Alt scroll patch already applied, skipping")
  } else {
    const search = `const baseDelta = event.scroll?.delta ?? 0;`
    const replace = `const baseDelta = (event.scroll?.delta ?? 0) * (event.modifiers.alt ? 3 : 1);`
    if (!content.includes(search)) {
      console.error("[patch-opentui-scrollbox] [1/1] Could not find target code")
      pending++
    } else {
      content = content.replace(search, replace)
      changed = true
      console.log("[patch-opentui-scrollbox] [1/1] Alt+MouseWheel 3x scroll speed patch applied")
    }
  }
}

if (pending > 0) {
  console.error(`[patch-opentui-scrollbox] ${pending} patch(es) failed to find target code`)
  process.exit(1)
}

if (changed) {
  fs.writeFileSync(scrollBoxFile, content, "utf-8")
  console.log("[patch-opentui-scrollbox] Patches written")
} else {
  console.log("[patch-opentui-scrollbox] All patches already applied, nothing changed")
}
