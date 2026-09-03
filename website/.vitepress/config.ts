import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  title: 'DAI Protocol',
  description:
    "An app that's just a file, with its database inside. Sealed, offline, and yours to send.",
  head: [
    ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#3b82f6' }]
  ],
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
