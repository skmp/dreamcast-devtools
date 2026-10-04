import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import pkg from './package.json';

// package.json version, plus `git describe` when building from a git checkout,
// e.g. "3.0.0-pre+6ef95de-dirty". Without git (tarball, Docker) it is the
// package.json version alone.
function resolveVersion(): string {
  try {
    const describe = execSync('git describe --tags --always --dirty', { stdio: 'pipe' }).toString().trim();
    return describe ? `${pkg.version}+${describe}` : pkg.version;
  } catch {
    return pkg.version;
  }
}

const appVersion = resolveVersion();
const useBroadcast = process.env.VITE_USE_BROADCAST === 'true';

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __USE_BROADCAST__: JSON.stringify(useBroadcast),
  },
});
