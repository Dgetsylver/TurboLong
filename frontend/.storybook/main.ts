import type { StorybookConfig } from "@storybook/html-vite";

const config: StorybookConfig = {
  stories: ["../src/stories/**/*.stories.@(ts|js)"],
  addons: [
    "@storybook/addon-essentials",
    "@storybook/addon-a11y",
  ],
  framework: {
    name: "@storybook/html-vite",
    options: {},
  },
  docs: {
    autodocs: "tag",
  },
};

export default config;
