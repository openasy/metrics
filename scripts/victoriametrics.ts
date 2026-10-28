// Fetches the pinned VictoriaMetrics release into vendor/ and checks it against the checksum kept here (ADR 0027,
// 0063). Tests run against it, and the image is built with the same script, so they use the same binary.
//
//   node scripts/victoriametrics.ts                 # this machine, into vendor/victoria-metrics
//   node scripts/victoriametrics.ts linux arm64 out  # another platform, into out/victoria-metrics
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const VERSION = "v1.154.1";
/** sha256 of each release archive, from victoria-metrics-<platform>-<version>_checksums.txt. Change with VERSION. */
const SHA256: Record<string, string> = {
  "linux-amd64": "8c40aec9f77be3a85fbe4b491238b80936af50497fef980b9434095d5076e424",
  "linux-arm64": "9bbc27a62e7f16fbe4bf995c5c4975fcbdd5e856e302e9ec833eb963ce097d11",
  "darwin-arm64": "8a85bb726bc73a3377c3a1b7141ae6a81477d58ee4b6eaa0f62ba85d1fabc34e",
};

const ARCH: Record<string, string> = { x64: "amd64", arm64: "arm64" };
const [os = process.platform, arch = ARCH[process.arch] ?? process.arch, outDir = new URL("../vendor", import.meta.url).pathname] = process.argv.slice(2);
const platform = `${os}-${arch}`;
const binary = join(outDir, "victoria-metrics");
const stamp = join(outDir, "victoria-metrics.version");

if (existsSync(binary) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === `${VERSION} ${platform}`) process.exit(0);
const sum = SHA256[platform];
if (!sum) {
  console.error(`No pinned checksum for VictoriaMetrics ${VERSION} on ${platform}. Add it to scripts/victoriametrics.ts.`);
  process.exit(1);
}
const name = `victoria-metrics-${platform}-${VERSION}.tar.gz`;
const res = await fetch(`https://github.com/VictoriaMetrics/VictoriaMetrics/releases/download/${VERSION}/${name}`);
if (!res.ok) throw new Error(`${name}: ${res.status}`);
const archive = Buffer.from(await res.arrayBuffer());
const got = createHash("sha256").update(archive).digest("hex");
if (got !== sum) throw new Error(`${name}: sha256 is ${got}, expected ${sum}`);

const dir = mkdtempSync(join(tmpdir(), "victoria-metrics-"));
try {
  writeFileSync(join(dir, name), archive);
  execFileSync("tar", ["-xzf", join(dir, name), "-C", dir]);
  mkdirSync(outDir, { recursive: true });
  copyFileSync(join(dir, "victoria-metrics-prod"), binary);
  chmodSync(binary, 0o755);
  writeFileSync(stamp, `${VERSION} ${platform}\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`VictoriaMetrics ${VERSION} for ${platform} in ${binary}`);
