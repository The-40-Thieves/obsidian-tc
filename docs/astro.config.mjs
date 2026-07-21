import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  // Served from the custom domain at the root. DNS: Cloudflare CNAME
  // obsidian-tc -> the-40-thieves.github.io (DNS-only / grey cloud). The public/CNAME
  // file below is what keeps the custom domain bound across Actions deploys.
  site: 'https://obsidian-tc.the40thieves.io',
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
