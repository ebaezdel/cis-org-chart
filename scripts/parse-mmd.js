#!/usr/bin/env node
/**
 * Parses a Mermaid graph (.mmd) of the CIS org and emits data.json.
 *
 * Usage:
 *   node scripts/parse-mmd.js <input.mmd> <output.json>
 *
 * Expected Mermaid shape (matches Tyler's org_chart_updated.mmd):
 *   graph TD
 *     TR["Tyler Romeo"]
 *     TR --> SS["Saloni Sharma\nContent Engineering"]
 *     SS --> YM["Yan Medvedev\nContent Ingestion - Foundational"]
 *     YM --> SM["Stephen McLaughlin"]
 *     ...
 *     style SS fill:#2d6be4,...
 *
 * Style colors are used to classify nodes into tiers:
 *   - Tyler:        #1a1a2e     → root
 *   - Top leaders:  #2d6be4     → Tyler's directs (engineering/operations/industry/pe/tpm)
 *   - Sub-managers: #0d9488     → Saloni's directs (engineering managers + Content Services team)
 *
 * The Saloni's-org sub-tree is treated as nested groups; everyone else's
 * children become directICs. Department label is inferred from the leader's
 * role text (the part after the \n).
 */

const fs = require('fs');
const path = require('path');

const INPUT = process.argv[2];
const OUTPUT = process.argv[3];
if (!INPUT || !OUTPUT) {
  console.error('Usage: parse-mmd.js <input.mmd> <output.json>');
  process.exit(1);
}

const src = fs.readFileSync(INPUT, 'utf8');

// ── 1. Collect node definitions: ID["Name\nRole"]  or  ID[Name] ──────────
const nodes = {}; // id → { id, name, role }
const nodeRe = /(\b[A-Z][A-Z0-9]*)\s*\[\s*"?([^"\]]+)"?\s*\]/g;
let m;
while ((m = nodeRe.exec(src)) !== null) {
  const id = m[1];
  const label = m[2].replace(/\\n/g, '\n').trim();
  const [name, ...roleParts] = label.split('\n');
  if (!nodes[id]) {
    nodes[id] = { id, name: name.trim(), role: roleParts.join(' · ').trim() };
  }
}

// ── 2. Collect edges: A --> B ─────────────────────────────────────────────
const edges = []; // [parentId, childId]
const edgeRe = /\b([A-Z][A-Z0-9]*)\s*-->\s*([A-Z][A-Z0-9]*)\b/g;
while ((m = edgeRe.exec(src)) !== null) {
  edges.push([m[1], m[2]]);
}

// ── 3. Collect style colors: style ID fill:#hex ──────────────────────────
const colors = {}; // id → hex (lowercased, without #)
const styleRe = /style\s+([A-Z][A-Z0-9]*)\s+fill:\s*#?([0-9a-fA-F]{3,8})/g;
while ((m = styleRe.exec(src)) !== null) {
  colors[m[1]] = m[2].toLowerCase();
}

const TIER = {
  ROOT:        ['1a1a2e'],
  LEADER:      ['2d6be4'],
  SUBMANAGER:  ['0d9488']
};
const tierOf = (id) => {
  const c = colors[id];
  if (TIER.ROOT.includes(c))       return 'root';
  if (TIER.LEADER.includes(c))     return 'leader';
  if (TIER.SUBMANAGER.includes(c)) return 'submanager';
  return 'ic';
};

// ── 4. Build parent → children map ───────────────────────────────────────
const childrenOf = {};
edges.forEach(([p, c]) => {
  (childrenOf[p] ||= []).push(c);
});

// ── 5. Find root (or fall back to first node with no incoming edge) ──────
const incoming = new Set(edges.map(([, c]) => c));
let rootId = Object.keys(nodes).find(id => tierOf(id) === 'root')
          || Object.keys(nodes).find(id => !incoming.has(id));
if (!rootId) {
  console.error('Could not determine root node');
  process.exit(1);
}

// ── 6. Department classification from leader role text ───────────────────
const DEPT_RULES = [
  { test: /content engineering/i,             dept: 'engineering' },
  { test: /content.*industry.*operations/i,   dept: 'operations'  },
  { test: /industry tools.*syndication/i,     dept: 'industry'    },
  { test: /\bpe\b/i,                          dept: 'pe'          },
  { test: /\btpm\b/i,                         dept: 'tpm'         },
  { test: /techmod/i,                         dept: 'techmod'     }
];
const deptOf = (role, name) => {
  const txt = `${name} ${role}`;
  for (const r of DEPT_RULES) if (r.test.test(txt)) return r.dept;
  return 'unclassified';
};

// ── 7. Build the org array ───────────────────────────────────────────────
const leaders = (childrenOf[rootId] || []);
const orgArr = leaders.map(leaderId => {
  const leader = nodes[leaderId];
  const dept = deptOf(leader.role, leader.name);
  const kids = childrenOf[leaderId] || [];

  // Has any sub-manager-tier children → use groups
  const hasSubManagers = kids.some(k => tierOf(k) === 'submanager');

  if (hasSubManagers) {
    const groups = kids.map(kid => {
      const grandkids = (childrenOf[kid] || []).map(gid => nodes[gid].name);
      const isManagerTier = tierOf(kid) === 'submanager';
      // Heuristic: a sub-manager-tier node whose label has no role line is
      // treated as a "team" (e.g. Content Services). With a role → "manager".
      const looksLikeTeam = isManagerTier && !nodes[kid].role;
      return {
        type: looksLikeTeam ? 'team' : 'manager',
        id: kid,
        name: nodes[kid].name,
        role: nodes[kid].role || (looksLikeTeam ? 'Team' : ''),
        ics: grandkids
      };
    });
    return { id: leader.id, name: leader.name, role: leader.role, dept, groups };
  }

  // Otherwise treat children as direct ICs
  const directICs = kids.map(k => nodes[k].name);
  return { id: leader.id, name: leader.name, role: leader.role, dept, directICs };
});

// ── 8. Apply optional overlay (data.overlay.json) for local additions ────
// Tyler's .mmd is the source of truth, but we keep cross-functional teams
// (e.g. TechMod) and other manually-curated additions in an overlay file
// that gets merged on top after every sync.
const overlayPath = path.join(path.dirname(OUTPUT), 'data.overlay.json');
let mergedOrg = orgArr;
let overlayApplied = false;
if (fs.existsSync(overlayPath)) {
  try {
    const overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8'));
    if (Array.isArray(overlay.add)) {
      const existingIds = new Set(orgArr.map(l => l.id));
      overlay.add.forEach(extra => {
        if (!existingIds.has(extra.id)) mergedOrg.push(extra);
      });
      overlayApplied = true;
    }
  } catch (e) {
    console.warn(`Overlay parse failed (${e.message}); continuing without it.`);
  }
}

// Departments observed in the merged org
const departments = [...new Set(mergedOrg.map(l => l.dept))].filter(d => d !== 'unclassified');

const output = {
  lastUpdated: new Date().toISOString(),
  source: path.basename(INPUT),
  overlayApplied,
  departments,
  org: mergedOrg
};

fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2) + '\n');
console.log(`Wrote ${OUTPUT} — ${orgArr.length} leaders, ${departments.length} departments`);
