#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const FEED_PATH = path.resolve(__dirname, '..', 'google-calendar-events');

const announcementKeywords = [
  'useful information',
  'veterans for veterans in care',
  'public announcement',
];

const excludedRecurringEventIds = [
  '2scpgqhjtjh5tc33cg3jm3ik5c',
  '30ed1sa1ev6k8kgp0ucg1mq24j',
];

function isAnnouncementItem(item = {}) {
  const title = String(item.summary || item.title || '').toLowerCase();
  if (item.recurringEventId && excludedRecurringEventIds.includes(item.recurringEventId)) return true;
  return announcementKeywords.some((k) => title.includes(k));
}

function readFeed(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error('Feed file not found:', filePath);
    process.exitCode = 2;
    return null;
  }
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  // The file may start with `"items": [` (partial JSON) — wrap it if so
  const jsonText = raw.startsWith('"items"') ? `{${raw}}` : raw;
  try {
    return JSON.parse(jsonText);
  } catch (e) {
    console.error('Failed to parse feed JSON:', e.message);
    process.exitCode = 3;
    return null;
  }
}

function validate(items) {
  const issues = [];
  const announcements = [];
  const events = [];
  const ids = new Set();
  const titleDate = new Set();

  items.forEach((it, idx) => {
    const id = it.id || it.etag || `idx-${idx}`;
    if (ids.has(id)) issues.push({ level: 'error', msg: `Duplicate id ${id}` });
    ids.add(id);

    const date = it.start?.date || it.start?.dateTime || it.date || '';
    const key = `${String(it.summary||it.title||'').trim().toLowerCase()}|${String(date)}`;
    if (titleDate.has(key)) issues.push({ level: 'warn', msg: `Duplicate title+date: ${key}` });
    titleDate.add(key);

    if (isAnnouncementItem(it)) {
      announcements.push(it);
      if (it.lat || it.lng) {
        issues.push({ level: 'warn', msg: `Announcement has coordinates (should be informational): id=${id}` });
      }
    } else {
      events.push(it);
      const lat = parseFloat(it.lat);
      const lng = parseFloat(it.lng);
      if (!isFinite(lat) || !isFinite(lng)) {
        issues.push({ level: 'error', msg: `Event missing/invalid coordinates: id=${id}, title=${it.summary||it.title}` });
      }
    }
  });

  return { issues, announcements, events };
}

function main() {
  const feed = readFeed(FEED_PATH);
  if (!feed) return;
  const items = feed.items || feed;
  if (!Array.isArray(items)) {
    console.error('Feed does not contain an items array');
    process.exitCode = 4;
    return;
  }

  const result = validate(items);

  console.log('Validation summary:');
  console.log(`  total items: ${items.length}`);
  console.log(`  announcements: ${result.announcements.length}`);
  console.log(`  events: ${result.events.length}`);
  if (result.issues.length === 0) {
    console.log('  issues: none');
    process.exitCode = 0;
  } else {
    console.log(`  issues: ${result.issues.length}`);
    result.issues.forEach((it) => console.log(`    [${it.level}] ${it.msg}`));
    // non-zero exit for any error
    process.exitCode = result.issues.some((i) => i.level === 'error') ? 1 : 0;
  }
}

main();
