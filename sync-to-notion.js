require('dotenv').config();
const { markdownToBlocks } = require('@tryfabric/martian');
const fs = require('fs/promises');
const path = require('path');
const { getOrCreateDatabaseForPath, fetchAllExistingPages, notion, callWithRetry, getOrCreatePageForPath, fetchAllExistingPagesPagesMode, uploadFileToNotion } = require('./src/notion');
const { findMarkdownFiles, delay } = require('./src/utils');
// removed unused chokidar stub; watch mode dynamically imports 'chokidar' when needed
const config = require('./config');

/**
 * Resolves the full path of an image, supporting both relative paths and a global attachments folder.
 * @param {string} imagePath - The path from the markdown link.
 * @param {string} markdownFilePath - The path of the markdown file being processed.
 * @returns {Promise<string|null>} The resolved full path to the image, or null if it doesn't exist.
 */
let vaultImageIndex = null; // Map<basenameLower, string[]>
let vaultIndexBuilding = null;

async function buildVaultImageIndex() {
    if (vaultImageIndex) return vaultImageIndex;
    if (vaultIndexBuilding) return vaultIndexBuilding;
    const allowedExt = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.tiff', '.tif']);
    vaultIndexBuilding = (async () => {
        const map = new Map();
        async function walk(dir) {
            try {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                for (const ent of entries) {
                    const full = path.join(dir, ent.name);
                    if (ent.isDirectory()) {
                        if (['.git', 'node_modules', 'notion-backup'].includes(ent.name)) continue;
                        await walk(full);
                    } else {
                        const ext = path.extname(ent.name).toLowerCase();
                        if (!allowedExt.has(ext)) continue;
                        const base = ent.name.toLowerCase();
                        if (!map.has(base)) map.set(base, []);
                        map.get(base).push(full);
                    }
                }
            } catch (e) { }
        }
        await walk(config.markdownBaseDir);
        // Also index the external attachmentsDir if it's outside markdownBaseDir
        if (config.attachmentsDir && !config.attachmentsDir.startsWith(config.markdownBaseDir)) {
            await walk(config.attachmentsDir);
        }
        return map;
    })();
    vaultImageIndex = await vaultIndexBuilding;
    return vaultImageIndex;
}

async function resolveImagePath(imagePath, markdownFilePath) {
    // Strip Obsidian anchors/fragments like #right, #center, etc.
    const pathWithoutFragment = imagePath.split('#')[0];
    const decodedPath = decodeURIComponent(pathWithoutFragment);

    // 1. Try resolving relative to the markdown file's directory
    const relativePath = path.resolve(path.dirname(markdownFilePath), decodedPath);
    try {
        await fs.access(relativePath);
        return relativePath;
    } catch (e) {
        // Not found, proceed to next step
    }

    // 2. Try resolving from any configured global attachments folders (relative names under markdownBaseDir)
    const dirs = Array.isArray(config.attachmentsDirs) && config.attachmentsDirs.length > 0
        ? config.attachmentsDirs
        : [];
    for (const dirName of dirs) {
        // Case A: decodedPath does NOT already start with dirName → join dirName/decodedPath
        if (!decodedPath.startsWith(dirName + '/') && !decodedPath.startsWith(dirName + '\\')) {
            const attachmentPathA = path.join(config.markdownBaseDir, dirName, decodedPath);
            try { await fs.access(attachmentPathA); return attachmentPathA; } catch (e) {}
        }
        // Case B: decodedPath already includes dirName at the start → join base/decodedPath directly
        const attachmentPathB = path.join(config.markdownBaseDir, decodedPath);
        try { await fs.access(attachmentPathB); return attachmentPathB; } catch (e) {}
    }

    // 2b. Try the absolute attachmentsDir path directly (handles dirs outside markdownBaseDir)
    if (config.attachmentsDir) {
        const basename = path.basename(decodedPath);
        const p1 = path.join(config.attachmentsDir, basename);
        try { await fs.access(p1); return p1; } catch (e) {}
        if (basename !== decodedPath) {
            const p2 = path.join(config.attachmentsDir, decodedPath);
            try { await fs.access(p2); return p2; } catch (e) {}
        }
    }

    // 3. Vault-wide basename search
    try {
        const index = await buildVaultImageIndex();
        const base = path.basename(decodedPath).toLowerCase();
        const candidates = index.get(base);
        if (candidates && candidates.length > 0) {
            if (candidates.length > 1) {
                console.warn(`    ⚠️  Multiple matches for ${base}; using first found.`);
            }
            return candidates[0];
        }
    } catch (e) { }

    console.warn(`    ⚠️  Could not find image: ${decodedPath}`);
    return null;
}


/**
 * Processes a single markdown file: uploads images and creates a Notion page.
 * @param {string} filePath - The absolute path to the markdown file.
 * @param {Set<string>} existingPages - A set of keys for pages that already exist in Notion.
 */
function toUnixPath(p) { return p.replace(/\\/g, '/'); }

async function processSingleFile(filePath, existingPages, pagesModeExtra) {
    const pageTitle = path.basename(filePath, '.md');
    const relativePath = path.dirname(path.relative(config.markdownBaseDir, filePath));
    const folderPathUnix = relativePath === '.' ? '' : toUnixPath(relativePath);
    const isPagesMode = (config.structureMode || 'databases') === 'pages';
    const dbTitle = relativePath === '.' ? config.rootDatabaseName : relativePath;
    const pageKey = isPagesMode ? `${folderPathUnix ? folderPathUnix + '/' : ''}${pageTitle}` : `${dbTitle}/${pageTitle}`;

    const shouldUpdate = !!config.updateExisting;
    let existingPageId = null;
    if (existingPages.has(pageKey)) {
        if (!shouldUpdate) {
            console.log(`⏭️  Skipping (already exists): ${pageTitle}`);
            return;
        }
        existingPageId = pagesModeExtra?.leafTitleToIdByPath?.get(pageKey) || null;
    }

    try {
        // Determine parent container (database or page) depending on mode
        let parentInfo;
        if (isPagesMode) {
            parentInfo = { page_id: await getOrCreatePageForPath(folderPathUnix) };
        } else {
            parentInfo = { database_id: await getOrCreateDatabaseForPath(relativePath) };
        }

        console.log(`Processing: ${pageTitle}`);
        let markdownContent = await fs.readFile(filePath, 'utf8');
        
        // Updated regex to match all attachments (images and other files)
        const attachmentRegex = /!\[(.*?)\]\((?!https?:\/\/)(.*?)\)|!\[\[(.*?)(?:\|.*?)?\]\]/g;
        
        const attachmentMatches = [...markdownContent.matchAll(attachmentRegex)];
        let successfulUploadCount = 0;

        if (attachmentMatches.length > 0 && config.imageUpload !== 'skip') {
            console.log(`  Found ${attachmentMatches.length} local attachment(s) in ${pageTitle}`);
            const uploadPromises = attachmentMatches.map(match => {
                return (async () => {
                    const originalLinkText = match[0];
                    let altText = '';
                    let originalAttachmentPath = '';

                    if (match[2] !== undefined) { 
                        altText = match[1];
                        originalAttachmentPath = match[2];
                    } else if (match[3] !== undefined) {
                        originalAttachmentPath = match[3];
                        altText = path.basename(originalAttachmentPath);
                    }

                    if (!originalAttachmentPath) return null;

                    try {
                        const fullAttachmentPath = await resolveImagePath(originalAttachmentPath, filePath);
                        if (fullAttachmentPath) {
                            const fileExtension = path.extname(originalAttachmentPath).toLowerCase();
                            const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.tif', '.tiff'].includes(fileExtension);

                            // Guard for large files
                            try {
                                const stat = await fs.stat(fullAttachmentPath);
                                const maxBytes = (config.maxUploadBytes && Number.isFinite(config.maxUploadBytes)) ? config.maxUploadBytes : 20 * 1024 * 1024;
                                if (stat.size > maxBytes) {
                                    console.warn(`    ⚠️  Skipping ${path.basename(fullAttachmentPath)} (> ${Math.round(maxBytes/1024/1024)}MB).`);
                                    return null;
                                }
                            } catch (e) {}

                            const uploadedId = await uploadFileToNotion(fullAttachmentPath);
                            const encAlt = encodeURIComponent(altText || path.basename(originalAttachmentPath));
                            if (isImage) {
                                return { original: originalLinkText, replacement: `{{NOTION_IMAGE:${uploadedId}:${encAlt}}}` };
                            }
                            const displayName = altText || `${path.basename(originalAttachmentPath)}`;
                            return { original: originalLinkText, replacement: `{{NOTION_FILE:${uploadedId}:${encodeURIComponent(displayName)}}}` };
                        }
                    } catch (e) {
                        console.error(`    ❌ ERROR processing attachment "${originalAttachmentPath}": ${e.message}`);
                    }
                    return null;
                })();
            });

            const uploadResults = await Promise.all(uploadPromises);
            for (const result of uploadResults) {
                if (result) {
                    markdownContent = markdownContent.replace(result.original, result.replacement);
                    successfulUploadCount++;
                }
            }
        }

        let notionBlocks = markdownToBlocks(markdownContent);

        // Normalize blocks to comply with current Notion schema
        const normalizeBlocks = (blocks, depth = 0) => {
            if (depth > 10) return []; // Prevent infinite recursion
            const out = [];
            if (!Array.isArray(blocks)) return out;
            const typesThatAllowChildren = new Set([
                'bulleted_list_item',
                'numbered_list_item',
                'to_do',
                'toggle',
                'callout',
                'quote',
                'synced_block',
                'column_list',
                'column',
                // table handled specially below
            ]);
            for (const blk of blocks) {
                if (!blk || typeof blk !== 'object' || !blk.type) continue;
                const b = { ...blk };
                // Ensure object field is set
                if (!b.object) b.object = 'block';
                // Divider blocks require an empty divider property
                if (b.type === 'divider' && !b.divider) b.divider = {};
                const typed = b[b.type];
                // Flatten list wrapper blocks from converters (bulleted_list/numbered_list)
                if (b.type === 'bulleted_list' || b.type === 'numbered_list') {
                    const inner = (typed && Array.isArray(typed.children)) ? typed.children : [];
                    out.push(...normalizeBlocks(inner, depth + 1));
                    continue;
                }
                // Preserve table children under typed property (schema expects table.children here)
                if (b.type === 'table') {
                    if (typed && Array.isArray(typed.children)) {
                        typed.children = normalizeBlocks(typed.children, depth + 1);
                    }
                    out.push(b);
                    continue;
                }
                // If converter placed children under typed prop
                if (typed && Array.isArray(typed.children)) {
                    const childBlocks = normalizeBlocks(typed.children, depth + 1);
                    if (typesThatAllowChildren.has(b.type)) {
                        typed.children = childBlocks;
                        out.push(b);
                    } else {
                        delete typed.children;
                        out.push(b);
                        out.push(...childBlocks);
                    }
                    continue;
                }
                if (Array.isArray(b.children) && b.children.length) {
                    const childBlocks = normalizeBlocks(b.children, depth + 1);
                    delete b.children;
                    if (!typed || typeof typed !== 'object' || Object.keys(typed).length === 0) {
                        if (typesThatAllowChildren.has(b.type)) {
                            b[b.type] = { rich_text: [], children: childBlocks };
                            out.push(b);
                        } else {
                            out.push(b, ...childBlocks);
                        }
                    } else if (typesThatAllowChildren.has(b.type)) {
                        typed.children = childBlocks;
                        out.push(b);
                    } else {
                        out.push(b, ...childBlocks);
                    }
                } else {
                    out.push(b);
                }
            }
            return out;
        };

        // Inline placeholder replacement
        const replacedBlocks = [];
        const placeholderRegex = /\{\{NOTION_(IMAGE|FILE):([^:}]+):([^}]+)\}\}/;
        for (const block of notionBlocks) {
            if (block.type === 'paragraph' && Array.isArray(block.paragraph?.rich_text)) {
                const textContent = (block.paragraph.rich_text || []).map(t => t.plain_text || t.text?.content || '').join('');
                if (placeholderRegex.test(textContent)) {
                    const m = textContent.match(placeholderRegex);
                    if (m && m[0] === textContent) {
                        const kind = m[1];
                        const id = m[2];
                        const caption = decodeURIComponent(m[3] || '');
                        const captionRt = caption ? [{ type: 'text', text: { content: caption } }] : [];
                        if (kind === 'IMAGE') {
                            replacedBlocks.push({ type: 'image', image: { type: 'file_upload', file_upload: { id }, caption: captionRt } });
                        } else {
                            replacedBlocks.push({ type: 'file', file: { type: 'file_upload', file_upload: { id }, caption: captionRt } });
                        }
                        continue;
                    }
                    const m2 = textContent.match(placeholderRegex);
                    const before = textContent.replace(placeholderRegex, '');
                    const newPara = { type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: before } }] } };
                    replacedBlocks.push(newPara);
                    if (m2) {
                        const kind = m2[1];
                        const id = m2[2];
                        const caption = decodeURIComponent(m2[3] || '');
                        const captionRt = caption ? [{ type: 'text', text: { content: caption } }] : [];
                        if (kind === 'IMAGE') {
                            replacedBlocks.push({ type: 'image', image: { type: 'file_upload', file_upload: { id }, caption: captionRt } });
                        } else {
                            replacedBlocks.push({ type: 'file', file: { type: 'file_upload', file_upload: { id }, caption: captionRt } });
                        }
                    }
                    continue;
                }
            }
            replacedBlocks.push(block);
        }
        notionBlocks = normalizeBlocks(replacedBlocks);
        const stats = await fs.stat(filePath);
        const creationDate = stats.birthtime.toISOString().split('T')[0];

        const firstChunk = notionBlocks.slice(0, 100);
        const remainingChunks = [];
        for (let i = 100; i < notionBlocks.length; i += 100) {
            remainingChunks.push(notionBlocks.slice(i, i + 100));
        }

        let pageId;
        if (existingPageId) {
            // Overwrite content: clear existing children (Notion lacks bulk delete; append new content below)
            // Strategy: create a new page under same parent with same title, archive old.
            // Simpler approach that avoids complex diffing.
            const created = await callWithRetry(() => notion.pages.create({
                parent: parentInfo,
                properties: isPagesMode
                    ? { title: [{ type: 'text', text: { content: pageTitle } }] }
                    : {
                        'Name': { title: [{ text: { content: pageTitle } }] },
                        'Has Images': { checkbox: successfulUploadCount > 0 },
                        'Created Date': { date: { start: creationDate } },
                    },
                children: firstChunk,
            }));
            pageId = created.id;
            // Archive the old page to avoid duplicates
            try {
                await callWithRetry(() => notion.pages.update({ page_id: existingPageId, archived: true }));
            } catch (e) {
                console.log(`  ⚠️  Could not archive old page: ${e.message}`);
            }
        } else {
            const created = await callWithRetry(() => notion.pages.create({
                parent: parentInfo,
                properties: isPagesMode
                    ? { title: [{ type: 'text', text: { content: pageTitle } }] }
                    : {
                        'Name': { title: [{ text: { content: pageTitle } }] },
                        'Has Images': { checkbox: successfulUploadCount > 0 },
                        'Created Date': { date: { start: creationDate } },
                    },
                children: firstChunk,
            }));
            pageId = created.id;
        }

        for (const chunk of remainingChunks) {
            await delay(50 + Math.floor(Math.random() * 150));
            await callWithRetry(() => notion.blocks.children.append({
                block_id: pageId,
                children: chunk,
            }));
        }

        // Removed legacy (notion-file:ID) placeholder handling

        console.log(`✅ Synced: ${pageTitle}`);
        } catch (error) {
        const msg = (error && error.message) || '';
        const needsFallback = /table width|numbered_list_item/i.test(msg);
        if (!needsFallback) { console.error(`❌ ERROR syncing "${pageTitle}": ${error.message}`); return; }
        try {
            console.warn(`  ⚠️  Retrying "${pageTitle}" with simplified content due to Notion validation.`);
            let markdownContent = await fs.readFile(filePath, 'utf8');
            const lines = markdownContent.split(/\r?\n/);
            const out = [];
            for (let i = 0; i < lines.length; i++) {
                const l = lines[i];
                const isHeader = /\|.*\|/.test(l);
                const next = lines[i + 1] || '';
                const isDivider = /^\s*\|?[-|:\s]+\|?\s*$/.test(next);
                if (isHeader && isDivider) {
                    out.push('```'); out.push(l);
                    let j = i + 1; for (; j < lines.length; j++) { const lj = lines[j]; if (/\|/.test(lj)) out.push(lj); else break; }
                    out.push('```'); i = j - 1; continue;
                }
                out.push(l);
            }
            const flattened = out.map(l => l.replace(/^\s*([*+-]|\d+\.)\s+/,'')) .join('\n');
                let notionBlocks = markdownToBlocks(flattened);
                // Normalize list wrappers and preserve table children in fallback path too
                const normalizeBlocks = (blocks, depth = 0) => {
                    if (depth > 10) return []; // Prevent infinite recursion
                    const out = [];
                    if (!Array.isArray(blocks)) return out;
                    const typesThatAllowChildren = new Set([
                        'bulleted_list_item',
                        'numbered_list_item',
                        'to_do',
                        'toggle',
                        'callout',
                        'quote',
                        'synced_block',
                        'column_list',
                        'column',
                    ]);
                    for (const blk of blocks) {
                        if (!blk || typeof blk !== 'object' || !blk.type) continue;
                        const b = { ...blk };
                        // Ensure object field is set
                        if (!b.object) b.object = 'block';
                        // Divider blocks require an empty divider property
                        if (b.type === 'divider' && !b.divider) b.divider = {};
                        const typed = b[b.type];
                        if (b.type === 'bulleted_list' || b.type === 'numbered_list') {
                            const inner = (typed && Array.isArray(typed.children)) ? typed.children : [];
                            out.push(...normalizeBlocks(inner, depth + 1));
                            continue;
                        }
                        if (b.type === 'table') {
                            if (typed && Array.isArray(typed.children)) {
                                typed.children = normalizeBlocks(typed.children, depth + 1);
                            }
                            out.push(b);
                            continue;
                        }
                        if (typed && Array.isArray(typed.children)) {
                            const childBlocks = normalizeBlocks(typed.children, depth + 1);
                            if (typesThatAllowChildren.has(b.type)) {
                                typed.children = childBlocks;
                                out.push(b);
                            } else {
                                delete typed.children;
                                out.push(b);
                                out.push(...childBlocks);
                            }
                            continue;
                        }
                        if (Array.isArray(b.children) && b.children.length) {
                            const childBlocks = normalizeBlocks(b.children, depth + 1);
                            delete b.children;
                            if (!typed || typeof typed !== 'object' || Object.keys(typed).length === 0) {
                                if (typesThatAllowChildren.has(b.type)) {
                                    b[b.type] = { rich_text: [], children: childBlocks };
                                    out.push(b);
                                } else {
                                    out.push(b, ...childBlocks);
                                }
                            } else if (typesThatAllowChildren.has(b.type)) {
                                typed.children = childBlocks;
                                out.push(b);
                            } else {
                                out.push(b, ...childBlocks);
                            }
                        } else {
                            out.push(b);
                        }
                    }
                    return out;
                };
                notionBlocks = normalizeBlocks(notionBlocks);
            const firstChunk = notionBlocks.slice(0, 100);
            const remainingChunks = [];
            for (let i = 100; i < notionBlocks.length; i += 100) remainingChunks.push(notionBlocks.slice(i, i + 100));
                const relativePath = path.dirname(path.relative(config.markdownBaseDir, filePath));
            const isPagesMode = (config.structureMode || 'databases') === 'pages';
            let parentInfo;
            if (isPagesMode) parentInfo = { page_id: await getOrCreatePageForPath(relativePath === '.' ? '' : toUnixPath(relativePath)) };
            else parentInfo = { database_id: await getOrCreateDatabaseForPath(relativePath) };
                const fallbackTitle = path.basename(filePath, '.md');
                const created = await callWithRetry(() => notion.pages.create({ parent: parentInfo, properties: isPagesMode ? { title: [{ type: 'text', text: { content: fallbackTitle } }] } : { 'Name': { title: [{ text: { content: fallbackTitle } }] } }, children: firstChunk }));
            const pageId = created.id;
            for (const chunk of remainingChunks) { await delay(50 + Math.floor(Math.random() * 150)); await callWithRetry(() => notion.blocks.children.append({ block_id: pageId, children: chunk })); }
                console.log(`✅ Synced (fallback): ${fallbackTitle}`);
        } catch (e2) {
            const pTitle = path.basename(filePath, '.md');
            console.error(`❌ ERROR syncing (fallback) "${pTitle}": ${e2.message}`);
        }
    }
}

/**
 * Main function to process all Markdown files and sync them to Notion.
 */
async function processAllMarkdown() {
  try {
    const allFiles = await findMarkdownFiles(config.markdownBaseDir);
    
    if (allFiles.length === 0) {
      console.log('No Markdown files found.');
      return;
    }
    
    const isPagesMode = (config.structureMode || 'databases') === 'pages';
    let pagesModeExtra = null;
    let existingPages;
    if (isPagesMode) {
      pagesModeExtra = await fetchAllExistingPagesPagesMode();
      existingPages = pagesModeExtra.existingLeafKeys;
    } else {
      existingPages = await fetchAllExistingPages();
    }

    console.log(`\nFound ${allFiles.length} local files. Starting sync with concurrency of ${config.concurrencyLimit}...\n`);

    for (let i = 0; i < allFiles.length; i += config.concurrencyLimit) {
        const batch = allFiles.slice(i, i + config.concurrencyLimit);
        const promises = batch.map(filePath => processSingleFile(filePath, existingPages, pagesModeExtra));
        await Promise.all(promises);
    }

    console.log('\nAll files processed! 🚀');
  } catch (error) {
    console.error('A critical error occurred:', error);
  }
}

// Watch mode support (manual vs auto)
async function startWatchMode() {
  // Lazy load chokidar only when needed to avoid extra dependencies for non-watch users
  const { default: Chokidar } = await import('chokidar');
  const watcher = Chokidar.watch(config.markdownBaseDir, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: config.watchDebounceMs || 1000, pollInterval: 100 },
    ignored: /(^|[/\\])\../,
  });

  const pending = new Map(); // path -> timeout
  const queue = [];
  let busy = false;

  const enqueue = (filePath) => {
    if (!filePath.toLowerCase().endsWith('.md')) return;
    if (pending.has(filePath)) clearTimeout(pending.get(filePath));
    const t = setTimeout(() => {
      queue.push(filePath);
      pending.delete(filePath);
      drain();
    }, config.watchDebounceMs || 1000);
    pending.set(filePath, t);
  };

  const drain = async () => {
    if (busy) return;
    busy = true;
    try {
      // Refresh existing pages map for accurate updates
      const isPagesMode = (config.structureMode || 'databases') === 'pages';
      let pagesModeExtra = null;
      let existingPages;
      if (isPagesMode) {
        pagesModeExtra = await fetchAllExistingPagesPagesMode();
        existingPages = pagesModeExtra.existingLeafKeys;
      } else {
        existingPages = await fetchAllExistingPages();
      }

      while (queue.length > 0) {
        const filePath = queue.shift();
        try {
          await processSingleFile(filePath, existingPages, pagesModeExtra);
        } catch (e) {
          console.log(`Watch sync error for ${filePath}: ${e.message}`);
        }
      }
    } finally {
      busy = false;
    }
  };

  watcher
    .on('add', enqueue)
    .on('change', enqueue)
    .on('unlink', (filePath) => { /* optional delete handling later */ });

  console.log('Watching for changes... Press Ctrl+C to stop.');
}

// Run the script in manual or watch mode (also enable when WATCH_ON env is set)
if ((config.watchMode || 'off') === 'on' || process.env.WATCH_ON === '1') {
  startWatchMode();
} else {
  processAllMarkdown();
}
