// types.ts -- JSON shapes this app's Go side (apps/desktop/app.go, identifier.go,
// generate.go) sends across the Wails bridge, kept as plain TS interfaces (not the
// wailsjs-generated model classes) so this file stays exactly as readable/reviewable as
// frontend/src/protocol.ts's own wire types, and so a Wails codegen re-run never silently
// changes what this app's own UI code compiles against.

export type PackItemKind = 'feature' | 'rule'

export interface PackItem {
  kind: PackItemKind
  identifier: string
  typeId: string
  fileId: string
}

export interface LoadPackResult {
  dir: string
  warnings: string[]
  items: PackItem[]
}

export interface EnvironmentOption {
  id: string
  label: string
  description: string
  defaultSizeX: number
  defaultSizeY: number
  defaultSizeZ: number
  defaultMinY: number
}

/** Narrows the Wails-generated main.LoadPackResult (whose `kind` field is typed as plain
 * `string`, since Wails' codegen has no notion of a Go string-const enum) into this file's
 * own PackItemKind union -- an unrecognized kind is dropped rather than trusted blindly, the
 * same "don't silently mis-render" posture frontend/src/protocol.ts's decoder takes for the
 * engine's own wire format. */
export function toLoadPackResult(raw: { dir: string; warnings: string[]; items: { kind: string; identifier: string; typeId: string; fileId: string }[] }): LoadPackResult {
  return {
    dir: raw.dir,
    warnings: raw.warnings,
    items: raw.items.filter((i): i is PackItem => i.kind === 'feature' || i.kind === 'rule'),
  }
}

/** Mirrors featurelab/wire's GenerateParams exactly (same JSON field names/shapes,
 * including the "x,y,z" / "XxYxZ" string encoding for origin/size) -- see that package's
 * doc comment for why the desktop app, the CLI, and the VS Code extension all share this
 * exact request shape. Every field is optional; omitted always means "use the preset
 * default" (wire.GenerateParams's own doc comment). */
export interface GenerateParams {
  feature?: string
  rule?: string
  env?: string
  seed?: number
  origin?: string
  size?: string
  minY?: number
  biomeId?: string
  biomeTags?: string[]
  materials?: MaterialOverride
  repeat?: number
  profile?: boolean
}

/** Mirrors wire.Materials -- every field independently optional, nil/absent meaning "use the
 * preset's own default for that slot". */
export interface MaterialOverride {
  topMaterial?: string
  midMaterial?: string
  foundationMaterial?: string
  seaFloorMaterial?: string
  seaMaterial?: string
  seaFloorDepth?: number
}
