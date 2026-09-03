import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  title: 'DAI Protocol',
  description: 'The open, air-gapped container standard (.dai) for AI-generated software.',
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
      { text: 'Documentation', link: '/docs/introduction' },
      { text: 'Specification', link: '/docs/specification' },
      { text: 'Host Bridge', link: '/docs/host-bridge' },
      { text: 'Playground', link: '/playground' },
      { text: 'See It Break', link: '/tamper-proof' },
      {
        text: 'v0.1',
        items: [
          { text: 'Specification v0.1', link: '/docs/specification' },
          { text: 'GitHub Repository', link: 'https://github.com/dynamicapplicationinterface/dai-core' }
        ]
      }
    ],
    sidebar: [
      {
        text: 'Overview',
        items: [
          { text: 'Introduction', link: '/docs/introduction' },
          { text: '5-Minute Quickstart', link: '/docs/quickstart' },
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
