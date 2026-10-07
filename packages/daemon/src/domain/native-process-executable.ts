import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// macOS has no /proc/<pid>/exe. JXA's built-in C bridge calls the same
// proc_pidpath API without a compiler, Python installation or native addon.
// One invocation covers the sample; argv contains numeric PIDs only.
const MAC_PROCESS_PATHS = `ObjC.import("Foundation");
ObjC.bindFunction("proc_pidpath", ["int", ["int", "void *", "uint32_t"]]);
function run(argv) {
  return JSON.stringify(argv.map(function(value) {
    var pid = Number(value);
    var buffer = $.NSMutableData.dataWithLength(4096);
    var size = $.proc_pidpath(pid, buffer.mutableBytes, 4096);
    return [pid, size > 0 ? ObjC.unwrap($.NSString.alloc.initWithDataEncoding(buffer, $.NSUTF8StringEncoding)).split("\\u0000")[0] : null];
  }));
}`;

/** Optional OS executable witnesses. Unavailable, exited and over-budget PIDs
 * have no witness; this never substitutes argv or a version string for a path. */
export async function readNativeExecutablePaths(requested: number[]): Promise<Map<number, string>> {
  const pids = [...new Set(requested.filter(pid => Number.isInteger(pid) && pid > 0 && pid <= 2147483647))].slice(0, 1024);
  const result = new Map<number, string>();
  if (pids.length === 0) return result;
  let entries: unknown;
  try {
    if (process.platform === "linux") {
      entries = await Promise.all(pids.map(async pid => [pid, await readlink(`/proc/${pid}/exe`).catch(() => null)]));
    } else if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_PROCESS_PATHS, ...pids.map(String)], {
        encoding: "utf-8", timeout: 2000, maxBuffer: 1024 * 1024,
      });
      entries = JSON.parse(stdout);
    } else return result;
    if (!Array.isArray(entries)) return result;
    const requestedPids = new Set(pids);
    const missingPaths = new Set<number>();
    for (const entry of entries) {
      if (!Array.isArray(entry) || !requestedPids.has(entry[0])) continue;
      const path = entry[1];
      if (path === null) missingPaths.add(entry[0]);
      if (typeof path === "string" && path.startsWith("/") && !path.includes("\0")
        && !path.split("/").some(part => part === "." || part === "..")) result.set(entry[0], path);
    }
    const missing = [...missingPaths].filter(pid => !result.has(pid));
    if (process.platform === "darwin" && missing.length > 0) {
      // An updater can unlink a still-running versioned binary: proc_pidpath
      // returns no path, while its executable text mapping remains observable.
      // Preserve the installed collector's leading/unique native-mapping rule;
      // never replace an observed primary path or infer identity from a label.
      const { stdout } = await execFileAsync("/usr/sbin/lsof", ["-a", "-p", missing.join(","), "-d", "txt", "-Fpn"], {
        encoding: "utf-8", timeout: 2000, maxBuffer: 1024 * 1024,
      });
      const mapped = new Map<number, string[]>();
      const wanted = new Set(missing);
      let pid: number | null = null;
      for (const line of stdout.split("\n")) {
        if (/^p\d+$/.test(line)) {
          pid = wanted.has(Number(line.slice(1))) ? Number(line.slice(1)) : null;
          if (pid !== null && !mapped.has(pid)) mapped.set(pid, []);
        } else if (pid !== null && line.startsWith("n")) mapped.get(pid)!.push(line.slice(1));
      }
      for (const [pid, paths] of mapped) {
        const native = [...new Set(paths.filter(path => path.startsWith("/") && !path.includes("\0")
          && !path.split("/").some(part => part === "." || part === "..")
          && /\/\.local\/share\/claude\/versions\/\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(path)))];
        if (native.length === 1 && paths[0] === native[0]) result.set(pid, native[0]!);
      }
    }
  } catch { /* A missing OS witness is unknown, not positive identity. */ }
  return result;
}
