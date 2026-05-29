#!/usr/bin/env node
// Fetch the Jira slices that aggregate.js consumes.
//
// Two sets of inputs are written to /tmp/cis-jira/:
//   - Per-board active-sprint pulls (one file per project key)
//   - Kanban slices: open-not-done + last-14d-done for groups of assignees
//     (Marissa's directs, the TechMod folks under Marissa, the leaders, Jeff)
//
// Output shape mirrors what the MCP atlassian tool used to persist so that
// aggregate.js doesn't need to know whether the data came from MCP or REST:
//   { issues: [...] }
//
// Auth: JIRA_EMAIL + JIRA_API_TOKEN env vars, basic-auth.
// Run from anywhere — the script writes absolute paths under /tmp/cis-jira.

const fs = require('fs');
const path = require('path');
const https = require('https');

const JIRA_HOST = 'moveinc.atlassian.net';
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;

if (!EMAIL || !TOKEN) {
  console.error('Missing JIRA_EMAIL or JIRA_API_TOKEN env var');
  process.exit(1);
}

const OUT_DIR = '/tmp/cis-jira';
const KANBAN_DIR = path.join(OUT_DIR, 'kanban');
fs.mkdirSync(KANBAN_DIR, { recursive: true });

const BOARDS = ['FC', 'CSS', 'CEGEO', 'QAS', 'TSC', 'MSV', 'RPS', 'TCET', 'TLCC', 'QUA'];

const SPRINT_FIELDS = [
  'summary','description','comment','labels',
  'issuetype','parent','project',
  'customfield_10020','assignee','customfield_10034','status'
];
const KANBAN_FIELDS_BASE = [
  'summary','issuetype','parent','project',
  'customfield_10020','assignee','customfield_10034','status'
];

function jiraGet(jqlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: JIRA_HOST,
      path: jqlPath,
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64'),
        'Accept': 'application/json'
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        } else {
          reject(new Error(`Jira HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function searchAll(jql, fields) {
  const all = [];
  let nextPageToken = null;
  let safety = 20;
  while (safety-- > 0) {
    const params = new URLSearchParams({
      jql,
      fields: fields.join(','),
      maxResults: '100'
    });
    if (nextPageToken) params.set('nextPageToken', nextPageToken);
    const url = `/rest/api/3/search/jql?${params.toString()}`;
    const page = await jiraGet(url);
    if (page.issues) all.push(...page.issues);
    if (page.isLast || !page.nextPageToken) break;
    nextPageToken = page.nextPageToken;
  }
  return { issues: all };
}

async function pullBoard(key) {
  const jql = `project = "${key}" AND sprint in openSprints()`;
  console.log(`[board] ${key}…`);
  const data = await searchAll(jql, SPRINT_FIELDS);
  fs.writeFileSync(path.join(OUT_DIR, `${key}.json`), JSON.stringify(data));
  console.log(`  ${key}: ${data.issues.length}`);
}

async function pullKanban(name, jql, fields) {
  console.log(`[kanban] ${name}…`);
  const data = await searchAll(jql, fields);
  fs.writeFileSync(path.join(KANBAN_DIR, `${name}.json`), JSON.stringify(data));
  console.log(`  ${name}: ${data.issues.length}`);
}

const MARISSA_DIRECTS = [
  'Justin Rumer','Ryan Jenkins','Oleg Gareys','Karen Hiller','Christina Gaglio',
  'Naga Shamili Kommuru','Laoura Atoyan','Harsha Thumma','Fernando Alonso',
  'Erick Suarez Zavala','Paul Bond'
];
const TECHMOD_MARISSA = ['Sukanya Ganguwar','Swathi Kulkarni','Sandhya Rani'];
const LEADERS = [
  'Tyler Romeo','Saloni Sharma','Marissa Hun','Maria Dalarcao',
  'Yan Medvedev','Nilesh Karwa','Yihan Qian','Ezdraz Baez'
];

const inList = arr => arr.map(n => `"${n}"`).join(', ');

(async () => {
  // Per-board active-sprint pulls
  for (const b of BOARDS) await pullBoard(b);

  // Marissa's directs — kanban
  await pullKanban('marissa-open-1',
    `assignee in (${inList(MARISSA_DIRECTS)}) AND statusCategory != Done ORDER BY assignee ASC, updated DESC`,
    KANBAN_FIELDS_BASE);
  await pullKanban('marissa-done-1',
    `assignee in (${inList(MARISSA_DIRECTS)}) AND statusCategory = Done AND resolved >= -14d ORDER BY assignee ASC, resolved DESC`,
    [...KANBAN_FIELDS_BASE, 'resolutiondate']);

  // TechMod folks under Marissa
  await pullKanban('techmod-marissa-open-1',
    `assignee in (${inList(TECHMOD_MARISSA)}) AND statusCategory != Done ORDER BY assignee ASC, updated DESC`,
    KANBAN_FIELDS_BASE);
  await pullKanban('techmod-marissa-done-1',
    `assignee in (${inList(TECHMOD_MARISSA)}) AND statusCategory = Done AND resolved >= -14d ORDER BY assignee ASC, resolved DESC`,
    [...KANBAN_FIELDS_BASE, 'resolutiondate']);

  // Leaders — open scoped to last-14d so it's "what they're touching now"
  await pullKanban('leaders-open-1',
    `assignee in (${inList(LEADERS)}) AND statusCategory != Done AND updated >= -14d ORDER BY assignee ASC, updated DESC`,
    [...KANBAN_FIELDS_BASE, 'updated']);
  await pullKanban('leaders-done-1',
    `assignee in (${inList(LEADERS)}) AND statusCategory = Done AND resolved >= -14d ORDER BY assignee ASC, resolved DESC`,
    [...KANBAN_FIELDS_BASE, 'resolutiondate']);

  // Jeff Byrd — across all projects
  await pullKanban('jeff-open-1',
    `assignee = "Jeffrey Byrd" AND statusCategory != Done AND updated >= -14d ORDER BY updated DESC`,
    [...KANBAN_FIELDS_BASE, 'updated']);
  await pullKanban('jeff-done-1',
    `assignee = "Jeffrey Byrd" AND statusCategory = Done AND resolved >= -14d ORDER BY resolved DESC`,
    [...KANBAN_FIELDS_BASE, 'resolutiondate']);

  console.log('Done.');
})().catch(e => {
  console.error(e);
  process.exit(1);
});
