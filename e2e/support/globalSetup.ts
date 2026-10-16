import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DIST_DIR, REPO_ROOT } from "./paths";

// Everything that ends up in the bundle. A change to any of these after the last
// build means the suite would otherwise test a stale dist-native/.
const BUILD_INPUTS = ["src", "public", "index.html", "vite.config.ts", "scripts/bundle-info.ts", "package.json"];

const newestMtime = (path: string): number => {
  const stat = statSync(path);
  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }
  let newest = 0;
  for (const entry of readdirSync(path)) {
    newest = Math.max(newest, newestMtime(join(path, entry)));
  }
  return newest;
};

const buildReason = (): string | undefined => {
  const indexHtml = resolve(DIST_DIR, "index.html");
  if (!existsSync(indexHtml)) {
    return "dist-native/index.html is missing";
  }
  if (!existsSync(resolve(DIST_DIR, "bundle-info.json"))) {
    return "dist-native/bundle-info.json is missing";
  }
  const builtAt = statSync(indexHtml).mtimeMs;
  for (const input of BUILD_INPUTS) {
    const path = resolve(REPO_ROOT, input);
    if (existsSync(path) && newestMtime(path) > builtAt) {
      return `${input} is newer than dist-native/`;
    }
  }
  return undefined;
};

export default function globalSetup() {
  const reason = buildReason();
  if (!reason) {
    return;
  }
  console.log(`[e2e] building dist-native: ${reason}`);
  execSync("npm run build:native", { cwd: REPO_ROOT, stdio: "inherit" });
}
