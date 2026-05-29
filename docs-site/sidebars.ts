import type { SidebarsConfig } from "@docusaurus/docs-plugin-content-docs";

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {
      type: "doc",
      id: "index",
      label: "Getting Started",
    },
    {
      type: "category",
      label: "Guides",
      items: ["guides/getting-started", "guides/user-guide"],
    },
    {
      type: "category",
      label: "Architecture",
      items: [
        "architecture/overview",
        "architecture/blend-protocol",
        "architecture/leverage-mechanism",
        "architecture/contracts",
        "architecture/frontend",
      ],
    },
    {
      type: "category",
      label: "Analysis",
      items: [
        "analysis/profitability",
        "analysis/ux-audit",
        "analysis/research",
      ],
    },
    {
      type: "category",
      label: "Contributing",
      items: ["contributing/guidelines"],
    },
  ],
};

export default sidebars;
