/** The CPU prototype is validated only on Linux x64 and requires manual setup. */
export function reduxCpuEnabled(): boolean {
  return (
    process.platform === "linux" &&
    process.arch === "x64" &&
    process.env.DELULU_REDUX_CPU === "1"
  );
}
