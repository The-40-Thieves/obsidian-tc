import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  // Served from GitHub Pages at the project subpath. To move to the custom domain
  // obsidian-tc.the40thieves.io: add a Cloudflare CNAME (obsidian-tc -> the-40-thieves.github.io),
  // set it as the Pages custom domain, then set `site` to that domain and drop `base`.
  site: 'https://the-40-thieves.github.io',
  base: '/obsidian-tc/',
  integrations: [
    starlight({
      title: 'obsidian-tc',
      description: 'A turbocharged Model Context Protocol server for Obsidian.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/the-40-thieves/obsidian-tc' },
      ],
      sidebar: [
        { label: 'Getting Started', items: [{ autogenerate: { directory: 'getting-started' } }] },
        { label: 'Tools', items: [{ autogenerate: { directory: 'tools' } }] },
        { label: 'Deployment', items: [{ autogenerate: { directory: 'deployment' } }] },
        { label: 'Security', items: [{ autogenerate: { directory: 'security' } }] },
        { label: 'Observability', items: [{ autogenerate: { directory: 'observability' } }] },
        { label: 'Configuration', items: [{ autogenerate: { directory: 'configuration' } }] },
        { label: 'Contributing', items: [{ autogenerate: { directory: 'contributing' } }] },
        { label: 'Roadmap', link: '/roadmap/' },
        { label: 'V2 Preview', items: [{ autogenerate: { directory: 'v2-preview' } }] },
      ],
      editLink: {
        baseUrl: 'https://github.com/the-40-thieves/obsidian-tc/edit/main/docs/',
      },
      customCss: ['./src/styles/custom.css'],
    }),
  ],
});
