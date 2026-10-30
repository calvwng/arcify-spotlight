import { resolve } from 'path';
import fs from 'fs-extra';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { build } from 'vite';

/**
 * Get shared input configuration for Spotlight Chrome Extension
 */
function getExtensionInputs() {
  return {
    background: resolve(process.cwd(), 'background.js'),
  };
}

/**
 * Get shared output configuration for Spotlight Chrome Extension
 */
function getExtensionOutput(isDev = false) {
  return {
    entryFileNames: (chunkInfo) => {
      if (chunkInfo.name === 'background') {
        return 'background.js';
      }
      return isDev ? '[name].js' : 'assets/[name]-[hash].js';
    },
    chunkFileNames: isDev ? '[name].js' : 'assets/[name]-[hash].js',
    assetFileNames: (assetInfo) => {
      if (assetInfo.name?.endsWith('.css')) {
        return '[name][extname]';
      }
      if (assetInfo.name?.endsWith('.html')) {
        return '[name][extname]';
      }
      return isDev ? '[name][extname]' : 'assets/[name]-[hash][extname]';
    }
  };
}

/**
 * Get Spotlight extension build plugins
 */
function getExtensionPlugins(isDev = false) {
  const outDir = isDev ? 'dist-dev' : 'dist';

  return [
    // Main extension build plugin
    {
      name: 'spotlight-extension-main',
      writeBundle: async () => {
        // Copy static files
        await fs.copy('manifest.json', `${outDir}/manifest.json`);

        // The options page is a standalone module with no bundled dependencies.
        for (const file of ['options.html', 'options.js', 'options.css', 'little-arc-header.html', 'peek-wrapper.html']) {
          await fs.copy(file, `${outDir}/${file}`);
        }

        if (await fs.pathExists('assets')) {
          await fs.copy('assets', `${outDir}/assets`);
        }

        // Copy shared files (excluding files that will be built separately)
        if (await fs.pathExists('shared')) {
          await fs.copy('shared', `${outDir}/shared`, {
            filter: (src) => {
              // Include all shared files
              return true;
            }
          });
        }

        // Copy installation-onboarding files
        if (await fs.pathExists('installation-onboarding.html')) {
          await fs.copy('installation-onboarding.html', `${outDir}/installation-onboarding.html`);
        }
        if (await fs.pathExists('installation-onboarding.css')) {
          await fs.copy('installation-onboarding.css', `${outDir}/installation-onboarding.css`);
        }

        console.log(`✅ Main spotlight files built to ${outDir}/`);
      }
    },

    // Overlay build plugin - runs after main build
    {
      name: 'spotlight-extension-overlay',
      writeBundle: async () => {
        console.log('🔄 Building spotlight overlay...');

        // Build overlay.js as IIFE for content script injection
        for (const entry of ['overlay', 'peek-preview-observer']) await build({
          configFile: false,
          define: {
            '__DEBUG_ENABLED__': JSON.stringify(isDev)
          },
          build: {
            outDir,
            emptyOutDir: false, // Don't clear main build
            rollupOptions: {
              input: {
                [entry]: resolve(process.cwd(), `${entry}.js`),
              },
              output: {
                entryFileNames: `${entry}.js`,
                format: 'iife',
                inlineDynamicImports: true,
              }
            },
            target: 'es2020',
            minify: !isDev,
            sourcemap: isDev
          },
          plugins: [
            viteSingleFile({
              removeViteModuleLoader: true
            })
          ],
          resolve: {
            alias: {
              '@': resolve(process.cwd(), './'),
            }
          }
        });

        console.log(`✅ Spotlight overlay built to ${outDir}/overlay.js`);
      }
    },

    // Newtab build plugin - runs after main build
    {
      name: 'spotlight-extension-newtab',
      writeBundle: async () => {
        console.log('🔄 Building newtab page...');

        // Build newtab.js as ES module with inlined dependencies
        await build({
          configFile: false,
          define: {
            '__DEBUG_ENABLED__': JSON.stringify(isDev)
          },
          build: {
            outDir,
            emptyOutDir: false, // Don't clear main build
            rollupOptions: {
              input: {
                'spotlight-newtab': resolve(process.cwd(), 'newtab.js'),
              },
              output: {
                entryFileNames: 'newtab.js',
                format: 'es',
                inlineDynamicImports: true,
              }
            },
            target: 'es2020',
            minify: !isDev,
            sourcemap: isDev
          },
          plugins: [
            viteSingleFile({
              removeViteModuleLoader: true
            })
          ],
          resolve: {
            alias: {
              '@': resolve(process.cwd(), './'),
            }
          }
        });

        // Copy newtab.html and newtab.css after building newtab.js
        if (await fs.pathExists('newtab.html')) {
          await fs.copy('newtab.html', `${outDir}/newtab.html`);
        }
        if (await fs.pathExists('newtab.css')) {
          await fs.copy('newtab.css', `${outDir}/newtab.css`);
        }

        console.log(`✅ Newtab page built to ${outDir}/newtab.js`);
        console.log(`🎉 Spotlight extension build complete!`);
      }
    },

    // Installation Onboarding build plugin - runs after main build
    {
      name: 'spotlight-extension-onboarding',
      writeBundle: async () => {
        console.log('🔄 Building onboarding page...');

        // Build installation-onboarding.js as ES module
        await build({
          configFile: false,
          build: {
            outDir,
            emptyOutDir: false, // Don't clear main build
            rollupOptions: {
              input: {
                'installation-onboarding': resolve(process.cwd(), 'installation-onboarding.js'),
              },
              output: {
                entryFileNames: 'installation-onboarding.js',
                format: 'es',
                inlineDynamicImports: true,
              }
            },
            target: 'es2020',
            minify: !isDev,
            sourcemap: isDev
          },
          plugins: [
            viteSingleFile({
              removeViteModuleLoader: true
            })
          ],
          resolve: {
            alias: {
              '@': resolve(process.cwd(), './'),
            }
          },
          define: {
            '__IS_DEV__': isDev,
            '__DEBUG_ENABLED__': JSON.stringify(isDev)
          }
        });

        console.log(`✅ Onboarding page built to ${outDir}/installation-onboarding.js`);
      }
    }
  ];
}

/**
 * Create complete Vite configuration for Spotlight Chrome Extension
 * Handles main extension build, overlay IIFE build, and newtab ES module build
 */
export function createSpotlightConfig(options = {}) {
  const { isDev = false } = options;
  const outDir = isDev ? 'dist-dev' : 'dist';

  const config = {
    define: {
      '__DEBUG_ENABLED__': JSON.stringify(isDev)
    },
    build: {
      outDir,
      emptyOutDir: true,
      rollupOptions: {
        input: getExtensionInputs(),
        output: getExtensionOutput(isDev)
      },
      target: 'es2020',
      minify: !isDev,
      sourcemap: isDev
    },
    plugins: getExtensionPlugins(isDev),
    server: {
      port: 3001,
      open: false,
      ...(isDev && { hmr: false })
    },
    resolve: {
      alias: {
        '@': resolve(process.cwd(), './'),
      }
    }
  };

  // Add dev-specific options
  if (isDev) {
    config.mode = 'development';
    config.build.watch = {
      include: ['**/*.js', '**/*.html', '**/*.css', 'manifest.json']
    };
  }

  return config;
}
