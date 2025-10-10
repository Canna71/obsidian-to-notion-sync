require('dotenv').config();
const readline = require('readline');
const { notion, callWithRetry } = require('./src/notion');

// --- CONFIGURATION ---
const NOTION_PARENT_PAGE_ID = process.env.NOTION_CLEANUP_PARENT_PAGE_ID;
// ----------------------------------------------------

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

/**
 * Promisified version of readline.question to use with async/await.
 * @param {string} query - The question to ask the user.
 * @returns {Promise<string>} The user's answer.
 */
const askQuestion = (query) => {
    return new Promise(resolve => rl.question(query, resolve));
};

/**
 * Generates possible date formats from a string of 4, 5, or 6 digits.
 * @param {string} numStr - The string of digits (e.g., "51025").
 * @returns {string[]} An array of valid date strings (e.g., ["5-10-25"]).
 */
function generateDatePossibilities(numStr) {
    const possibilities = new Set(); // Use a Set to avoid duplicate formats
    const len = numStr.length;

    const isValidDate = (m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31;

    if (len === 4) { // MDDY
        const m = parseInt(numStr.substring(0, 1), 10);
        const d = parseInt(numStr.substring(1, 2), 10);
        const y = numStr.substring(2);
        if (isValidDate(m, d)) {
            possibilities.add(`${m}-${d}-${y}`);
        }
    } else if (len === 5) { // MMDDY or MDDYY
        // M-DD-YY
        const m1 = parseInt(numStr.substring(0, 1), 10);
        const d1 = parseInt(numStr.substring(1, 3), 10);
        const y1 = numStr.substring(3);
        if (isValidDate(m1, d1)) {
            possibilities.add(`${m1}-${d1}-${y1}`);
        }
        // MM-D-YY
        const m2 = parseInt(numStr.substring(0, 2), 10);
        const d2 = parseInt(numStr.substring(2, 3), 10);
        const y2 = numStr.substring(3);
        if (isValidDate(m2, d2)) {
            possibilities.add(`${m2}-${d2}-${y2}`);
        }
    } else if (len === 6) { // MMDDYY
        const m = parseInt(numStr.substring(0, 2), 10);
        const d = parseInt(numStr.substring(2, 4), 10);
        const y = numStr.substring(4);
        if (isValidDate(m, d)) {
            possibilities.add(`${m}-${d}-${y}`);
        }
    }

    return Array.from(possibilities);
}

/**
 * Processes a single page to find and format dates in its title.
 * @param {object} page - The Notion page object.
 */
async function processPageForDates(page) {
    let originalTitle = page.properties.Name.title[0]?.text?.content;
    if (!originalTitle) return;

    console.log(`\n--- Checking for dates in: "${originalTitle}" ---`);
    let currentTitle = originalTitle;
    let propertiesToUpdate = {};

    // Find and format dates
    const dateRegex = /\b(\d{4,6})\b/g;
    const matches = currentTitle.match(dateRegex);

    if (matches) {
        for (const numberStr of matches) {
            const possibilities = generateDatePossibilities(numberStr);
            if (possibilities.length === 0) {
                continue; // No valid date formats found for this number
            }

            let chosenFormat = null;

            if (possibilities.length === 1) {
                chosenFormat = possibilities[0];
            } else {
                // ✅ NEW: Logic to automatically decide based on 'Created Date'
                const createdDateStr = page.properties['Created Date']?.date?.start;
                if (createdDateStr) {
                    const createdDate = new Date(createdDateStr);
                    const oneMonthInMs = 31 * 24 * 60 * 60 * 1000;
                    
                    const matchingPossibilities = possibilities.filter(p => {
                        const parts = p.split('-');
                        const year = parseInt(parts[2], 10) + 2000;
                        const month = parseInt(parts[0], 10) - 1;
                        const day = parseInt(parts[1], 10);
                        const possibleDate = new Date(year, month, day);
                        
                        const diff = Math.abs(possibleDate.getTime() - createdDate.getTime());
                        return diff <= oneMonthInMs;
                    });

                    if (matchingPossibilities.length === 1) {
                        chosenFormat = matchingPossibilities[0];
                        console.log(`  ✍️  Automatically chose "${chosenFormat}" for "${numberStr}" based on similarity to created date.`);
                    } else {
                        console.log(`  ⏭️  Skipping ambiguous date "${numberStr}". Found ${matchingPossibilities.length} similar possibilities.`);
                    }
                } else {
                    console.log(`  ⏭️  Skipping ambiguous date "${numberStr}" (no created date property to compare with).`);
                }
            }
            
            if (chosenFormat) {
                currentTitle = currentTitle.replace(numberStr, chosenFormat);
                console.log(`  ✍️  Formatting date: "${numberStr}" -> "${chosenFormat}"`);

                // Prepare the 'Created Date' property for update
                const dateParts = chosenFormat.split('-');
                const month = parseInt(dateParts[0], 10);
                const day = parseInt(dateParts[1], 10);
                const year = parseInt(dateParts[2], 10);
                const fullYear = year < 100 ? 2000 + year : year;
                
                const dateObj = new Date(Date.UTC(fullYear, month - 1, day));
                if (!isNaN(dateObj.getTime())) {
                    const notionDate = dateObj.toISOString().split('T')[0];
                    propertiesToUpdate['Created Date'] = { date: { start: notionDate } };
                    console.log(`  🗓️  Will update 'Created Date' property to: ${notionDate}`);
                }
            }
        }
    }

    // Update the page in Notion if the title or other properties have changed
    if (currentTitle !== originalTitle) {
        propertiesToUpdate['Name'] = { title: [{ text: { content: currentTitle } }] };
    }

    if (Object.keys(propertiesToUpdate).length > 0) {
        try {
            await notion.pages.update({
                page_id: page.id,
                properties: propertiesToUpdate,
            });
            console.log(`  ✅ Page updated in Notion.`);
        } catch (error) {
            console.error(`  ❌ Error updating page "${originalTitle}": ${error.message}`);
        }
    } else {
        console.log('  No changes needed for this page.');
    }
}

/**
 * Recursively finds all databases within a page and its sub-pages.
 * @param {string} pageId - The ID of the page to search.
 * @param {number} depth - Current depth for logging purposes.
 * @returns {Promise<string[]>} Array of database IDs found.
 */
async function findAllDatabases(pageId, depth = 0) {
    const indent = '  '.repeat(depth);
    console.log(`${indent}🔍 Searching for databases${depth === 0 ? ' in workspace...' : '...'}`);
    
    let databaseIds = [];
    
    try {
        const response = await callWithRetry(() => notion.blocks.children.list({ block_id: pageId }));
        
        for (const block of response.results) {
            if (block.type === 'child_database') {
                databaseIds.push(block.id);
                console.log(`${indent}📊 Found database: "${block.child_database.title}"`);
            } else if (block.type === 'child_page') {
                console.log(`${indent}📄 Searching sub-page: "${block.child_page.title}"`);
                const subDatabases = await findAllDatabases(block.id, depth + 1);
                databaseIds = databaseIds.concat(subDatabases);
            }
        }
    } catch (error) {
        console.error(`${indent}❌ Error searching page: ${error.message}`);
    }
    
    return databaseIds;
}

/**
 * Main function to find all databases and process all their pages.
 */
async function runCleanup() {
    try {
        const databaseIds = await findAllDatabases(NOTION_PARENT_PAGE_ID);

        if (databaseIds.length === 0) {
            console.log('No databases found under the specified parent page.');
            return;
        }

        console.log(`\n✅ Found ${databaseIds.length} database(s) total. Fetching all pages...`);
        
        let allPages = [];
        for (const dbId of databaseIds) {
            let nextCursor = undefined;
            do {
                const dbQueryResponse = await notion.databases.query({
                    database_id: dbId,
                    start_cursor: nextCursor,
                });
                allPages.push(...dbQueryResponse.results);
                nextCursor = dbQueryResponse.next_cursor;
            } while (nextCursor);
        }
        console.log(`Found a total of ${allPages.length} pages.`);

        // 1. Create a map of titles to pages for fast lookups.
        const pagesByTitle = new Map();
        for (const page of allPages) {
            const title = page.properties.Name.title[0]?.text?.content?.trim();
            if (title) {
                pagesByTitle.set(title, page);
            }
        }

        // 2. Identify duplicate groups with strict name checking.
        const duplicateGroups = [];
        const processedPageIds = new Set();
        const processedTitles = new Set(); // Track processed titles to avoid duplicates
        let pagesToProcessForDates = [];

        for (const page of allPages) {
            if (processedPageIds.has(page.id)) continue;

            const originalTitle = page.properties.Name.title[0]?.text?.content?.trim();
            if (!originalTitle || processedTitles.has(originalTitle)) continue;

            const potentialDuplicateTitles = [`${originalTitle} 1`, `${originalTitle} 2`];
            const foundDuplicates = [];

            for (const dupTitle of potentialDuplicateTitles) {
                if (pagesByTitle.has(dupTitle)) {
                    const dupPage = pagesByTitle.get(dupTitle);
                    if (!processedPageIds.has(dupPage.id)) {
                        foundDuplicates.push(dupPage);
                    }
                }
            }

            if (foundDuplicates.length > 0) {
                const group = [page, ...foundDuplicates];
                duplicateGroups.push(group);
                group.forEach(p => processedPageIds.add(p.id));
                processedTitles.add(originalTitle);
            } else {
                pagesToProcessForDates.push(page);
                processedTitles.add(originalTitle);
            }
        }
        
        // 3. Handle batch deletion with context.
        const pagesToDelete = new Map();
        let pagesToKeep = [...allPages];

        if (duplicateGroups.length > 0) {
            console.log('\n--- Found Potential Duplicate Groups ---');
            let prompt = 'The following groups contain duplicates. Please enter the numbers of the pages you wish to DELETE, separated by commas (e.g., "1, 3, 5").\nType \'all\' to delete all listed duplicates. Press ENTER to skip all.\n';
            let deletionCounter = 1;

            for (const group of duplicateGroups) {
                const originalPage = group[0];
                prompt += `\nGroup for "${originalPage.properties.Name.title[0].text.content}":\n`;
                prompt += `  [Original] ${originalPage.properties.Name.title[0].text.content}\n`;
                
                for (let i = 1; i < group.length; i++) {
                    const duplicatePage = group[i];
                    prompt += `  ${deletionCounter}: [Duplicate] ${duplicatePage.properties.Name.title[0].text.content}\n`;
                    pagesToDelete.set(deletionCounter, duplicatePage);
                    deletionCounter++;
                }
            }
            
            const answer = await askQuestion(prompt + '\nPages to delete: ');
            const trimmedAnswer = answer.trim().toLowerCase();
            const pagesToDeleteFromGroups = [];

            if (trimmedAnswer === 'all') {
                console.log('Marking all listed duplicates for deletion...');
                pagesToDeleteFromGroups.push(...pagesToDelete.values());
            } else if (trimmedAnswer !== '') {
                const indicesToDelete = new Set(
                    trimmedAnswer.split(',').map(n => parseInt(n.trim(), 10))
                );
                
                indicesToDelete.forEach(index => {
                    if (pagesToDelete.has(index)) {
                        pagesToDeleteFromGroups.push(pagesToDelete.get(index));
                    }
                });
            }

            if (pagesToDeleteFromGroups.length > 0) {
                const deletedIds = new Set(pagesToDeleteFromGroups.map(p => p.id));
                let successfulDeletions = 0;
                
                // Delete pages one by one with delays to avoid conflicts
                for (const pageToDelete of pagesToDeleteFromGroups) {
                    try {
                        console.log(`  Marking for deletion: "${pageToDelete.properties.Name.title[0].text.content}"`);
                        
                        // Check if already archived first
                        if (pageToDelete.archived) {
                            console.log(`    ⏭️  Already archived, skipping`);
                            continue;
                        }
                        
                        await callWithRetry(() => notion.pages.update({
                            page_id: pageToDelete.id,
                            archived: true,
                        }));
                        
                        successfulDeletions++;
                        
                        // Small delay to prevent conflicts
                        await new Promise(resolve => setTimeout(resolve, 100));
                        
                    } catch (error) {
                        if (error.message.includes('archived')) {
                            console.log(`    ⏭️  Already archived: "${pageToDelete.properties.Name.title[0].text.content}"`);
                        } else {
                            console.log(`    ❌ Failed to delete: "${pageToDelete.properties.Name.title[0].text.content}" - ${error.message}`);
                        }
                    }
                }
                
                console.log(`\n✅ Successfully deleted ${successfulDeletions} duplicate page(s).`);
                pagesToKeep = pagesToKeep.filter(p => !deletedIds.has(p.id));

            } else {
                console.log('Skipping deletion of duplicates.');
            }
        } else {
            console.log('\nNo duplicate pages found.');
        }

        // 4. Process remaining pages for date formatting.
        console.log('\n--- Processing remaining pages for date formatting ---');
        for (const page of pagesToKeep) {
            await processPageForDates(page);
        }

        console.log('\n\n🚀 Cleanup complete!');

    } catch (error) {
        console.error('\nA critical error occurred:', error.message);
    } finally {
        rl.close();
    }
}

// Run the script
runCleanup();
