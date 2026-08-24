/**
 * skills.js — which of your skills actually fire?
 *
 * A skill only earns its place if something invokes it. The hard part is that
 * "invoked" is written to the transcript in two unrelated shapes, and counting
 * either one alone is wrong by a lot:
 *
 *   1. The model calls the Skill tool   -> tool_use { name: "Skill", input.skill }
 *   2. The user types /name             -> <command-name>/name</command-name>
 *
 * Measured here: triage-inbox is 12 by shape 1 and 35 by shape 2. Reading only
 * the tool calls undercounts it fourfold. They are reported separately as well
 * as summed, because the two mean different things — shape 1 is the description
 * matching what the user wrote, shape 2 is the user already knowing the name.
 *
 * What is NOT a signal: the skill's name appearing in the transcript. Mentions
 * are dominated by the agent talking about the skill, grepping for it, or
 * reading its SKILL.md — deck-builder appears 1703 times and was invoked
 * once. Only the two shapes above are counted.
 *
 * <command-name> also carries built-in CLI commands (/model, /login, /clear),
 * which are named explicitly below. Resolving against the skills present on
 * disk was tried first and is wrong: skills bundled with the CLI have no
 * SKILL.md anywhere, so that filter reported 2 of 23 real skills and declared
 * the rest never fired. The on-disk inventory answers only "what is installed
 * and never ran"; it never decides whether an invocation counts.
 *
 * Zero dependencies.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const LIVE_DIR = path.join(os.homedir(), '.claude', 'projects');
const ARCHIVE_DIR = path.join(os.homedir(), '.cclogsall', 'projects');

/**
 * Where SKILL.md files live. This inventory is best-effort and can never be
 * complete: skills bundled with the CLI (deep-research, code-review, …) ship
 * inside the binary and have no SKILL.md on disk at all. So it is used only to
 * answer "what is installed and never fired" — never to decide whether an
 * invocation counts.
 */
const SKILL_ROOTS = [
  path.join(os.homedir(), '.claude', 'skills'),
  path.join(os.homedir(), '.claude', 'plugins'),
];

/**
 * Project checkouts keep their own .claude/skills, and they can live anywhere.
 * Rather than guess at directory conventions — the first cut hardcoded ~/work
 * and ~/private, which is one machine's habit and finds nothing on anyone
 * else's — the checkouts are recovered from the transcript directory names,
 * which encode the cwd they belong to.
 */
const ENCODED_SEP = '-';

/**
 * Turn `-Users-me-src-my-app` back into `/Users/me/src/my-app`.
 *
 * The encoding replaces every '/' with '-' and is therefore ambiguous: a real
 * directory may contain '-' too. Resolution walks the filesystem one segment at
 * a time and takes the longest child that actually exists, so `lab-worktrees`
 * resolves as one directory rather than `lab/worktrees`. Returns null when no
 * such path is on disk — a checkout that has since been deleted or renamed.
 */
function decodeProjectDir(encoded) {
  if (!encoded.startsWith(ENCODED_SEP)) return null;
  const tokens = encoded.split(ENCODED_SEP);
  let cur = path.sep;
  let i = 1;
  while (i < tokens.length) {
    let children;
    try {
      children = new Set(fs.readdirSync(cur, { withFileTypes: true })
        .filter((d) => d.isDirectory()).map((d) => d.name));
    } catch (e) { return null; }
    let bestEnd = -1;
    for (let j = i + 1; j <= tokens.length; j++) {
      if (children.has(tokens.slice(i, j).join(ENCODED_SEP))) bestEnd = j;
    }
    if (bestEnd < 0) return null;
    cur = path.join(cur, tokens.slice(i, bestEnd).join(ENCODED_SEP));
    i = bestEnd;
  }
  return cur;
}

function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => path.join(dir, e.name));
  } catch (e) { return []; }
}

// macOSの「デスクトップと書類」iCloud同期はこれらのフォルダをプレース
// ホルダ管理にし、readdirSync が iCloud デーモンの応答待ちで**無期限に
// ブロックする**ことがある(実測: sample/traceで `~/Desktop` の
// readdirSync 1本がカーネルのopen$NOCANCELで何時間もハングするのを確認、
// TCCの「書類フォルダへのアクセス要求」の謎もこれで説明がつく)。
// この関数の目的はコードチェックアウトの発見で、Desktop/Documents等の
// 標準ユーザーフォルダにチェックアウトが置かれることは通常無い —
// 安全に除外できる。
const SKIP_HOME_SUBDIRS = new Set([
  'Desktop', 'Documents', 'Downloads', 'Movies', 'Music', 'Pictures', 'Public',
  // Dropbox/OneDrive/Google Drive等、名前を全部列挙するのは原理的に不完全
  // (レビューで指摘: 新しいプロバイダが増えるたびに漏れる)。よくある名前は
  // 一応残しつつ、下のisDifferentDeviceで機構的にも防ぐ。
  'Dropbox', 'OneDrive', 'Google Drive', 'Box', 'iCloud Drive',
]);

// 名前を知らないクラウド同期・外部ドライブ・ネットワーク共有は、たいてい
// ホームディレクトリと別デバイス(別マウント)になる(実測:
// stat(home).st_dev === stat(~/Desktop).st_dev — iCloudの「デスクトップと
// 書類」はデバイスを跨がないので上の名前リストでしか防げないが、それ以外の
// 大半のプロバイダは別デバイスとしてマウントされる)。名前リストが古くなっても
// 機構で防げるよう二重化する。
function isDifferentDevice(homeDev, dir) {
  try {
    return fs.statSync(dir).dev !== homeDev;
  } catch (e) {
    return false; // statできない = 通常のディレクトリ探索では到達しない扱い
  }
}

/**
 * Where to look for project-local skills.
 *
 * Two sources, unioned, because neither covers the other:
 *  - every cwd Claude Code has kept a transcript for, which is exact and works
 *    on any machine regardless of where checkouts live;
 *  - checkouts one and two levels under the home directory, which catches repos
 *    that have skills but no session on record yet.
 *
 * Transcripts alone are not enough: on this machine that found 53 skills where
 * a directory scan found 106. Widening the search must never narrow the result
 * — except for the documented exception below (cloud-sync/other-device
 * folders): a checkout inside `~/Desktop` or `~/Dropbox` is a real gap this
 * introduces, but the alternative (hanging indefinitely) is worse. This is a
 * deliberate, narrow exception to the invariant above, not a silent one.
 */
function projectSkillRoots() {
  const roots = new Set();
  let entries = [];
  try { entries = fs.readdirSync(LIVE_DIR, { withFileTypes: true }); } catch (e) { entries = []; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = decodeProjectDir(e.name);
    if (dir) roots.add(path.join(dir, '.claude', 'skills'));
  }
  const home = os.homedir();
  const homeDev = (() => { try { return fs.statSync(home).dev; } catch (e) { return null; } })();
  for (const lvl1 of subdirs(home)) {
    if (SKIP_HOME_SUBDIRS.has(path.basename(lvl1))) continue;
    if (homeDev !== null && isDifferentDevice(homeDev, lvl1)) continue;
    roots.add(path.join(lvl1, '.claude', 'skills'));
    for (const lvl2 of subdirs(lvl1)) roots.add(path.join(lvl2, '.claude', 'skills'));
  }
  return [...roots];
}

/**
 * Built-in CLI commands. <command-name> carries these alongside skills, and
 * they are a small fixed set, so naming them is safer than inferring: an
 * unknown name stays visible rather than being silently dropped.
 */
const BUILTIN_COMMANDS = new Set([
  'model', 'login', 'logout', 'clear', 'compact', 'mcp', 'permissions', 'agents',
  'help', 'config', 'cost', 'doctor', 'status', 'resume', 'vim', 'terminal-setup',
  'bug', 'release-notes', 'pr-comments', 'add-dir', 'memory', 'export', 'hooks',
  'ide', 'install-github-app', 'migrate-installer', 'upgrade', 'privacy-settings',
  'rewind', 'usage', 'context', 'todos', 'output-style', 'sandbox', 'statusline',
  'feedback', 'rename', 'worktree', 'fast', 'plan', 'exit', 'quit',
]);

const COMMAND_RE = /<command-name>\/?([A-Za-z0-9_:\-/.]+)<\/command-name>/g;

function walk(dir, test, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(full, test, out);
    } else if (e.isFile() && test(e.name)) out.push(full);
  }
  return out;
}

/**
 * Skill names present on disk. The directory holding SKILL.md is the name.
 * Used only to tell a skill from a built-in command, never to filter counts —
 * an invocation of a skill that has since been deleted is still an invocation.
 */
function installedSkills(extraRoots = []) {
  const names = new Set();
  const roots = SKILL_ROOTS.concat(projectSkillRoots(), extraRoots);
  for (const root of roots) {
    for (const f of walk(root, (n) => n === 'SKILL.md')) {
      names.add(path.basename(path.dirname(f)));
    }
  }
  return names;
}

/**
 * Every transcript, live and archived, deduped by its path relative to its
 * root. cclogsall mirrors the live tree, so with a long cleanupPeriodDays the
 * archive is usually a strict subset — counting both would double everything.
 * Live wins because an archived copy can be a snapshot of a shorter session.
 */
function listTranscripts({ archive = true } = {}) {
  const seen = new Map();
  for (const f of walk(LIVE_DIR, (n) => n.endsWith('.jsonl'))) {
    seen.set(path.relative(LIVE_DIR, f), { file: f, gz: false });
  }
  let archived = 0;
  if (archive) {
    for (const f of walk(ARCHIVE_DIR, (n) => n.endsWith('.jsonl.gz'))) {
      const rel = path.relative(ARCHIVE_DIR, f).replace(/\.gz$/, '');
      if (seen.has(rel)) continue;
      seen.set(rel, { file: f, gz: true });
      archived++;
    }
  }
  return { files: [...seen.values()], archiveOnly: archived };
}

function eachLineOfBuffer(buf, cb) {
  let start = 0, nl;
  while ((nl = buf.indexOf(0x0a, start)) !== -1) {
    if (nl > start) cb(buf.toString('utf8', start, nl));
    start = nl + 1;
  }
  if (start < buf.length) cb(buf.toString('utf8', start, buf.length));
}

/**
 * Feed a transcript to cb() one line at a time.
 *
 * Deliberately never materialises the file as a single string: a transcript
 * here is 749 MB, past Node's ~512 MB max string length, and
 * readFileSync(file, 'utf8') throws ERR_STRING_TOO_LONG on it. The first cut
 * of this caught that and returned null, so the biggest session on the machine
 * vanished from every count with no error — the exact silent-zero this tool
 * exists to expose. Reading fixed byte chunks and splitting on newlines keeps
 * memory bounded and size irrelevant.
 *
 * @returns {boolean} false if the file could not be read at all
 */
function forEachLine(t, cb) {
  if (t.gz) {
    try { eachLineOfBuffer(zlib.gunzipSync(fs.readFileSync(t.file)), cb); } catch (e) { return false; }
    return true;
  }
  let fd;
  try { fd = fs.openSync(t.file, 'r'); } catch (e) { return false; }
  try {
    const CHUNK = 1 << 22; // 4 MiB
    const chunk = Buffer.allocUnsafe(CHUNK);
    let carry = Buffer.alloc(0);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, CHUNK, null);
      if (n <= 0) break;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      let start = 0, nl;
      while ((nl = data.indexOf(0x0a, start)) !== -1) {
        if (nl > start) cb(data.toString('utf8', start, nl));
        start = nl + 1;
      }
      // Whatever follows the last newline is kept as bytes, so a multi-byte
      // character split across a chunk boundary is never decoded in halves.
      carry = Buffer.from(data.subarray(start));
    }
    if (carry.length) cb(carry.toString('utf8'));
  } catch (e) {
    return false;
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function blocksOf(entry) {
  const content = (entry.message || {}).content;
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

/**
 * Invocations found in one transcript.
 * @returns {Array<{name: string, source: 'tool'|'typed', ms: number}>}
 */
/**
 * そのセッションの起動元。cli = 人が対話で起動、sdk-cli = `claude -p`(launchd や
 * スクリプト)、claude-code-github-action = CI。
 *
 * これを見ないと、定期実行のスキルを「ユーザーが名前を打って起動した」と
 * 読み違える。実際 draft-replies は 164 セッションが sdk-cli(平日30分おきの
 * launchd ジョブ)で、対話は 10 しかなかったのに、打鍵起動として数えていた。
 */
function entrypointOf(text) {
  let n = 0;
  for (const line of text.split('\n')) {
    if (n++ > 8) break;
    if (!line.includes('entrypoint')) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.entrypoint) return e.entrypoint;
    } catch (err) { /* 次の行へ */ }
  }
  return 'unknown';
}

/**
 * 自動発火は tool_use には出ない。スキルが動いている間、各エントリに
 * `attributionSkill` が付く形で記録される。
 *
 * これを見ないと桁で外す。実測では tool_use が 81 回に対し attributionSkill は
 * 6,492 件あり、deep-research は tool_use 18 に対して 121 セッションで動いていた。
 * ただし 1 セッションで最大 117 エントリ付くので、そのまま数えると起動回数には
 * ならない。**連続した区間を 1 回**として数える。
 */
function invocationsInLine(line, out) {
  if (!line) return;
  // Cheap reject first: the vast majority of lines carry neither shape.
  const maybeTool = line.includes('"Skill"');
  const maybeTyped = line.includes('<command-name>');
  if (!maybeTool && !maybeTyped) return;
  let e;
  try { e = JSON.parse(line); } catch (err) { return; }
  if (!e) return;
  const ms = Date.parse(e.timestamp || '');
  for (const b of blocksOf(e)) {
    if (!b || typeof b !== 'object') continue;
    if (maybeTool && b.type === 'tool_use' && b.name === 'Skill') {
      const name = (b.input || {}).skill;
      if (name) out.push({ name, source: 'tool', ms });
    }
    if (maybeTyped && typeof b.text === 'string') {
      COMMAND_RE.lastIndex = 0;
      let m;
      while ((m = COMMAND_RE.exec(b.text)) !== null) out.push({ name: m[1], source: 'typed', ms });
    }
  }
}

/** Convenience wrapper over invocationsInLine for a whole transcript string. */
function invocationsIn(text) {
  const out = [];
  for (const line of text.split('\n')) invocationsInLine(line, out);
  return out;
}

/** Scan everything into a flat invocation list. */
function scan(opts = {}) {
  const { files, archiveOnly } = listTranscripts(opts);
  const invocations = [];
  // Unreadable files are counted and reported, not swallowed. A tool whose
  // job is to say "this never fired" must never confuse that with "I could
  // not look".
  const unreadable = [];
  for (const t of files) {
    const head = [];
    const mine = [];
    // 1 セッションにつき 1 回と数える。attributionSkill は実行中の全エントリに
    // 付き、他のスキルと交互に現れることもあるので、区間の切れ目では数えられない
    // (そう実装したら実測 35 セッションのものが 668 になった)。
    const autoSeen = new Map();
    if (!forEachLine(t, (line) => {
      if (head.length < 9) head.push(line);
      invocationsInLine(line, mine);
      if (!line.includes('attributionSkill')) return;
      let e;
      try { e = JSON.parse(line); } catch (err) { return; }
      const a = e && typeof e.attributionSkill === 'string' ? e.attributionSkill : null;
      if (a && !autoSeen.has(a)) autoSeen.set(a, Date.parse(e.timestamp || ''));
    })) { unreadable.push(t.file); continue; }
    for (const [nm, ts] of autoSeen) mine.push({ name: nm, source: 'auto', ms: ts });
    const ep = entrypointOf(head.join('\n'));
    for (const iv of mine) iv.entrypoint = ep;
    invocations.push(...mine);
  }
  return { invocations, fileCount: files.length, archiveOnly, unreadable };
}

function monthKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Roll invocations up per name.
 * `known` decides skill vs built-in command; unknown names are kept in their
 * own bucket so a wrong inventory can never silently erase a real count.
 */
function summarize(invocations, known, { from = -Infinity, to = Infinity } = {}) {
  const rows = new Map();
  for (const iv of invocations) {
    // An invocation with no parseable timestamp still counts toward totals; it
    // is only excluded when an explicit window asks for a range it cannot join.
    const dated = Number.isFinite(iv.ms);
    if (dated && (iv.ms < from || iv.ms >= to)) continue;
    if (!dated && (from !== -Infinity || to !== Infinity)) continue;
    let r = rows.get(iv.name);
    if (!r) {
      r = {
        name: iv.name, tool: 0, typed: 0, total: 0, firstMs: null, lastMs: null,
        // onDisk is informational only. A name missing from the inventory is
        // still counted — bundled skills are never on disk, and dropping them
        // is how you conclude a skill "never fires" when it fires daily.
        auto: 0, headless: 0, interactive: 0, ci: 0,
        onDisk: known.has(iv.name),
        isCommand: false, // decided below, once both counts are known
      };
      rows.set(iv.name, r);
    }
    r[iv.source]++;
    r.total++;
    if (iv.entrypoint === 'sdk-cli') r.headless++;
    else if (iv.entrypoint === 'claude-code-github-action') r.ci++;
    else r.interactive++;
    if (dated) {
      if (r.firstMs === null || iv.ms < r.firstMs) r.firstMs = iv.ms;
      if (r.lastMs === null || iv.ms > r.lastMs) r.lastMs = iv.ms;
    }
  }
  // The denylist only applies to typed names. A Skill tool_use is by
  // definition a skill, so a name that ever arrived that way stays one even if
  // it collides with a CLI command — /status the command and a status skill can
  // both exist, and only the typed side is ambiguous.
  for (const r of rows.values()) r.isCommand = r.tool === 0 && BUILTIN_COMMANDS.has(r.name);
  return [...rows.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

/** Per-period counts: [{ key, total, tool, typed, names: Map }] oldest first. */
function byPeriod(invocations, known, keyOf, { skillsOnly = true } = {}) {
  const buckets = new Map();
  for (const iv of invocations) {
    if (!Number.isFinite(iv.ms)) continue;
    if (skillsOnly && iv.source === 'typed' && BUILTIN_COMMANDS.has(iv.name)) continue;
    const k = keyOf(iv.ms);
    let b = buckets.get(k);
    // auto を初期化しないと b[iv.source]++ が undefined++ で NaN になる
    // (summarize()側は同じ3ソースを最初から0初期化していて、ここだけ
    // 抜けていた — レビューで発見)。
    if (!b) { b = { key: k, total: 0, tool: 0, typed: 0, auto: 0, names: new Map() }; buckets.set(k, b); }
    b.total++;
    b[iv.source]++;
    b.names.set(iv.name, (b.names.get(iv.name) || 0) + 1);
  }
  return [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Installed skills with no invocation at all — the point of the exercise. */
function neverFired(rows, known) {
  const fired = new Set(rows.filter((r) => r.total > 0).map((r) => r.name));
  return [...known].filter((n) => !fired.has(n)).sort();
}

module.exports = {
  LIVE_DIR, ARCHIVE_DIR, SKILL_ROOTS, decodeProjectDir, projectSkillRoots,
  BUILTIN_COMMANDS, installedSkills, listTranscripts, invocationsIn, invocationsInLine, forEachLine, scan,
  summarize, byPeriod, neverFired, monthKey, dayKey,
  SKIP_HOME_SUBDIRS, isDifferentDevice, subdirs,
};
