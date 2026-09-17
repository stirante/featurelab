// copy-assets.mjs -- tsc only emits .js/.d.ts, so the plain CSS panel.ts's consumers need
// (src/ui/panel.css) has to be copied into dist/ separately as part of `npm run build`.
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// scripts/copy-assets.mjs -> frontend/ is one level up.
const frontendRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(frontendRoot, 'src', 'ui', 'panel.css')
const destDir = join(frontendRoot, 'dist', 'ui')
const dest = join(destDir, 'panel.css')

mkdirSync(destDir, { recursive: true })
copyFileSync(src, dest)
console.log(`copied ${src} -> ${dest}`)
