import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";

export interface ProjectSymbolExtraction {
  symbols: string[];
  filesScanned: number;
  truncated: boolean;
  warnings: string[];
}

const MAX_FILES = 1_000;
const MAX_ENTRIES = 10_000;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_SYMBOLS = 3_000;
const excluded = new Set([
  "node_modules", "venv", "dist", "build", "out", "target", "vendor", "__pycache__",
]);
const supported = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py",
  ".rs", ".go", ".java", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp",
  ".cs", ".php", ".swift", ".kt", ".kts",
]);
const identifier = "([\\p{L}_$][\\p{L}\\p{N}_$]*)";
const modifiers = "(?:(?:export|default|declare|async|abstract|public|private|protected|static|final|sealed|partial|override|open|internal|inline|suspend|data|unsafe|extern)\\s+)*";

function declarationPatterns(extension: string): RegExp[] {
  const expression = (source: string) => new RegExp(source, "gmu");
  const keyword = (words: string) => expression(`^\\s*${modifiers}(?:${words})\\s+${identifier}`);
  if (extension === ".py") return [keyword("def|class|async\\s+def")];
  if (extension === ".rs") return [
    expression(`^\\s*(?:pub(?:\\([^\\n)]*\\))?\\s+)?(?:async\\s+)?(?:fn|struct|enum|trait|type|mod|const|static)\\s+${identifier}`),
  ];
  if (extension === ".go") return [
    expression(`^\\s*func\\s+(?:\\([^\\n)]*\\)\\s*)?${identifier}`),
    keyword("type|var|const"),
  ];
  if (extension === ".swift") return [keyword("func|class|struct|protocol|enum|let|var|typealias|actor")];
  if (extension === ".kt" || extension === ".kts") return [keyword("fun|class|object|interface|val|var|typealias")];
  if (extension === ".php") return [
    keyword("function|class|interface|trait|enum|const"),
    expression(`^\\s*${modifiers}(?:var\\s+)?\\$${identifier}\\s*(?:=|;)`),
  ];
  if ([".java", ".cs", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp"].includes(extension)) {
    return [
      keyword("class|interface|enum|record|struct|union|namespace"),
      // A declaration requires a return type and an opening body brace. Calls
      // and statements without a body are intentionally not harvested.
      expression(`^\\s*${modifiers}[\\p{L}_][\\p{L}\\p{N}_:<>,\\[\\]*&? ]*\\s+${identifier}\\s*\\([^\\n;{}]*\\)\\s*(?:const\\s*)?\\{`),
    ];
  }
  return [keyword("function|class|interface|type|enum|const|let|var")];
}

function declarationSource(source: string, extension: string): string {
  // Mask comments and quoted content before matching declarations, retaining
  // line boundaries. This is a conservative vocabulary heuristic, not an AST.
  const comments = extension === ".py"
    ? /#[^\n]*|'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g
    : /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g;
  return source.replace(comments, (match) => match.replace(/[^\r\n]/g, " "));
}

/** Local name-only extraction. No subprocesses, network requests, or persisted source. */
export async function extractProjectSymbols(root: string): Promise<ProjectSymbolExtraction> {
  const result: ProjectSymbolExtraction = { symbols: [], filesScanned: 0, truncated: false, warnings: [] };
  const warnings = new Set<string>();
  const symbols = new Set<string>();
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
    const rootStat = await lstat(canonicalRoot);
    const gitStat = await lstat(path.join(canonicalRoot, ".git"));
    if (!rootStat.isDirectory() || gitStat.isSymbolicLink() || (!gitStat.isDirectory() && !gitStat.isFile())) {
      throw new Error("Unsupported project root");
    }
  } catch {
    throw new Error("Choose a local Git project root with a regular .git directory or worktree marker.");
  }
  const withinRoot = (candidate: string) => {
    const relative = path.relative(canonicalRoot, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  };
  const directories = [canonicalRoot];
  let entries = 0;
  let totalBytes = 0;
  let stopped = false;
  const truncate = () => { result.truncated = true; stopped = true; };

  while (directories.length && !stopped) {
    const directory = directories.pop()!;
    try {
      const directoryStat = await lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !withinRoot(await realpath(directory))) continue;
      const handle = await opendir(directory);
      for await (const entry of handle) {
        if (stopped) break;
        entries += 1;
        if (entries > MAX_ENTRIES) { truncate(); break; }
        if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!excluded.has(entry.name.toLowerCase())) directories.push(file);
          continue;
        }
        if (!entry.isFile()) continue;
        const extension = path.extname(entry.name).toLowerCase();
        if (!supported.has(extension)) continue;
        if (result.filesScanned >= MAX_FILES) { truncate(); break; }
        try {
          const initial = await lstat(file);
          if (!initial.isFile() || initial.isSymbolicLink() || !withinRoot(await realpath(file))) continue;
          if (initial.size > MAX_FILE_BYTES) {
            result.truncated = true;
            warnings.add("Oversized source files were skipped.");
            continue;
          }
          if (totalBytes + initial.size > MAX_BYTES) { truncate(); break; }
          // O_NOFOLLOW is unavailable on some Windows Node platforms. lstat,
          // realpath, and handle identity checks are retained on those platforms.
          const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
          const sourceHandle = await open(file, constants.O_RDONLY | noFollow);
          try {
            const before = await sourceHandle.stat();
            if (!before.isFile() || before.dev !== initial.dev || before.ino !== initial.ino || before.size !== initial.size || before.mtimeMs !== initial.mtimeMs || before.ctimeMs !== initial.ctimeMs) {
              warnings.add("Files changed during scanning were skipped.");
              continue;
            }
            // Fixed-size read prevents a concurrently growing file exceeding
            // the allocation/read budget; the second stat detects growth.
            result.filesScanned += 1;
            const buffer = Buffer.alloc(initial.size);
            const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, 0);
            totalBytes += bytesRead;
            const after = await sourceHandle.stat();
            if (bytesRead !== initial.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || !withinRoot(await realpath(file))) {
              warnings.add("Files changed during scanning were skipped.");
              continue;
            }
            if (buffer.subarray(0, bytesRead).includes(0)) continue;
            const source = declarationSource(buffer.subarray(0, bytesRead).toString("utf8"), extension);
            for (const pattern of declarationPatterns(extension)) {
              for (const match of source.matchAll(pattern)) {
                const name = match[1];
                if (!name || name.length > 128) continue;
                symbols.add(name);
                if (symbols.size >= MAX_SYMBOLS) { truncate(); break; }
              }
              if (stopped) break;
            }
          } finally {
            await sourceHandle.close();
          }
        } catch {
          warnings.add("Some source files could not be read safely and were skipped.");
        }
      }
    } catch {
      warnings.add("Some project directories could not be read safely and were skipped.");
    }
  }
  if (result.truncated) warnings.add("Extraction was limited by the source-file, entry, byte, or symbol budget.");
  result.symbols = [...symbols].sort();
  result.warnings = [...warnings];
  return result;
}
