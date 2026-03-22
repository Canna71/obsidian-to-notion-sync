require('dotenv').config();
const { notion, callWithRetry } = require('./src/notion');

const PARENT_PAGE_ID = process.env.NOTION_PARENT_PAGE_ID;

async function archiveAllChildren(parentId) {
    let archived = 0;
    let nextCursor = undefined;

    do {
        const response = await callWithRetry(() =>
            notion.blocks.children.list({ block_id: parentId, start_cursor: nextCursor })
        );

        for (const block of response.results) {
            const title =
                block.child_page?.title ||
                block.child_database?.title ||
                block.type;

            try {
                await callWithRetry(() =>
                    notion.pages.update({ page_id: block.id, archived: true })
                );
                console.log(`  ✅ 已归档: "${title}"`);
                archived++;
            } catch (e) {
                console.error(`  ❌ 归档失败: "${title}" — ${e.message}`);
            }
        }

        nextCursor = response.next_cursor;
    } while (nextCursor);

    return archived;
}

async function run() {
    if (!PARENT_PAGE_ID) {
        console.error('❌ 未设置 NOTION_PARENT_PAGE_ID，请检查 .env 文件');
        process.exit(1);
    }

    console.log(`正在清空 Notion 父页面下所有子页面...`);
    console.log(`父页面 ID: ${PARENT_PAGE_ID}\n`);

    try {
        const count = await archiveAllChildren(PARENT_PAGE_ID);
        console.log(`\n🗑️  共归档 ${count} 个页面，云端已清空。`);
        console.log(`现在可以运行 npm start 重新全量同步。`);
    } catch (e) {
        console.error('❌ 发生错误:', e.message);
        process.exit(1);
    }
}

run();
