# bernat-tech

[![Build and deploy](https://github.com/gaborbernat/bernat-tech/actions/workflows/build.yaml/badge.svg)](https://github.com/gaborbernat/bernat-tech/actions/workflows/build.yaml)

This hosts my blog https://www.bernat.tech/

## Local Development

### Prerequisites

- [Hugo Extended](https://gohugo.io/installation/) v0.141.0 or later
- Git

### Setup

```bash
git clone --recursive https://github.com/gaborbernat/bernat-tech.git
cd bernat-tech
```

If you already cloned without `--recursive`:

```bash
git submodule update --init --recursive
```

### Running Locally

Start the Hugo development server:

```bash
hugo server -D
```

The site will be available at http://localhost:1313/

### Pre-commit Hooks

Install pre-commit hooks to ensure code quality:

```bash
pip install pre-commit
pre-commit install
```

Run hooks manually:

```bash
pre-commit run --all-files
```

## Creating Content

### New Blog Post

```bash
hugo new posts/my-post-title/index.md
```

This creates a new post in `content/posts/my-post-title/index.md` with frontmatter template.

### Post Frontmatter

```yaml
+++ author = "Bernat Gabor" title = "Your Post Title" description = "Brief description"
tags = ["python", "packaging"] draft = false slug = "your-post-slug" date = 2026-02-12T00:00:00Z
+++
...
```

### Adding Images

Place images in the same directory as your post's `index.md`:

```
content/posts/my-post/
├── index.md
├── image1.png
└── image2.jpg
```

Reference in markdown:

```markdown
![Alt text](image1.png)
```

## Theme

This site uses the [Congo](https://github.com/jpanther/congo) theme, managed as a git submodule.

### Updating the Theme

```bash
git submodule update --remote themes/congo
```

## Deployment

The site automatically deploys to GitHub Pages when changes are pushed to the `main` branch.

### Deployment Process

1. GitHub Actions builds the site using Hugo
2. HTML validation and link checking run
3. If all checks pass, the site deploys to `gh-pages` branch
4. GitHub Pages serves the site at https://bernat.tech/

### Automated Hugo Updates

A scheduled workflow runs weekly to check for new Hugo releases. When a new version is available, it automatically
creates a PR with the update.

### Manual Deployment

```bash
hugo --minify
```

The built site will be in the `public/` directory.

## Configuration

Site configuration is in `config.toml`. Key settings:

- **baseURL**: Site URL
- **theme**: Hugo theme name
- **params**: Site metadata, social links, SEO settings
- **markup**: Syntax highlighting and markdown rendering

## Project Structure

```
.
├── assets/          # Custom CSS
├── content/         # Blog posts and pages
│   ├── about.md
│   ├── posts/       # Blog posts (organized by directory)
│   └── presentations.md
├── layouts/         # Custom Hugo layouts
├── static/          # Static files (images, robots.txt, etc.)
├── themes/          # Hugo theme (git submodule)
└── config.toml      # Site configuration
```

## Contributing

This is a personal blog, but if you find issues or have suggestions, feel free to open an issue or PR.

## License

Content is © Bernát Gábor. Code is available under the MIT License.
