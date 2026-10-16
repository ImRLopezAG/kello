import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import mdx from "@astrojs/mdx";
import tailwindcss from "@tailwindcss/vite";
import { unified } from "@astrojs/markdown-remark";
import { rehypeCode, remarkHeading } from "fumadocs-core/mdx-plugins";

export default defineConfig({
  site: process.env.KELLO_DOCS_SITE_URL ?? process.env.LOOM_DOCS_SITE_URL,
  markdown: {
    processor: unified({ syntaxHighlight: false, remarkPlugins: [remarkHeading], rehypePlugins: [rehypeCode] }),
  },
  integrations: [react(), mdx({ extendMarkdownConfig: true, syntaxHighlight: false })],
  vite: { plugins: [tailwindcss()] },
});
