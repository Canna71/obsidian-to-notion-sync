const { Client } = require('@notionhq/client');
const { callWithRetry } = require('./utils');
const fs = require('fs/promises');
const { fetch, FormData, File } = require('undici');

// Support both NOTION_KEY and NOTION_TOKEN, and allow overriding Notion API version for new file APIs
// Default to a stable version with proven file upload support
// Note: 2025-09-03 has breaking changes with multi-source databases
const NOTION_VERSION = process.env.NOTION_VERSION || '2022-06-28';
const notion = new Client({ auth: process.env.NOTION_KEY || process.env.NOTION_TOKEN, notionVersion: NOTION_VERSION });

// Minimal MIME type resolver for common attachments we handle
function guessMimeType(fileName) {
    const lower = (fileName || '').toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.bmp')) return 'image/bmp';
    if (lower.endsWith('.svg')) return 'image/svg+xml';
    if (lower.endsWith('.tif') || lower.endsWith('.tiff')) return 'image/tiff';
    if (lower.endsWith('.pdf')) return 'application/pdf';
    if (lower.endsWith('.mp3')) return 'audio/mpeg';
    if (lower.endsWith('.wav')) return 'audio/wav';
    if (lower.endsWith('.mp4')) return 'video/mp4';
    if (lower.endsWith('.mov')) return 'video/quicktime';
    return 'application/octet-stream';
}

/**
 * Creates a new Notion database inside the parent page.
 * @param {string} title - The title for the new database.
 * @returns {Promise<string>} The ID of the newly created database.
 */
async function createNotionDatabase(title) {
    console.log(`  Creating new Notion database titled: "${title}"`);
    const response = await callWithRetry(() => notion.databases.create({
        parent: { page_id: process.env.NOTION_PARENT_PAGE_ID },
        title: [{ type: 'text', text: { content: title } }],
        properties: {
            'Name': { title: {} },
            'Has Images': { checkbox: {} },
            'Created Date': { date: {} },
        },
    }));
    return response.id;
}

// Removed unused doesPageExist helper

const databasePromiseCache = new Map();

/**
 * Gets the ID of a Notion database for a given path, creating it if it doesn't exist.
 * @param {string} relativePath - The path to the file, relative to the base directory.
 * @returns {Promise<string>} The Notion database ID.
 */
function getOrCreateDatabaseForPath(relativePath) {
    const dbTitle = relativePath === '.' ? 'Root' : relativePath;

    if (databasePromiseCache.has(dbTitle)) {
        return databasePromiseCache.get(dbTitle);
    }

    const promise = (async () => {
        const response = await callWithRetry(() => notion.blocks.children.list({ block_id: process.env.NOTION_PARENT_PAGE_ID }));
        const existingDb = response.results.find(block => 
            block.type === 'child_database' && block.child_database.title === dbTitle
        );

        if (existingDb) {
            console.log(`  Found existing database for path: "${dbTitle}"`);
            return existingDb.id;
        } else {
            return await createNotionDatabase(dbTitle);
        }
    })();

    databasePromiseCache.set(dbTitle, promise);
    return promise;
}

/**
 * Fetches all pages from all databases under the parent page and returns a set of unique keys.
 * @returns {Promise<Set<string>>} A set of unique keys for existing pages (e.g., "DatabaseTitle/PageTitle").
 */
async function fetchAllExistingPages() {
    console.log('Fetching all existing pages from Notion to speed up sync...');
    const existingKeys = new Set();
    
    const dbsResponse = await callWithRetry(() => notion.blocks.children.list({ block_id: process.env.NOTION_PARENT_PAGE_ID }));
    const databaseBlocks = dbsResponse.results.filter(block => block.type === 'child_database');

    for (const dbBlock of databaseBlocks) {
        const dbTitle = dbBlock.child_database.title;
        const dbId = dbBlock.id;
        let nextCursor = undefined;
        
        do {
            const response = await notion.databases.query({
                database_id: dbId,
                start_cursor: nextCursor,
                page_size: 100,
            });

            for (const page of response.results) {
                const pageTitle = page.properties.Name?.title?.[0]?.plain_text;
                if (pageTitle) {
                    const uniqueKey = `${dbTitle}/${pageTitle}`;
                    existingKeys.add(uniqueKey);
                }
            }
            nextCursor = response.next_cursor;
        } while (nextCursor);
    }
    
    console.log(`Found ${existingKeys.size} existing pages across ${databaseBlocks.length} databases.`);
    return existingKeys;
}

// -------------------- PAGES MODE (nested pages) --------------------

const pagePromiseCache = new Map();

/**
 * Ensures a chain of child pages exists for the given relative path under NOTION_PARENT_PAGE_ID.
 * Returns the page_id of the deepest page (the container for the markdown file).
 * Example: "2025/Notas diarias/01-Enero" will create/find pages for 2025 -> Notas diarias -> 01-Enero.
 * @param {string} relativePath
 * @returns {Promise<string>} page_id of the deepest page for the folder path
 */
async function getOrCreatePageForPath(relativePath) {
    const rootParentId = process.env.NOTION_PARENT_PAGE_ID;
    if (!relativePath || relativePath === '.') return rootParentId;

    const segments = relativePath.split(/[\\/]+/).filter(Boolean);
    let parentId = rootParentId;

    for (const segmentTitle of segments) {
        const cacheKey = `${parentId}::${segmentTitle}`;
        if (pagePromiseCache.has(cacheKey)) {
            parentId = await pagePromiseCache.get(cacheKey);
            continue;
        }

        const promise = (async () => {
            // Find existing child page with same title
            const listChildren = async (blockId) => {
                let next = undefined;
                do {
                    const resp = await callWithRetry(() => notion.blocks.children.list({ block_id: blockId, start_cursor: next }));
                    const found = resp.results.find(b => b.type === 'child_page' && b.child_page.title === segmentTitle);
                    if (found) return found.id;
                    next = resp.next_cursor;
                } while (next);
                return null;
            };

            const existingId = await listChildren(parentId);
            if (existingId) {
                return existingId;
            }

            const created = await callWithRetry(() => notion.pages.create({
                parent: { page_id: parentId },
                properties: {
                    title: [
                        { type: 'text', text: { content: segmentTitle } }
                    ]
                }
            }));
            return created.id;
        })();

        pagePromiseCache.set(cacheKey, promise);
        parentId = await promise;
    }

    return parentId;
}

/**
 * Recursively fetch all page paths under NOTION_PARENT_PAGE_ID.
 * Returns a Set of keys like "folderA/folderB/PageTitle" for leaf pages.
 * Also returns a Map of folder path -> page_id for containers.
 * @returns {Promise<{existingLeafKeys: Set<string>, containerPathToId: Map<string,string>}>}
 */
async function fetchAllExistingPagesPagesMode() {
    const rootParentId = process.env.NOTION_PARENT_PAGE_ID;
    const existingLeafKeys = new Set();
    const containerPathToId = new Map();
    const leafTitleToIdByPath = new Map(); // key: path/title -> page_id

    async function walk(parentId, pathSegments) {
        // Record container path -> id
        const pathKey = pathSegments.join('/');
        containerPathToId.set(pathKey, parentId);

        let next = undefined;
        do {
            const resp = await callWithRetry(() => notion.blocks.children.list({ block_id: parentId, start_cursor: next }));
            for (const block of resp.results) {
                if (block.type === 'child_page') {
                    const title = block.child_page.title;
                    const pageId = block.id;
                    // This page could be either a container (has children) or a leaf; treat as container and continue walking.
                    const newPathSegs = [...pathSegments, title];
                    await walk(pageId, newPathSegs);
                    // Also treat it as a potential leaf (where a markdown file with same title would be created)
                    const leafKey = `${pathSegments.length ? pathSegments.join('/') + '/' : ''}${title}`;
                    existingLeafKeys.add(leafKey);
                    leafTitleToIdByPath.set(leafKey, pageId);
                }
            }
            next = resp.next_cursor;
        } while (next);
    }

    await walk(rootParentId, []);
    return { existingLeafKeys, containerPathToId, leafTitleToIdByPath };
}

/**
 * Uploads a local file to Notion using the native upload API (2-step process).
 * Step 1: Create file upload object at /v1/file_uploads
 * Step 2: Send file data to /v1/file_uploads/{id}/send
 * @param {string} filePath
 * @returns {Promise<string>} file upload id
 */
async function uploadFileToNotion(filePath) {
    const fileBuffer = await fs.readFile(filePath);
    const fileName = filePath.split(/[/\\]/).pop();
    const contentType = guessMimeType(fileName);
    
    // Debug logging
    const debugMode = process.env.DEBUG_UPLOADS === '1';
    if (debugMode) console.log(`\n[DEBUG] Uploading file: ${fileName} (${fileBuffer.length} bytes)`);
    if (debugMode) console.log(`[DEBUG] Detected content type: ${contentType}`);

    const uploader = async () => {
        // STEP 1: Create file upload object
        if (debugMode) console.log(`[DEBUG] Step 1: Creating file upload object`);
        
        const createRes = await fetch('https://api.notion.com/v1/file_uploads', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.NOTION_KEY || process.env.NOTION_TOKEN}`,
                'Notion-Version': NOTION_VERSION,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                // Explicit single-part upload with proper metadata
                mode: 'single_part',
                filename: fileName,
                content_type: contentType,
            }),
        });
        
        const createJson = await createRes.json().catch(() => ({}));
        if (debugMode) console.log(`[DEBUG] Create response (${createRes.status}):`, JSON.stringify(createJson));
        
        if (!createRes.ok) {
            const err = new Error(createJson?.message || `Failed to create file upload (${createRes.status})`);
            err.status = createRes.status;
            err.response = createJson;
            throw err;
        }
        
        const fileUploadId = createJson?.id;
        if (!fileUploadId) {
            throw new Error(`No file upload ID returned. Response: ${JSON.stringify(createJson)}`);
        }
        
        if (debugMode) console.log(`[DEBUG] File upload ID: ${fileUploadId}`);
        
        // STEP 2: Send the actual file using multipart/form-data
        if (debugMode) console.log(`[DEBUG] Step 2: Sending file data to /file_uploads/${fileUploadId}/send`);
        
        // Create a File object from the buffer (undici's FormData works with File/Blob objects)
        const file = new File([fileBuffer], fileName, { type: contentType });
        
        const formData = new FormData();
        formData.append('file', file);
        
        const sendRes = await fetch(`https://api.notion.com/v1/file_uploads/${fileUploadId}/send`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.NOTION_KEY || process.env.NOTION_TOKEN}`,
                'Notion-Version': NOTION_VERSION,
                // Don't manually set Content-Type - let fetch handle it with proper boundary
            },
            body: formData,
        });
        
        const sendJson = await sendRes.json().catch(() => ({}));
        if (debugMode) console.log(`[DEBUG] Send response (${sendRes.status}):`, JSON.stringify(sendJson));
        
        if (!sendRes.ok) {
            const err = new Error(sendJson?.message || `Failed to send file (${sendRes.status})`);
            err.status = sendRes.status;
            err.response = sendJson;
            throw err;
        }
        
        if (debugMode) console.log(`[DEBUG] ✅ File uploaded successfully! ID: ${fileUploadId}`);
        
        return fileUploadId;
    };

    return await callWithRetry(uploader);
}

module.exports = {
    notion,
    createNotionDatabase,
    getOrCreateDatabaseForPath,
    callWithRetry,
    fetchAllExistingPages,
    // pages mode
    getOrCreatePageForPath,
    fetchAllExistingPagesPagesMode,
    uploadFileToNotion,
};
