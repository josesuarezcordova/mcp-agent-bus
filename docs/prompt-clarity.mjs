#!/usr/bin/env node
// prompt-clarity.mjs — OFFLINE "judge" analyzer for PROMPT CLARITY.
//
// For each completed task it feeds the (prompt, response) pair to a cheap
// `cursor-agent -p` call and asks it to grade how CLEAR the *prompt* was:
//   - clarityScore 1-5  (5 = perfectly clear & self-contained, 1 = unactionable)
//   - understood        ("yes" | "partly" | "no")
//   - missingContext[]  (what the prompt failed to specify)
//   - reason            (one short sentence)
//
// It runs ON DEMAND, never in the hot path of a task, so real tasks are never
// slowed. Results are cached per task (keyed by timestamp) so re-runs don't
// re-spend on already-judged tasks.
//
// INPUT — two modes:
//   (a) Bus workers (default): reads $AGENT_BUS_DIR/run/<name>.tasks.jsonl
//       (written by worker.mjs) which carries {ts, from, subject, ticket,
//       promptText, replyText}.
//   (b) Generic pairs (--input FILE): any JSONL where each line has a prompt and
//       a response under {prompt|promptText} and {response|reply|replyText}.
//       Use this to judge HUB transcripts too — the judge only needs a
//       (prompt, response) pair, it does not care where it came from. See the
//       README/prompt-clarity.md for how to convert a Cursor hub transcript.
//
// OUTPUT:
//   - per-task results appended to $RUN_DIR/clarity/<name>.clarity.jsonl
//     (or --out FILE in generic mode)
//   - a printed aggregate summary: avg clarity per sender / per prompt template /
//     per ticket, plus example low-clarity prompts to fix.
//
// Usage:
//   node docs/prompt-clarity.mjs                     # judge all bus workers
//   node docs/prompt-clarity.mjs --worker wkr-01     # one worker
//   node docs/prompt-clarity.mjs --input pairs.jsonl # generic (e.g. hub)
//   node docs/prompt-clarity.mjs --model <m>         # judge model (cheap one)
//   node docs/prompt-clarity.mjs --limit 20 --force  # cap N, re-judge cached
//   node docs/prompt-clarity.mjs --summary-only      # aggregate cached results
//
// Env: AGENT_BUS_HOME, AGENT_BUS_DIR, AGENT_BUS_RUN_DIR, JUDGE_MODEL.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

// ---------- args ----------
const argv = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};
const has = name => argv.includes(name);

const HOME_DIR = process.env.AGENT_BUS_HOME || process.cwd();
const BUS_DIR =
  process.env.MCP_AGENT_BUS_DIR ||
  process.env.AGENT_BUS_DIR ||
  path.join(HOME_DIR, 'bus');
const RUN_DIR =
  process.env.AGENT_BUS_RUN_DIR ||
  process.env.MCP_AGENT_BUS_RUN_DIR ||
  path.join(BUS_DIR, 'run');
const CLARITY_DIR = path.join(RUN_DIR, 'clarity');

const WORKER = opt('--worker');
const INPUT = opt('--input');
const OUT = opt('--out');
const MODEL = opt('--model', process.env.JUDGE_MODEL || null);
const LIMIT = parseInt(opt('--limit', '0'), 10) || 0;
const FORCE = has('--force');
const SUMMARY_ONLY = has('--summary-only');
const CONCURRENCY = Math.max(1, parseInt(opt('--concurrency', '2'), 10) || 2);

if (has('-h') || has('--help')) {
  const src = fs.readFileSync(new URL(import.meta.url), 'utf8');
  process.stdout.write(src.split('\n').slice(1, 40).join('\n').replace(/^\/\/ ?/gm, '') + '\n');
  process.exit(0);
}

// ---------- helpers ----------
const readJsonl = file => {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch {}
  }
  return out;
};

const parseTicket = (subject, text) => {
  const m = `${subject || ''} ${text || ''}`.match(/[A-Z]{2,}-\d+/);
  return m ? m[0] : null;
};

// Normalise a prompt to a "template" so near-identical prompts group together:
// strip ticket ids, numbers → #, punctuation → space, collapse whitespace.
const templateKey = prompt => {
  return String(prompt || '')
    .toLowerCase()
    .replace(/[A-Z]{2,}-\d+/gi, '')
    .replace(/\d+/g, '#')
    .replace(/[^a-z0-9#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
};
const templateLabel = prompt => {
  const one = String(prompt || '').replace(/\s+/g, ' ').trim();
  return one.length > 70 ? one.slice(0, 69) + '…' : one;
};

// Extract the first JSON object from a possibly-noisy string.
const extractJson = s => {
  if (!s) return null;
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
    } }
  }
  return null;
};

const JUDGE_INSTRUCTIONS = `You are a strict evaluator of PROMPT CLARITY.
You are given a PROMPT that was sent to an AI agent, and the agent's RESPONSE.
Judge how clear and well-specified the PROMPT itself was — i.e. could the agent
understand and act on it WITHOUT guessing intent or hunting for missing context?
Base your judgement on the prompt; use the response only as evidence of confusion.

Return ONLY a single compact JSON object (no prose, no code fences) with keys:
"clarityScore": integer 1-5 (5 = perfectly clear & self-contained; 1 = ambiguous/unactionable),
"understood": one of "yes","partly","no",
"missingContext": array of short strings naming what the prompt failed to specify (use [] if none),
"reason": one short sentence.`;

// Run one judging call through cursor-agent. Returns parsed JSON or an error obj.
function judge(prompt, response) {
  return new Promise(resolve => {
    const full =
      `${JUDGE_INSTRUCTIONS}\n\nPROMPT:\n<<<\n${prompt || ''}\n>>>\n\n` +
      `RESPONSE:\n<<<\n${response || ''}\n>>>\n\nJSON:`;
    const cliArgs = ['-p', full, '--output-format', 'stream-json'];
    if (MODEL) cliArgs.push('--model', MODEL);
    const child = spawn('cursor-agent', cliArgs, { env: process.env });
    let buf = '';
    let resultText = null;
    let err = '';
    child.stdout.on('data', d => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'result' && typeof ev.result === 'string') resultText = ev.result;
        } catch {}
      }
    });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', e => resolve({ error: `spawn failed: ${e.message}` }));
    child.on('close', () => {
      const tail = buf.trim();
      if (tail) { try { const ev = JSON.parse(tail); if (ev.type === 'result') resultText = ev.result; } catch {} }
      const parsed = extractJson(resultText || '');
      if (!parsed) return resolve({ error: 'could not parse judge output', raw: (resultText || err || '').slice(0, 200) });
      // normalise
      let score = parseInt(parsed.clarityScore, 10);
      if (!(score >= 1 && score <= 5)) score = null;
      const understood = ['yes', 'partly', 'no'].includes(parsed.understood) ? parsed.understood : null;
      resolve({
        clarityScore: score,
        understood,
        missingContext: Array.isArray(parsed.missingContext) ? parsed.missingContext.slice(0, 8) : [],
        reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 240) : '',
      });
    });
  });
}

// Simple concurrency pool.
async function pool(items, n, worker) {
  const out = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return out;
}

// ---------- gather tasks ----------
function gatherBusTasks() {
  let files = [];
  try { files = fs.readdirSync(RUN_DIR).filter(f => f.endsWith('.tasks.jsonl')); } catch {}
  if (WORKER) files = files.filter(f => f === `${WORKER}.tasks.jsonl`);
  const tasks = [];
  for (const f of files) {
    const name = f.replace(/\.tasks\.jsonl$/, '');
    for (const r of readJsonl(path.join(RUN_DIR, f))) {
      tasks.push({
        ts: r.ts,
        name,
        from: (r.from || 'unknown').toLowerCase(),
        subject: r.subject || null,
        ticket: r.ticket || parseTicket(r.subject, r.promptText),
        prompt: r.promptText || '',
        response: r.replyText || '',
      });
    }
  }
  return tasks;
}

function gatherGenericTasks(file) {
  const tasks = [];
  for (const r of readJsonl(file)) {
    const prompt = r.promptText ?? r.prompt ?? '';
    const response = r.replyText ?? r.reply ?? r.response ?? '';
    tasks.push({
      ts: r.ts || new Date().toISOString(),
      name: r.name || 'generic',
      from: (r.from || 'unknown').toLowerCase(),
      subject: r.subject || null,
      ticket: r.ticket || parseTicket(r.subject, prompt),
      prompt,
      response,
    });
  }
  return tasks;
}

// Already-judged cache (keyed by ts+name) so we don't re-spend.
function loadCache() {
  const cache = new Map();
  let files = [];
  try { files = fs.readdirSync(CLARITY_DIR).filter(f => f.endsWith('.clarity.jsonl')); } catch {}
  for (const f of files) {
    for (const r of readJsonl(path.join(CLARITY_DIR, f))) cache.set(`${r.ts}|${r.name}`, r);
  }
  return cache;
}

// ---------- aggregation / report ----------
const avg = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const bar = (v, max = 5) => '█'.repeat(Math.round((v / max) * 10)).padEnd(10, '·');

function groupBy(rows, keyFn) {
  const g = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  return g;
}

function printGroup(title, g, labelFn = k => k) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
  const rows = [...g.entries()].map(([k, rs]) => {
    const scores = rs.map(r => r.clarityScore).filter(n => n != null);
    const no = rs.filter(r => r.understood === 'no').length;
    const partly = rs.filter(r => r.understood === 'partly').length;
    return { k, n: rs.length, avg: avg(scores), notUnderstood: no + partly };
  }).sort((a, b) => a.avg - b.avg);
  console.log('  ' + 'GROUP'.padEnd(42) + 'N'.padStart(4) + '  AVG'.padStart(6) + '  UNDERSTAND' + '  SCORE');
  for (const r of rows) {
    const lbl = String(labelFn(r.k)).slice(0, 40).padEnd(42);
    const ok = r.n - r.notUnderstood;
    console.log(
      '  ' + lbl + String(r.n).padStart(4) +
      ('  ' + r.avg.toFixed(2)).padStart(6) +
      `   ${ok}/${r.n} ok`.padEnd(12) +
      '  ' + bar(r.avg)
    );
  }
}

function report(results) {
  const scored = results.filter(r => r.clarityScore != null);
  if (!scored.length) { console.log('\n(no scored results yet)'); return; }
  const overall = avg(scored.map(r => r.clarityScore));
  console.log(`\n\x1b[1mPROMPT CLARITY — ${scored.length} task(s) judged\x1b[0m   overall avg ${overall.toFixed(2)}/5  ${bar(overall)}`);

  printGroup('By sender (from)', groupBy(scored, r => r.from));
  printGroup('By ticket', groupBy(scored, r => r.ticket));
  printGroup('By prompt template', groupBy(scored, r => r.templateKey), k => {
    const ex = scored.find(r => r.templateKey === k);
    return ex ? ex.templateLabel : k;
  });

  // worst offenders — example low-clarity prompts to fix
  const worst = scored.filter(r => r.clarityScore <= 2 || r.understood === 'no')
    .sort((a, b) => (a.clarityScore || 0) - (b.clarityScore || 0))
    .slice(0, 8);
  if (worst.length) {
    console.log('\n\x1b[1mExample LOW-CLARITY prompts to improve\x1b[0m');
    for (const r of worst) {
      console.log(`  \x1b[33m[${r.clarityScore ?? '?'}/5 ${r.understood}]\x1b[0m from=${r.from}${r.ticket ? ' ' + r.ticket : ''}`);
      console.log(`    prompt : ${templateLabel(r.prompt)}`);
      if (r.missingContext?.length) console.log(`    missing: ${r.missingContext.join('; ')}`);
      if (r.reason) console.log(`    reason : ${r.reason}`);
    }
  }
}

// ---------- main ----------
async function main() {
  await fsp.mkdir(CLARITY_DIR, { recursive: true });
  let tasks = INPUT ? gatherGenericTasks(INPUT) : gatherBusTasks();
  // only judge tasks that actually have both sides
  tasks = tasks.filter(t => (t.prompt || '').trim() && (t.response || '').trim());
  tasks.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  const cache = SUMMARY_ONLY ? loadCache() : (FORCE ? new Map() : loadCache());

  // In summary-only mode we just report whatever is cached.
  if (SUMMARY_ONLY) {
    const results = [...cache.values()].map(r => ({ ...r }));
    report(results);
    return;
  }

  let todo = tasks.filter(t => !cache.has(`${t.ts}|${t.name}`));
  if (LIMIT > 0) todo = todo.slice(0, LIMIT);

  console.log(`prompt-clarity: ${tasks.length} task(s) available, ${todo.length} to judge${MODEL ? ` (model ${MODEL})` : ''}${cache.size ? `, ${cache.size} cached` : ''}`);

  const judged = await pool(todo, CONCURRENCY, async (t, idx) => {
    process.stderr.write(`  judging ${idx + 1}/${todo.length} (${t.name} from ${t.from})…\n`);
    const verdict = await judge(t.prompt, t.response);
    const rec = {
      ts: t.ts, name: t.name, from: t.from, ticket: t.ticket || null,
      templateKey: templateKey(t.prompt), templateLabel: templateLabel(t.prompt),
      prompt: t.prompt, // kept for the "examples to fix" section (local-only)
      clarityScore: verdict.clarityScore ?? null,
      understood: verdict.understood ?? null,
      missingContext: verdict.missingContext || [],
      reason: verdict.reason || verdict.error || '',
    };
    // append to per-worker clarity file (generic → --out or clarity/generic.clarity.jsonl)
    const outFile = OUT || path.join(CLARITY_DIR, `${t.name}.clarity.jsonl`);
    fs.appendFileSync(outFile, JSON.stringify(rec) + '\n', 'utf8');
    return rec;
  });

  // merge freshly-judged with cache for the report
  const all = [...cache.values(), ...judged];
  report(all);
}

main().catch(e => { console.error('prompt-clarity failed:', e); process.exit(1); });
