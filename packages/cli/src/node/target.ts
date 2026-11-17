const platforms = ["darwin", "linux", "win32"] as const

export type NodeTarget = ReturnType<typeof nodeTarget>

export function nodeTarget(platform: string, arch: string) {
  if (!platforms.includes(platform as (typeof platforms)[number]) || arch !== "x64") {
    throw new Error(`Unsupported Node executable target: ${platform}-${arch}`)
  }

  const targetPlatform = platform as (typeof platforms)[number]
  const nodePtyPackage = `@lydell/node-pty-${targetPlatform}-${arch}`
  const parcelWatcherPackage = `@parcel/watcher-${targetPlatform}-${arch}${targetPlatform === "linux" ? "-glibc" : ""}`
  const fffPackage = `@ff-labs/fff-bin-${targetPlatform}-${arch}${targetPlatform === "linux" ? "-gnu" : ""}`
  const fffFfiPackage = `@yuuang/ffi-rs-${targetPlatform}-${arch}${targetPlatform === "linux" ? "-gnu" : targetPlatform === "win32" ? "-msvc" : ""}`
  const opencodePtyAsset = targetPlatform === "win32" ? "opencode-pty/opencode-pty.exe" : "opencode-pty/opencode-pty"

  return {
    platform: targetPlatform,
    arch: "x64" as const,
    nodePtyPackage,
    nodePtyEntryAsset: `${nodePtyPackage}/lib/index.js`,
    parcelWatcherPackage,
    parcelWatcherAsset: `${parcelWatcherPackage}/watcher.node`,
    fffPackage,
    fffAsset: `${fffPackage}/${targetPlatform === "darwin" ? "libfff_c.dylib" : targetPlatform === "win32" ? "fff_c.dll" : "libfff_c.so"}`,
    fffFfiPackage,
    fffFfiAsset: `${fffFfiPackage}/ffi-rs.${targetPlatform}-${arch}${targetPlatform === "linux" ? "-gnu" : targetPlatform === "win32" ? "-msvc" : ""}.node`,
    opencodePtyAsset,
  }
}

export const photonWasmAsset = "@silvia-odwyer/photon-node/photon_rs_bg.wasm"
export const nodeExecArgv = ["--experimental-ffi", "--use-system-ca", "--disable-warning=ExperimentalWarning"] as const

export const attentionSoundAssets = [
  "@opencode/ui/audio/bip-bop-01.mp3",
  "@opencode/ui/audio/bip-bop-03.mp3",
  "@opencode/ui/audio/staplebops-06.mp3",
  "@opencode/ui/audio/nope-03.mp3",
  "@opencode/ui/audio/yup-01.mp3",
] as const
