import { resolve } from "node:path";

/** Repository root (the directory that holds package.json). */
export const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

/** The production build the suite runs against. */
export const DIST_DIR = resolve(REPO_ROOT, "dist-native");
