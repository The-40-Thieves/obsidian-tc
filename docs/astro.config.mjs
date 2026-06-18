import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://obsidian-tc.the40thieves.io',
  integrations: [
    starlight({
      title: 'obsidian-tc',
      description: 'A turbocharged Model Context Protocol server for Obsidian.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/the-40-thieves/obsidian-tc' },
      ],
      sidebar: [
        { label: 'Getting Started', autogenerate: { directory: 'getting-started' } },
        { label: 'Tools', autogenerate: { directory: 'tools' } },
        { label: 'Deployment', autogenerate: { directory: 'deployment' } },
        { label: 'Security', autogenerate: { directory: 'security' } },
        { label: 'Observability', autogenerate: { directory: 'observability' } },
        { label: 'Configuration', autogenerate: { directory: 'configuration' } },
        { label: 'Contributing', autogenerate: { directory: 'contributing' } },
        { label: 'Roadmap', link: '/roadmap/' },
        { label: 'V2 Preview', autogenerate: { directory: 'v2-preview' } },
      ],
      editLink: {
        baseUrl: 'https://github.com/the-40-thieves/obsidian-tc/edit/main/docs/',
      },
      customCss: ['./src/styles/custom.css'],
    }),
  ],
});
