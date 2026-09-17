// index.ts -- public surface of featurelab-frontend. Both app shells (the VS Code webview
// today, a future Wails desktop app) import only from here.
export { VoxelViewer } from './viewer.js'
export type { BlockKind, EnvironmentMode, ViewerPaletteEntry, ViewerVolume } from './viewer.js'

export { buildMesh, buildOverflowMesh, compileAtlas, concatMeshBuffers, EMPTY_MESH_BUFFERS, faceST, FACES, FACE_COUNT, PASS_ALPHA_TESTED, PASS_TRANSLUCENT } from './mesher.js'
export type { CompiledAtlas, MeshBuffers, MesherAtlas, OverflowBlockMesh } from './mesher.js'

export { compileShapes, rotationForStates, shapeForBlock } from './shapes.js'
export type { BlockShape, CompiledShape, ShapeQuad } from './shapes.js'

export { decodeGenerateResult, decodeAtlas, parseHexColor, base64ToUint8Array, ATLAS_TABLE_VERSION, ENGINE_DEFAULT_WRITE_BUDGET, ENGINE_DEFAULT_DELEGATION_BUDGET, ENGINE_DEFAULT_PLACEMENT_TIME_LIMIT_MS } from './protocol.js'
export type {
  BlockCounts,
  DecodedResult,
  DecodedProfile,
  DecodedDiagnostic,
  DiagnosticWire,
  DiagnosticPositionWire,
  GenerateResultWire,
  PaletteEntryWire,
  BoundsWire,
  OriginWire,
  FeatureEntryWire,
  RuleWire,
  RuleEntryWire,
  BiomeEntryWire,
  ResolvedBiomeWire,
  MaterialSlotsWire,
  ClimateWire,
  ReplacementWire,
  ProfileResultWire,
  FeatureProfileStatsWire,
  StopStatWire,
  CellAttributionWire,
  GenerateParamsWire,
  MaterialsWire,
  EnvironmentOptionWire,
  EnvironmentDefaultsWire,
  EnvironmentMaterialsWire,
  OverflowBlockWire,
  AtlasWire,
  AtlasTableWire,
  AtlasBlockWire,
  AtlasCellWire,
  AtlasTintWire,
  AtlasRenderMode,
  DecodedAtlas,
} from './protocol.js'

export { createPanel } from './ui/panel.js'
export type { Mode, PanelHandle, PanelOptions } from './ui/panel.js'

export { createSplitter, DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_CANVAS_WIDTH } from './ui/splitter.js'
export type { SplitterHandle, SplitterOptions } from './ui/splitter.js'

export { colorForBlockName, tintColorForChannel, knownTintChannels } from './colors.js'
