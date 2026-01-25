# Release Checklist

This document outlines the process for releasing a new version of claude-watch.

## Package Name

The package is published to npm under the scoped name:

```
@ringzero/claude-watch
```

## Semantic Versioning

We follow [Semantic Versioning](https://semver.org/) (semver):

```
MAJOR.MINOR.PATCH
```

### When to Increment

| Change Type | Version Bump | Examples |
|-------------|--------------|----------|
| **MAJOR** | Breaking changes | Removing features, changing CLI flags, database schema changes requiring migration, hook format changes |
| **MINOR** | New features (backward compatible) | New commands, new display options, new hook events |
| **PATCH** | Bug fixes, docs, refactoring | Fixing display issues, updating docs, performance improvements |

### Pre-1.0 Convention

While in pre-1.0 development (0.x.y):
- MINOR bumps may include breaking changes
- PATCH bumps are for bug fixes and small features

## Pre-Release Checklist

### 1. Ensure Clean Working Directory

```bash
git status
# Should show: nothing to commit, working tree clean
```

### 2. Pull Latest Changes

```bash
git pull origin main
```

### 3. Run Tests

```bash
npm test
```

All tests must pass.

### 4. Run Linter

```bash
npm run lint
```

Fix any linting errors.

### 5. Build

```bash
npm run build
```

Ensure build completes without errors.

### 6. Test Locally

```bash
# Test the CLI locally
node dist/cli.js --help
node dist/cli.js --setup
```

### 7. Update CHANGELOG (if exists)

Document notable changes for this release.

## Release Process

### 1. Bump Version

Update the version in `package.json` and `src/cli.ts`:

```bash
# For a patch release (0.1.0 -> 0.1.1)
npm version patch

# For a minor release (0.1.0 -> 0.2.0)
npm version minor

# For a major release (0.1.0 -> 1.0.0)
npm version major
```

This automatically:
- Updates `package.json`
- Creates a git commit
- Creates a git tag

**Note:** Also update the `version` constant in `src/cli.ts` to match.

### 2. Push to GitHub

```bash
git push origin main --tags
```

### 3. Publish to npm

```bash
# First time: Login to npm
npm login

# Publish (scoped packages are private by default, use --access public)
npm publish --access public
```

## First-Time npm Setup

### Create the @ringzero Organization

1. Go to [npmjs.com](https://www.npmjs.com/)
2. Sign in or create an account
3. Go to your account settings
4. Click "Add Organization"
5. Create organization named `ringzero`

### Update package.json

Ensure `package.json` has the scoped name:

```json
{
  "name": "@ringzero/claude-watch",
  "version": "0.1.0",
  "publishConfig": {
    "access": "public"
  }
}
```

### Link npm to Your Organization

```bash
npm login
# Enter your npm credentials
```

## Post-Release Checklist

### 1. Verify npm Publication

```bash
npm view @ringzero/claude-watch
```

### 2. Test Installation

```bash
# In a clean directory
npm install -g @ringzero/claude-watch
claude-watch --version
claude-watch --help
```

### 3. Create GitHub Release (Optional)

1. Go to GitHub releases page
2. Click "Create a new release"
3. Select the version tag
4. Add release notes
5. Publish

## Quick Release Commands

For a typical patch release:

```bash
# 1. Ensure everything is clean and tested
git status
npm test
npm run build

# 2. Bump version (updates package.json, commits, tags)
npm version patch

# 3. Update src/cli.ts version manually if needed, amend commit
# vim src/cli.ts
# git add src/cli.ts && git commit --amend --no-edit

# 4. Push
git push origin main --tags

# 5. Publish
npm publish --access public
```

## Troubleshooting

### "You must be logged in to publish packages"

```bash
npm login
```

### "Package name too similar to existing package"

The scoped name `@ringzero/claude-watch` should avoid this issue.

### "You do not have permission to publish"

Ensure you're a member of the @ringzero organization with publish rights.

### "This package requires a paid subscription"

Add `"publishConfig": { "access": "public" }` to package.json, or use `--access public` flag.

## Version Sync

Keep these files in sync:
- `package.json` - `version` field
- `src/cli.ts` - `version` constant

Consider automating this with a pre-commit hook or build script.
