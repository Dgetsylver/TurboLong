// @ts-check
// `@type` JSDoc annotations allow better IDE support and type checking
// @type {import('@docusaurus/types').Config}
const config = {
  title: "TurboLong",
  tagline: "Leveraged Trading on Stellar via Blend Protocol",
  favicon: "img/favicon.ico",
  url: "https://docs.turbolong.xyz",
  baseUrl: "/",
  organizationName: "turbolong",
  projectName: "turbolong-docs",
  deploymentBranch: "gh-pages",
  onBrokenLinks: "warn",
  onBrokenMarkdownLinks: "warn",
  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },
  markdown: {
    mermaid: true,
  },
  themes: ["@docusaurus/theme-mermaid"],
  presets: [
    [
      "@docusaurus/preset-classic",
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: "./sidebars.ts",
          editUrl: "https://github.com/turbolong/turbolong-docs/tree/main",
          versions: {
            current: {
              label: "v1.0 (Current)",
              path: "v1.0",
            },
          },
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
        sitemap: {
          changefreq: "weekly",
          priority: 0.5,
        },
      }),
    ],
  ],
  plugins: [
    [
      "@docusaurus/plugin-content-docs",
      {
        id: "security",
        path: "security",
        routeBasePath: "security",
        sidebarPath: require.resolve("./sidebarsSecurity.ts"),
      },
    ],
  ],
  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      image: "img/social-card.jpg",
      navbar: {
        title: "TurboLong",
        logo: {
          alt: "TurboLong Logo",
          src: "img/logo.svg",
        },
        items: [
          {
            type: "docSidebar",
            sidebarId: "docsSidebar",
            position: "left",
            label: "Docs",
          },
          {
            type: "docSidebar",
            docsPluginId: "security",
            sidebarId: "securitySidebar",
            position: "left",
            label: "Security",
          },
          {
            href: "https://github.com/turbolong/turbolong",
            label: "GitHub",
            position: "right",
          },
        ],
      },
      footer: {
        style: "dark",
        links: [
          {
            title: "Docs",
            items: [
              {
                label: "Getting Started",
                to: "/docs/guides/getting-started",
              },
              {
                label: "Architecture",
                to: "/docs/architecture/overview",
              },
            ],
          },
          {
            title: "Community",
            items: [
              {
                label: "Discord",
                href: "https://discord.gg/turbolong",
              },
              {
                label: "Twitter",
                href: "https://twitter.com/turbolong",
              },
            ],
          },
          {
            title: "More",
            items: [
              {
                label: "GitHub",
                href: "https://github.com/turbolong/turbolong",
              },
              {
                label: "Security",
                to: "/security/vulnerability-reports",
              },
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} TurboLong. Built with Docusaurus.`,
      },
      prism: {
        theme: require("prism-react-renderer/themes/github"),
        darkTheme: require("prism-react-renderer/themes/dracula"),
        additionalLanguages: ["rust", "typescript", "toml"],
      },
      algolia: {
        appId: "YOUR_ALGOLIA_APP_ID",
        apiKey: "YOUR_ALGOLIA_SEARCH_API_KEY",
        indexName: "turbolong",
      },
    }),
};

module.exports = config;
