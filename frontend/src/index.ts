// index.ts -- public surface of featurelab-frontend. Both app shells (the VS Code webview
// today, a future Wails desktop app) import only from here.
export { VoxelViewer } from './viewer.js'
export type { AttributionGroup, AttributionGroupState, BlockKind, EnvironmentMode, PickedCell, TextureReport, ViewerPaletteEntry, ViewerVolume } from './viewer.js'

export { buildScenePasses, heatColor, summarizeVolume } from './remesh.js'
export type { AttributionState, CellBox, ScenePasses, SceneInput, VolumeSummary } from './remesh.js'

export { buildMesh, buildOverflowMesh, compileAtlas, concatMeshBuffers, EMPTY_MESH_BUFFERS, faceST, FACES, FACE_COUNT, PASS_ALPHA_TESTED, PASS_TRANSLUCENT } from './mesher.js'
export type { CompiledAtlas, MeshBuffers, MesherAtlas, OverflowBlockMesh } from './mesher.js'

export { compileShapes, rotationForStates, shapeForBlock } from './shapes.js'
export type { BlockShape, CompiledShape, ShapeQuad } from './shapes.js'

export { decodeGenerateResult, decodeAtlas, parseHexColor, base64ToUint8Array, atlasBlockKey, indexStatedAtlasBlocks, lookupAtlasBlock, ATLAS_TABLE_VERSION, ENGINE_DEFAULT_WRITE_BUDGET, ENGINE_DEFAULT_DELEGATION_BUDGET, ENGINE_DEFAULT_PLACEMENT_TIME_LIMIT_MS } from './protocol.js'
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
  ResultStopWire,
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

export { createPanel, describeStop, REGENERATE_DEBOUNCE_MS } from './ui/panel.js'
export type { Mode, PanelHandle, PanelOptions, StopDescription } from './ui/panel.js'

export { createViewportOverlay, formatElapsed } from './ui/viewportOverlay.js'
export type { LegendEntry, OverlayNotice, ViewportOverlayHandle, ViewportOverlayOptions, ViewportOverlayState } from './ui/viewportOverlay.js'

export { createSplitter, DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_CANVAS_WIDTH } from './ui/splitter.js'
export type { SplitterHandle, SplitterOptions } from './ui/splitter.js'

export { boxContains, computeClipPlanes, maxDollyDistance } from './cameraFit.js'
export type { Box3 } from './cameraFit.js'

export { attributionColor, attributionColorCss, attributionColorPacked, ATTRIBUTION_SERIES_LENGTH, colorForBlockName, tintColorForChannel, knownTintChannels } from './colors.js'
