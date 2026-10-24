import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import pkg from './package.json';
import { bundleInfoPlugin } from './scripts/bundle-info';
import { versionInfo } from './scripts/version';
import { PROTOCOL_VERSION } from './src/lib/protocolVersion';

// The version of this build and its commit, from git at every build (scripts/version.ts): "3.0.0-pre+g<10 digits of
// HEAD>" until a tag v<version> is reachable, then "<version>" on it and "<version>+<N>.g<10 digits>" N commits after
// it, ".dirty" (or "+dirty" on the tag) with changes of tracked files; "3.0.0-pre+nogit" without git. The commit is
// HEAD with "-dirty" by the same rule, "" without git.
const { version: appVersion, gitRev } = versionInfo(fileURLToPath(new URL('.', import.meta.url)), pkg.version);
const useBroadcast = process.env.VITE_USE_BROADCAST === 'true';

// https://vite.dev/config/
export default defineConfig({
  base: './',
  // bundle-info.json: what the emulator's build reads before it embeds dist-native/
  plugins: [react(), bundleInfoPlugin({ version: appVersion, protocol: PROTOCOL_VERSION, gitRev })],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __USE_BROADCAST__: JSON.stringify(useBroadcast),
  },
  build: {
    // The one big chunk is Monaco (about 3 MB), which is bundled on purpose (the UI must not
    // load anything from another origin) and only fetched by the pages that show an editor.
    // The size of the initial load is checked by e2e/offline.spec.ts instead.
    chunkSizeWarningLimit: 3200,
  },
});
