#!/usr/bin/env node
/**
 * dry_run_notion_bugdrain.js — the real Notion round-trip test VUAT-S001 has been missing
 * (2026-08-30). Nobody but the founder has the real Notion workspace/token, so this can't
 * be run from an automated session — it calls the REAL, unmodified `createNotionPage`
 * from cron-worker/bugdrain.js (imported, not duplicated) against your own Notion
 * workspace and creates one real, clearly-labelled test page.
 *
 * Usage:
 *   cd brandgita-react
 *   NOTION_TOKEN=secret_xxx NOTION_DB=your-database-id node scripts/dry_run_notion_bugdrain.js
 *
 * NOTION_TOKEN / NOTION_DB are the same two secrets cron-worker's real deployment already
 * has (wrangler secret list / your Cloudflare dashboard) — this script never touches D1,
 * GitHub, or any real bug-report row. It creates exactly one throwaway Notion page you
 * can delete afterward; nothing else is touched.
 */
import { createNotionPage } from '../cron-worker/bugdrain.js';

async function main() {
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const NOTION_DB = process.env.NOTION_DB;

  if (!NOTION_TOKEN || !NOTION_DB) {
    console.error('Usage: NOTION_TOKEN=... NOTION_DB=... node scripts/dry_run_notion_bugdrain.js');
    console.error('(the same two secrets the real cron-worker deployment already has)');
    process.exit(1);
  }

  const env = { NOTION_TOKEN, NOTION_DB };
  const row = { report_type: 'dry-run-test' };
  const parsed = {
    summary: `VUAT-S001 dry run — ${new Date().toISOString()} — safe to delete this page.`,
  };

  console.log('Calling the real Notion API with the real, unmodified createNotionPage()...');
  try {
    const pageId = await createNotionPage(env, fetch, row, parsed);
    console.log('SUCCESS — real Notion page created:', pageId);
    console.log('https://notion.so/' + pageId.replace(/-/g, ''));
    console.log('\nVUAT-S001 confirmed end-to-end: the exact code your production cron-worker');
    console.log('runs writes a real page to your real Notion database. Delete the test page');
    console.log('above whenever you like — it is not tracked anywhere else.');
  } catch (err) {
    console.error('FAILED — the real Notion round-trip did not work:', err.message);
    console.error('This means VUAT-S001 is NOT actually proven, whatever the code review says.');
    process.exit(1);
  }
}

main();
