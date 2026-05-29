import type { SidebarsConfig } from "@docusaurus/docs-plugin-content-docs";

const sidebarsSecurity: SidebarsConfig = {
  securitySidebar: [
    {
      type: "doc",
      id: "index",
      label: "Security Overview",
    },
    "vulnerability-reports",
    "bug-bounty",
  ],
};

export default sidebarsSecurity;
