import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The commit this build came from.
 *
 * Vercel sets it; falls back to git for a local build. Written to
 * /version.json at the end of the build so anybody can ask a deployment what
 * it is running instead of grepping its bundles for a string they hope changed
 * — which is how an evening went, once.
 */
function commit(): string {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA;
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  title: 'DAI Protocol',
  description:
    "An app that's just a file, with its database inside. Sealed, offline, and yours to send.",
  head: [
    ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#3b82f6' }]
  ],
  buildEnd(config) {
    writeFileSync(
      path.join(config.outDir, 'version.json'),
      JSON.stringify(
        {
          commit: commit(),
          builtAt: new Date().toISOString(),
          // Vercel says which kind of deployment this is, so a preview that
          // never reached production can be told apart from production.
          environment: process.env.VERCEL_ENV ?? 'local',
        },
        null,
        2,
      ) + '\n',
    );
  },

  vite: {
    resolve: {
      alias: {
        fflate: path.resolve(__dirname, '../node_modules/fflate')
      }
    },
    server: {
      port: 5176
    }
  },
  themeConfig: {
    logo: '/favicon.svg',
    siteTitle: 'DAI Protocol',
    nav: [
      { text: 'Make one', link: '/make-one' },
      { text: 'Desktop app', link: '/desktop' },
      // The runner is the only way into a container on a phone, so it belongs
      // in the nav rather than a paragraph somebody has to reach.
      { text: 'On a phone', link: 'https://run.dynamicapplicationinterface.io' },
      { text: 'Security', link: '/tamper-proof' },
      {
        text: 'Documentation',
        items: [
          { text: 'Making files', link: '/docs/making-files' },
          { text: 'Desktop app', link: '/desktop' },
          { text: 'The recipe (for AI)', link: '/docs/the-recipe' },
          { text: 'Quickstart', link: '/docs/quickstart' },
          { text: 'Specification', link: '/docs/specification' },
          { text: 'Host bridge', link: '/docs/host-bridge' },
          { text: 'Security model', link: '/docs/security' },
          { text: 'Playground', link: '/playground' },
        ],
      },
    ],

    sidebar: [
      {
        text: 'Overview',
        items: [
          { text: 'Introduction', link: '/docs/introduction' },
          { text: '5-Minute Quickstart', link: '/docs/quickstart' },
          { text: 'Making Files', link: '/docs/making-files' },
          { text: 'The Recipe (for AI)', link: '/docs/the-recipe' },
          { text: 'Architecture & Boundaries', link: '/docs/architecture' }
        ]
      },
      {
        text: 'Protocol Specification',
        items: [
          { text: 'Core Specification', link: '/docs/specification' },
          { text: 'Host Bridge Protocol', link: '/docs/host-bridge' },
          { text: 'Security & Threat Model', link: '/docs/security' }
        ]
      },
      {
        text: 'Interactive Tools',
        items: [
          { text: 'Make One With AI', link: '/make-one' },
          { text: 'Make Your Own', link: '/make-your-own' },
          { text: 'In-Browser Playground', link: '/playground' },
          { text: 'See It Break', link: '/tamper-proof' }
        ]
      }
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/dynamicapplicationinterface/dai-core' }
    ],
    footer: {
      message: 'Released under the MIT License. Dynamic Application Interface standard.',
      copyright: 'Copyright © 2026 Dynamic Application Interface'
    },
    search: {
      provider: 'local'
    }
  }
});
