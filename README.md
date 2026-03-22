# Obsidian → Notion 

Sync your local Obsidian Markdown vault to Notion. Handles attachments with Notion’s native File Upload API and supports either nested pages (mirroring folders) or databases.

## Features

- **Structure modes**: `pages` (nested pages) or `databases`
- **Native file uploads**: Uses Notion `/v1/file_uploads` 2‑step API
- **Robust content handling**: Normalizes blocks to satisfy Notion validation
- **Retries/backoff**: Automatically retries conflicts and transient errors

## Requirements

- Node.js 18+ (20+ recommended)
- A Notion internal integration with access to your target parent page
- Your Obsidian vault path on disk

## Getting Started


1) Clone the repository
   
```bash
git clone <repo-url>
cd into repo
```


2) Install dependencies

```bash
npm install
```

3) Configure environment from a file

Copy `env.example` to `.env` and fill in the values:

```bash
cp env.example .env   # Windows: copy env.example .env
```

Edit `.env` in your editor: 

-Go to www.notion.so/my-integrations then add a new integration and name it then copy the value into your NOTION_KEY

-The parent page is going to be page where the Obsidian Vault is going to be sync into in Notion. You need to give its ID(Only the first 23 numbers) and then share the page as an integration (click Share then
Click Invite and select your integration)


```
NOTION_KEY=ntn_************************
NOTION_PARENT_PAGE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_CLEANUP_PARENT_PAGE_ID=                     # optional
NOTION_VERSION=2022-06-28                          # optional
DEBUG_UPLOADS=0                                    # optional (set 1 to enable)
```

4) Configure `config.js`

```js
module.exports = {
  // Path to your Obsidian vault
  markdownBaseDir: 'xxx/xxx/xx',

  // Attachment folders to search (in order); also supports relative links from each .md
  attachmentsDir: 'Attachments',
  attachmentsDirs: ['Attachments', 'Images', 'images', 'assets', 'Pasted Images', 'Pasted images'],

  // Upload mode: 'notion' to upload attachments natively, or 'skip' to disable
  imageUpload: 'notion',

  // Choose how notes are organized in Notion
  structureMode: 'pages', // or 'databases'

  // Create new page and archive old one when source changes
  updateExisting: true,

  // Concurrency & watch
  concurrencyLimit: 3,
  watchMode: 'off',        // 'on' to watch for changes
  watchDebounceMs: 1000,

  // For databases mode, the database name used at the vault root
  rootDatabaseName: 'Root',
};
```

## Usage

Run a one‑time sync:

```bash
npm start
```

Enable watch mode (either set in `config.js` or via command):

```bash
npm run watch
```

Cleanup helper (optional):

```bash
# Set NOTION_CLEANUP_PARENT_PAGE_ID first
npm run cleanup
```

The cleanup tool will:
- Find databases under the specified parent page
- Identify obvious duplicate titles (e.g., “Title 1”, “Title 2”) and let you archive duplicates interactively
- Normalize dates embedded in titles like `51025` → `5-10-25` using the page’s Created Date when possible

## How It Works (High‑Level)

1. Finds all `.md` files under `markdownBaseDir`
2. Converts Markdown to Notion blocks via `@tryfabric/martian`
3. Scans for local attachments and uploads them using Notion’s 2‑step file upload API
4. Replaces in‑text attachments with Notion image/file blocks
5. Creates either nested pages or database entries depending on `structureMode`
6. Retries conflicts/rate limits with exponential backoff

## Troubleshooting

- **Integration has no access**: Share the target parent page with your Notion integration (it must have permission to create children).
- **20MB upload limit**: Files larger than ~20MB are skipped. You can set an optional `maxUploadBytes` in your `config.js` if you wish to lower the threshold.
- **Missing attachments**: The tool resolves relative paths, then searches the folders in `attachmentsDirs`, and finally does a vault‑wide basename search.
- **409 Conflict errors**: These are retried with backoff automatically. With `updateExisting: true`, new pages are created and old ones archived to avoid complex diffs.
- **Node/undici errors**: Ensure Node 18+ (the upload flow uses modern `fetch`, `FormData`, and `File`).

## Scripts

- `npm start` – Sync once
- `npm run watch` – Watch mode (optional)
- `npm run cleanup` – Cleanup helper for Notion pages
- `npm run reset` – Archive all pages under the parent page (full wipe before re-sync)

## Notes

- You can override the Notion API version with `NOTION_VERSION` (defaults to `2022-06-28`).
- Attachments are uploaded natively to Notion; no external storage is used.

## Changelog

### 2026-03-23
- **Fix**: Nested block children now placed inside the typed property (e.g. `numbered_list_item.children`) to satisfy Notion API validation — previously caused sync failures for files with nested lists
- **Fix**: Divider blocks (`---`) now include the required empty `divider: {}` property
- **New**: `npm run reset` command — archives all pages under the parent page for a clean full re-sync

## License

MIT
