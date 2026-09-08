import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';
import { API, CSS_VARS, RECIPE_AS_PROMPT } from '../../src/recipe.js';

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
    "An app that's just a file. Ask your AI for the app you want, get a file back, open it, use it, send it to anyone.",
  head: [
    ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#3b82f6' }]
  ],
  buildEnd(config) {
    /*
     * The same instructions, as plain text, at a stable address.
     *
     * A model asked to write one of these should not have to scrape a
     * documentation page and guess which parts are the rules. /recipe.txt is
     * what the MCP server hands a model, byte for byte, and /llms.txt is the
     * index that points at it. Written from the shared constants at build
     * time so the published text cannot drift from the taught text — the same
     * reason the recipe page renders rather than restates.
     */
    writeFileSync(
      path.join(config.outDir, 'recipe.txt'),
      RECIPE_AS_PROMPT.endsWith('\n') ? RECIPE_AS_PROMPT : RECIPE_AS_PROMPT + '\n',
    );
    writeFileSync(
      path.join(config.outDir, 'llms.txt'),
      [
        '# DAI Protocol',
        '',
        '> An app that is just a file. A .dai container holds an application, its',
        '> SQLite database and its runtime in one HTML file that opens offline, runs',
        '> in a frame with no origin and no network, and can be sent to anybody.',
        '',
        'Writing an application that runs inside a container:',
        '',
        '- [The recipe](https://www.dynamicapplicationinterface.io/recipe.txt): the full instructions, as given to a model. Start here.',
        '- [Writing apps](https://www.dynamicapplicationinterface.io/docs/writing-apps): the same rules with the reasoning behind them.',
        '',
        'The surface an application is given:',
        '',
        ...API.map((entry) => `- \`${entry.call}\` — ${entry.does}`),
        '',
        'Custom properties a host sets on the application root:',
        '',
        ...CSS_VARS.map((entry) => `- \`${entry.name}\` — ${entry.is}`),
        '',
        '## The format',
        '',
        '- [Specification](https://www.dynamicapplicationinterface.io/docs/specification): the container format.',
        '- [Host bridge](https://www.dynamicapplicationinterface.io/docs/host-bridge): the messages between a host and a container, for building a host.',
        '- [Security model](https://www.dynamicapplicationinterface.io/docs/security): what is isolated, what is signed, and what a signature does not prove.',
        '',
      ].join('\n'),
    );
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
    },
  },
  themeConfig: {
    logo: '/favicon.svg',
    siteTitle: 'DAI Protocol',
    nav: [
      { text: 'Make one', link: '/make-one' },
      { text: 'Desktop app', link: '/desktop' },
      // The opener is the only way into a container on a phone, so it belongs
      // in the nav rather than in a paragraph somebody has to reach. Named for
      // what a person does with it, not for what it technically is.
      { text: 'Open a file', link: 'https://opendai.app' },
      { text: 'Security', link: '/tamper-proof' },
      {
        text: 'Documentation',
        items: [
          { text: 'Making files', link: '/docs/making-files' },
          { text: 'Writing apps', link: '/docs/writing-apps' },
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
          { text: 'Writing Apps', link: '/docs/writing-apps' },
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
