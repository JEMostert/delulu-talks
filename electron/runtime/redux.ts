/** Parakeet Redux ships in the Linux x64 speech runtime; other platforms use R2T2. */
export function reduxSupported(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  return platform === "linux" && arch === "x64";
}
