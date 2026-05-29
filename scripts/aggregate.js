#!/usr/bin/env node
// Aggregate per-board Jira dumps into a manager + IC enrichment object.
// Reads /tmp/cis-jira/<PROJECT>.json (each is the persisted MCP tool result),
// writes /Users/ezdrazbaez/cis-org-chart/data.enriched.json.

const fs = require('fs');
const path = require('path');

const BOARDS = ['FC', 'CSS', 'CEGEO', 'QAS', 'TSC', 'MSV', 'RPS', 'TCET', 'TLCC', 'QUA'];

// Mapping: project key -> manager id (from data.json)
const BOARD_TO_MANAGER = {
  // Saloni's 4 boards roll up to Saloni herself, NOT to her sub-managers
  FC: 'SS', CSS: 'SS', CEGEO: 'SS', QAS: 'SS',
  // Maria's boards
  TSC: 'MD', MSV: 'MD', RPS: 'MD',
  // Marissa's boards (CON and LHAPI returned empty / don't exist)
  TCET: 'MH',
  // Yan's boards
  TLCC: 'YM', QUA: 'YM'
};

const SP_FIELD = 'customfield_10034';
const SPRINT_FIELD = 'customfield_10020';

// Jira GreenHopper epic palette — there are 14 lozenge variants.
// Custom colorName (customfield_10017) is null at moveinc, so we hash the epic
// key into one of these so the same epic stays the same color across drawers.
const EPIC_COLORS = [
  'ghx-label-1',  'ghx-label-2',  'ghx-label-3',  'ghx-label-4',
  'ghx-label-5',  'ghx-label-6',  'ghx-label-7',  'ghx-label-8',
  'ghx-label-9',  'ghx-label-10', 'ghx-label-11', 'ghx-label-12',
  'ghx-label-13', 'ghx-label-14'
];
function epicColorFor(key) {
  if (!key) return null;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return EPIC_COLORS[Math.abs(h) % EPIC_COLORS.length];
}

// Leaders / TechMod members who don't always show up as ticket assignees in the
// per-board pulls, so seed their avatars here. Captured 2026-05-28 from Jira.
const LEADER_AVATARS = {
  'Tyler Romeo': 'https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/557058:2d7c9213-6258-462e-a403-426ceb354000/4caf760c-0a55-4f12-8a68-a9f9f80fbbf8/32',
  'Saloni Sharma': 'https://secure.gravatar.com/avatar/be7e1098705062707ceea08f6d786b72?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FSS-5.png',
  'Marissa Hun': 'https://secure.gravatar.com/avatar/28644aadba23947628a7558f82390ad6?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FMH-0.png',
  'Maria Dalarcao': 'https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/5ff0df34849d64011123265f/19115e89-79b8-4f7b-9be3-26b488f14039/32',
  'Jeffrey Byrd': 'https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/5a8c43819d25142e30bd7b8b/7c002899-c11f-4c2f-bb53-88ed17053c70/32',
  'Ezdraz Baez': 'https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/712020:f8a7734e-9b60-4867-9aac-aa3e5f183834/5869bc81-2b1a-4ea7-a8b1-21ff4ea12af2/32',
  'Yan Medvedev': 'https://secure.gravatar.com/avatar/c2d6de170d656900c0ce8cae4d6abb10?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FYM-2.png',
  'Sukanya Ganguwar': 'https://secure.gravatar.com/avatar/045a89a54d89e0ff40138257b2bc6301?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FSG-2.png',
  'Swathi Kulkarni': 'https://secure.gravatar.com/avatar/eb77bff11d8066b9c30aa337e8f2d963?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FSK-2.png',
  'Sandhya Rani': 'https://secure.gravatar.com/avatar/9fcbfc64e986445ee033d72c8460a28f?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FSR-6.png'
};

function readBoard(name) {
  const p = path.join('/tmp/cis-jira', name + '.json');
  if (!fs.existsSync(p)) return [];
  const wrapper = JSON.parse(fs.readFileSync(p, 'utf8'));
  // Persisted MCP results are an array of {type:"text", text:"..."}.
  const text = Array.isArray(wrapper) ? wrapper[0].text : wrapper;
  const inner = typeof text === 'string' ? JSON.parse(text) : text;
  return inner.issues || [];
}

const managerHealth = {};   // managerId -> { committed, done, sprintNames:Set, ticketCount }
const icTickets = {};       // displayName -> [{...}]
const icAvatars = {};       // displayName -> avatar URL (32x32)

for (const board of BOARDS) {
  const issues = readBoard(board);
  const managerId = BOARD_TO_MANAGER[board];
  if (!managerId) continue;

  for (const iss of issues) {
    const f = iss.fields || {};
    const sp = f[SP_FIELD] || 0;
    const sprints = f[SPRINT_FIELD] || [];
    const activeSprint = sprints.find(s => s.state === 'active');
    if (!activeSprint) continue;  // only active-sprint commit counts

    const statusName = f.status?.name || 'Unknown';
    const statusCat = f.status?.statusCategory?.key || 'new'; // new | indeterminate | done
    const statusColor = f.status?.statusCategory?.colorName || null; // jira: green/yellow/blue-gray
    const assignee = f.assignee?.displayName || 'Unassigned';
    const assigneeAvatar = f.assignee?.avatarUrls?.['32x32'] || null;
    const issueType = f.issuetype?.name || null;
    const issueTypeIcon = f.issuetype?.iconUrl || null;
    const parent = f.parent ? {
      key: f.parent.key,
      summary: f.parent.fields?.summary || f.parent.key,
      color: epicColorFor(f.parent.key)
    } : null;

    // Manager rollup
    if (!managerHealth[managerId]) {
      managerHealth[managerId] = { committed: 0, done: 0, sprintNames: new Set(), ticketCount: 0 };
    }
    managerHealth[managerId].committed += sp;
    managerHealth[managerId].ticketCount += 1;
    managerHealth[managerId].sprintNames.add(activeSprint.name);
    if (statusCat === 'done') managerHealth[managerId].done += sp;

    // IC drawer
    if (!icTickets[assignee]) icTickets[assignee] = [];
    icTickets[assignee].push({
      key: iss.key,
      summary: f.summary || '',
      sp: sp,
      status: statusName,
      statusCat: statusCat,
      statusColor: statusColor,
      issueType: issueType,
      issueTypeIcon: issueTypeIcon,
      parent: parent,
      board: board,
      sprint: activeSprint.name,
      url: `https://moveinc.atlassian.net/browse/${iss.key}`
    });

    // Capture per-IC avatar (last write wins, fine since same IC = same URL)
    if (!icAvatars[assignee] && assigneeAvatar) icAvatars[assignee] = assigneeAvatar;
  }
}

// Finalize manager rollups
const mh = {};
for (const [mid, v] of Object.entries(managerHealth)) {
  mh[mid] = {
    committed: v.committed,
    done: v.done,
    pct: v.committed > 0 ? Math.round((v.done / v.committed) * 100) : 0,
    ticketCount: v.ticketCount,
    sprintNames: [...v.sprintNames].sort()
  };
}

// Seed leader avatars (only fill if not already captured from a ticket)
for (const [name, url] of Object.entries(LEADER_AVATARS)) {
  if (!icAvatars[name]) icAvatars[name] = url;
}

// Sort each IC's tickets: open first, then by SP desc
for (const name of Object.keys(icTickets)) {
  icTickets[name].sort((a, b) => {
    const aOpen = a.statusCat !== 'done' ? 0 : 1;
    const bOpen = b.statusCat !== 'done' ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    return (b.sp || 0) - (a.sp || 0);
  });
}

// ---------- Kanban ingestion (Marissa's team — no sprints) ----------
// Marissa's reports work in Kanban across CON/LHAPI/CR/TD/etc. We pull two
// JQL slices per manager: open tickets (statusCategory != Done) and the last
// 14 days of Done. Files are persisted MCP results in /tmp/cis-jira/kanban/.
const KANBAN_SOURCES = [
  { manager: 'MH', files: [
    'kanban/marissa-open-1.json', 'kanban/marissa-open-2.json',
    'kanban/marissa-done-1.json', 'kanban/marissa-done-2.json'
  ]},
  // TechMod folks rolling up to Marissa (Sukanya, Swathi, Sandhya) also work
  // kanban-style — pulled separately because they're in the shared TM card,
  // not in Marissa's directICs list.
  { manager: 'TM', files: [
    'kanban/techmod-marissa-open-1.json',
    'kanban/techmod-marissa-done-1.json'
  ]},
  // Leaders (Tyler, Saloni, Marissa, Maria, Yan, Nilesh, Yihan, Ez). Pulled
  // open with `updated >= -14d` so the drawer shows what they're actively
  // touching this sprint, not their stale auto-assigned intake backlog.
  { manager: 'LEADERS', files: [
    'kanban/leaders-open-1.json',
    'kanban/leaders-done-1.json',
    'kanban/leaders-done-2.json'
  ]}
];

const kanbanIcs = {}; // displayName -> { open: [...], done: [...] }

function readKanbanFile(rel) {
  const p = path.join('/tmp/cis-jira', rel);
  if (!fs.existsSync(p)) return [];
  const wrapper = JSON.parse(fs.readFileSync(p, 'utf8'));
  const text = Array.isArray(wrapper) ? wrapper[0].text : wrapper;
  const inner = typeof text === 'string' ? JSON.parse(text) : text;
  return inner.issues || [];
}

for (const src of KANBAN_SOURCES) {
  for (const rel of src.files) {
    const isOpen = /open/.test(rel);
    const issues = readKanbanFile(rel);
    for (const iss of issues) {
      const f = iss.fields || {};
      const assignee = f.assignee?.displayName || 'Unassigned';
      const assigneeAvatar = f.assignee?.avatarUrls?.['32x32'] || null;
      const statusName = f.status?.name || 'Unknown';
      const statusCat = f.status?.statusCategory?.key || 'new';
      const statusColor = f.status?.statusCategory?.colorName || null;
      const issueType = f.issuetype?.name || null;
      const issueTypeIcon = f.issuetype?.iconUrl || null;
      const parent = f.parent ? {
        key: f.parent.key,
        summary: f.parent.fields?.summary || f.parent.key,
        color: epicColorFor(f.parent.key)
      } : null;
      const project = (iss.key.split('-')[0]) || null;

      if (!kanbanIcs[assignee]) kanbanIcs[assignee] = { open: [], done: [], manager: src.manager };
      const ticket = {
        key: iss.key,
        summary: f.summary || '',
        sp: f[SP_FIELD] || 0,
        status: statusName,
        statusCat: statusCat,
        statusColor: statusColor,
        issueType: issueType,
        issueTypeIcon: issueTypeIcon,
        parent: parent,
        board: project,
        resolved: f.resolutiondate || null,
        url: `https://moveinc.atlassian.net/browse/${iss.key}`
      };
      kanbanIcs[assignee][isOpen ? 'open' : 'done'].push(ticket);
      if (!icAvatars[assignee] && assigneeAvatar) icAvatars[assignee] = assigneeAvatar;
    }
  }
}

// Sort kanban open: not-done first by status (To Do before In Progress), then key desc.
// Sort kanban done: most recently resolved first.
for (const name of Object.keys(kanbanIcs)) {
  kanbanIcs[name].open.sort((a, b) => {
    if (a.statusCat !== b.statusCat) {
      // 'new' (To Do) before 'indeterminate' (In Progress)
      return a.statusCat === 'new' ? -1 : 1;
    }
    return b.key.localeCompare(a.key);
  });
  kanbanIcs[name].done.sort((a, b) => {
    if (a.resolved && b.resolved) return b.resolved.localeCompare(a.resolved);
    return b.key.localeCompare(a.key);
  });
  kanbanIcs[name].openCount = kanbanIcs[name].open.length;
  kanbanIcs[name].doneCount = kanbanIcs[name].done.length;
}

const out = {
  generatedAt: new Date().toISOString(),
  spField: SP_FIELD,
  capacityCap: 10,
  boardToManager: BOARD_TO_MANAGER,
  managerHealth: mh,
  icTickets,
  icAvatars,
  kanbanIcs,
  kanbanDoneWindowDays: 14
};

const outPath = '/Users/ezdrazbaez/cis-org-chart/data.enriched.json';
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');

const totals = Object.values(mh).reduce(
  (acc, v) => ({ c: acc.c + v.committed, d: acc.d + v.done, t: acc.t + v.ticketCount }),
  { c: 0, d: 0, t: 0 }
);
console.log(`Wrote ${outPath}`);
console.log(`Managers: ${Object.keys(mh).length}, ICs: ${Object.keys(icTickets).length}, Kanban ICs: ${Object.keys(kanbanIcs).length}`);
console.log(`Totals: ${totals.t} active-sprint tickets, ${totals.d}/${totals.c} SP done`);
for (const [mid, v] of Object.entries(mh)) {
  console.log(`  ${mid}: ${v.done}/${v.committed} SP (${v.pct}%) across ${v.ticketCount} tickets, sprints: ${v.sprintNames.join(', ')}`);
}
const kanbanTotals = Object.values(kanbanIcs).reduce(
  (acc, v) => ({ o: acc.o + v.openCount, d: acc.d + v.doneCount }), { o: 0, d: 0 }
);
console.log(`Kanban: ${kanbanTotals.o} open, ${kanbanTotals.d} done in last 14d`);
for (const [name, v] of Object.entries(kanbanIcs)) {
  console.log(`  ${name}: ${v.openCount} open, ${v.doneCount} done`);
}
