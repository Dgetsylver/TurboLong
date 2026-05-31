import type { Preview } from "@storybook/html";
import "../src/style.css";

const preview: Preview = {
  parameters: {
    backgrounds: {
      default: "dark",
      values: [
        { name: "dark", value: "#0d1117" },
        { name: "light", value: "#f6f8fa" },
      ],
    },
    layout: "centered",
  },
  globalTypes: {
    theme: {
      description: "UI theme",
      defaultValue: "dark",
      toolbar: {
        title: "Theme",
        icon: "paintbrush",
        items: ["dark", "light"],
        dynamicTitle: true,
      },
    },
  },
  decorators: [
    (story, context) => {
      const theme = context.globals.theme ?? "dark";
      document.documentElement.setAttribute("data-theme", theme);
      return story();
    },
  ],
};

export default preview;
