import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import path from 'node:path';

const projectRoot = process.cwd();
process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING ??= 'true';

const config = {
  packagerConfig: {
    asar: true,
    download: {
      cacheRoot: path.join(projectRoot, '.electron-cache'),
      mirrorOptions: {
        mirror: 'https://npmmirror.com/mirrors/electron/',
      },
    },
  },
  rebuildConfig: {},
  makers: [new MakerZIP({}, ['darwin', 'linux', 'win32'])],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
        },
        {
          entry: 'src/agent/worker.ts',
          config: 'vite.agent.config.ts',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
  ],
};

export default config;
