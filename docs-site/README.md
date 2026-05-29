# TurboLong Documentation Site

Documentation site for TurboLong, a leveraged trading platform on Stellar.

## Quick Start

### Prerequisites

- Node.js 18+
- npm 9+

### Installation

```bash
npm install
```

### Development

```bash
npm run start
```

Opens http://localhost:3000 in your browser.

### Build

```bash
npm run build
```

Generates static files in `build/` directory.

### Deploy

```bash
# Manual deployment to Cloudflare Pages
wrangler pages deploy build/

# Automatic via GitHub Actions on push to main
# (See .github/workflows/deploy-docs.yml)
```

## Project Structure

```
docs-site/
├── docs/                    # Main documentation
│   ├── index.md             # Home/Getting Started
│   ├── guides/              # User guides
│   ├── architecture/        # Technical documentation
│   ├── analysis/            # Research and analysis
│   └── contributing/        # Contributor guidelines
├── security/                # Security documentation
│   ├── index.md
│   ├── vulnerability-reports.md
│   └── bug-bounty.md
├── docusaurus.config.js     # Docusaurus configuration
├── sidebars.ts              # Sidebar navigation
├── sidebarsSecurity.ts      # Security sidebar
├── package.json
└── tsconfig.json
```

## Documentation Format

All documentation is written in Markdown with Docusaurus-specific features:

### Front matter

```markdown
---
sidebar_position: 1
---

# Page Title

Content here...
```

### Admonitions

```markdown
:::info
This is an information callout
:::

:::warning
This is a warning
:::

:::danger
This is a danger message
:::
```

### Code blocks

```typescript
// Language-specific syntax highlighting
function example() {
  return true;
}
```

### Links

Internal links use relative paths:

```markdown
[Link text](../path/to/page.md)
```

## Deployment

### GitHub Pages

Docs are automatically deployed to GitHub Pages on every push to `main`:

1. GitHub Actions workflow triggers (`deploy-docs.yml`)
2. Docusaurus builds the static site
3. Files are pushed to `gh-pages` branch
4. GitHub Pages serves the site

### Custom Domain

To use a custom domain (docs.turbolong.xyz):

1. Add a `CNAME` file to the `static/` directory:

   ```
   docs.turbolong.xyz
   ```

2. Configure DNS to point to GitHub Pages:
   - Add CNAME record: `docs.turbolong.xyz` → `turbolong.github.io`
   - Or use A records: `docs.turbolong.xyz` → `185.199.108.153` etc.

3. Enable "Enforce HTTPS" in GitHub Pages settings

### Cloudflare Pages

Alternatively, deploy to Cloudflare Pages:

```bash
wrangler pages deploy build/
```

**Configure in Cloudflare dashboard:**

- Build command: `npm run build`
- Build output directory: `build/`
- Root directory: `.`

## Content Guidelines

### Writing Style

- Clear, concise language
- Active voice preferred
- Examples for complex concepts
- Links to related pages

### Code Examples

- Use syntax highlighting with language tags
- Provide context (framework, library version)
- Comment non-obvious logic

### Security & Compliance

- No hardcoded secrets
- No personal information
- Verify external links
- Use `https://` only

## Contributing

See [Contributing Guide](../CONTRIBUTING.md) for:

- Branch naming conventions
- Commit message style
- Pull request process

## Maintenance

### Dependencies

Keep Docusaurus and dependencies up to date:

```bash
npm outdated          # Check for updates
npm update            # Install updates
npm audit             # Check for security issues
```

### Search

Docusaurus uses Algolia DocSearch by default. Configure in `docusaurus.config.js`:

```js
algolia: {
  appId: 'YOUR_ALGOLIA_APP_ID',
  apiKey: 'YOUR_ALGOLIA_SEARCH_API_KEY',
  indexName: 'turbolong',
}
```

To set up DocSearch, visit [algolia.com/docsearch](https://docsearch.algolia.com/)

## Troubleshooting

### Build fails

```bash
# Clear cache and rebuild
npm run clear
npm run build
```

### Links are broken

- Use relative paths for internal links
- Check file extensions (.md vs. /index.md)
- Verify sidebars.ts includes all pages

### Styling issues

- CSS is in `src/css/custom.css`
- Docusaurus uses Infima CSS framework
- See [Docusaurus styling docs](https://docusaurus.io/docs/styling-layout)

## Resources

- [Docusaurus Documentation](https://docusaurus.io)
- [Markdown Syntax](https://docusaurus.io/docs/markdown-features)
- [GitHub Pages Deployment](https://docusaurus.io/docs/deployment#deploying-to-github-pages)

## License

Documentation is licensed under Creative Commons Attribution 4.0 International (CC-BY-4.0).

Code examples are licensed under MIT License.
