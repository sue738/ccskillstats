/**
 * Tests for ccskillstats.
 *
 * These assert the properties that have to hold, not the shape of the code
 * that happens to implement them. Every case below is a mistake this tool
 * actually made against the real transcripts before it was fixed.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const S = require('../lib/skills.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
}

const entry = (obj) => JSON.stringify(obj);
const toolCall = (skill, ts) => entry({
  type: 'assistant', timestamp: ts,
  message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill } }] },
});
const typedCall = (name, ts) => entry({
  type: 'user', timestamp: ts,
  message: { content: [{ type: 'text', text: `<command-name>/${name}</command-name>` }] },
});

console.log('ccskillstats');

test('counts the Skill tool shape', () => {
  const iv = S.invocationsIn(toolCall('hunt', '2026-08-01T00:00:00Z'));
  assert.strictEqual(iv.length, 1);
  assert.strictEqual(iv[0].name, 'hunt');
  assert.strictEqual(iv[0].source, 'tool');
});

test('counts the typed /name shape', () => {
  const iv = S.invocationsIn(typedCall('triage-inbox', '2026-08-01T00:00:00Z'));
  assert.strictEqual(iv.length, 1);
  assert.strictEqual(iv[0].source, 'typed');
});

test('a bare mention of the name is not an invocation', () => {
  // deck-builder appeared 1703 times in the real transcripts and had run once.
  const text = [
    entry({ type: 'assistant', timestamp: '2026-08-01T00:00:00Z',
      message: { content: [{ type: 'text', text: 'I will look at the deck-builder skill' }] } }),
    entry({ type: 'assistant', timestamp: '2026-08-01T00:00:00Z',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'grep deck-builder .' } }] } }),
    entry({ type: 'user', timestamp: '2026-08-01T00:00:00Z',
      message: { content: [{ type: 'tool_result', content: 'deck-builder: found' }] } }),
  ].join('\n');
  assert.deepStrictEqual(S.invocationsIn(text), []);
});

test('both shapes are summed and also kept apart', () => {
  const text = [toolCall('x', '2026-08-01T00:00:00Z'), typedCall('x', '2026-08-01T00:00:00Z'),
    typedCall('x', '2026-08-01T00:00:00Z')].join('\n');
  const [row] = S.summarize(S.invocationsIn(text), new Set());
  assert.strictEqual(row.total, 3);
  assert.strictEqual(row.tool, 1);
  assert.strictEqual(row.typed, 2);
});

test('a skill missing from the on-disk inventory is still counted', () => {
  // Bundled skills ship inside the CLI and have no SKILL.md. Filtering counts
  // by the inventory reported 2 of 23 real skills and called the rest dead.
  const rows = S.summarize(S.invocationsIn(toolCall('deep-research', '2026-08-01T00:00:00Z')), new Set());
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].total, 1);
  assert.strictEqual(rows[0].onDisk, false);
});

test('a typed built-in command is flagged, a Skill call of the same name is not', () => {
  const typed = S.summarize(S.invocationsIn(typedCall('status', '2026-08-01T00:00:00Z')), new Set());
  assert.strictEqual(typed[0].isCommand, true);
  const tool = S.summarize(S.invocationsIn(toolCall('status', '2026-08-01T00:00:00Z')), new Set());
  assert.strictEqual(tool[0].isCommand, false, 'a Skill tool_use is a skill by definition');
});

test('a file past the max string length is read, not silently skipped', () => {
  // A 749 MB transcript threw ERR_STRING_TOO_LONG from readFileSync(f, "utf8")
  // and the catch dropped the whole file. Simulated here with a long line so
  // the chunk boundary logic is exercised without writing 749 MB to disk.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccskillstats-'));
  const file = path.join(dir, 'big.jsonl');
  const filler = entry({ type: 'assistant', timestamp: '2026-08-01T00:00:00Z',
    message: { content: [{ type: 'text', text: 'x'.repeat(200000) }] } });
  const lines = [];
  for (let i = 0; i < 60; i++) lines.push(filler);          // > 4 MiB, several chunks
  lines.push(toolCall('needle', '2026-08-01T00:00:00Z'));   // last line, after many boundaries
  fs.writeFileSync(file, lines.join('\n'));
  const out = [];
  const ok = S.forEachLine({ file, gz: false }, (l) => S.invocationsInLine(l, out));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(ok, true);
  assert.strictEqual(out.length, 1, 'the invocation past the chunk boundaries was lost');
  assert.strictEqual(out[0].name, 'needle');
});

test('reading never depends on whole-file utf8 decoding', () => {
  // The chunk test above passes even if forEachLine goes back to
  // readFileSync(file, "utf8") — its fixture is far under the 512 MB limit.
  // This encodes the property directly: make whole-file utf8 decoding throw
  // the way it does on the real 749 MB transcript, and the read must still
  // succeed. Guards the regression rather than the fixture.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccskillstats-'));
  const file = path.join(dir, 'x.jsonl');
  fs.writeFileSync(file, toolCall('needle', '2026-08-01T00:00:00Z'));
  const real = fs.readFileSync;
  fs.readFileSync = (p, opts) => {
    const enc = typeof opts === 'string' ? opts : (opts && opts.encoding);
    if (enc) {
      const e = new Error('Cannot create a string longer than 0x1fffffe8 characters');
      e.code = 'ERR_STRING_TOO_LONG';
      throw e;
    }
    return real(p, opts);
  };
  let out = [], ok;
  try {
    ok = S.forEachLine({ file, gz: false }, (l) => S.invocationsInLine(l, out));
  } finally {
    fs.readFileSync = real;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.strictEqual(ok, true, 'fell back to whole-file utf8 decoding');
  assert.strictEqual(out.length, 1);
});

test('multi-byte characters spanning a chunk boundary survive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccskillstats-'));
  const file = path.join(dir, 'utf8.jsonl');
  // Pad with Japanese text so the 4 MiB boundary lands mid-character.
  const pad = entry({ type: 'assistant', timestamp: '2026-08-01T00:00:00Z',
    message: { content: [{ type: 'text', text: 'あ'.repeat(700000) }] } });
  fs.writeFileSync(file, [pad, toolCall('こんにちは', '2026-08-01T00:00:00Z')].join('\n'));
  const out = [];
  S.forEachLine({ file, gz: false }, (l) => S.invocationsInLine(l, out));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'こんにちは');
});

test('gzipped archive transcripts are read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccskillstats-'));
  const file = path.join(dir, 'old.jsonl.gz');
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(toolCall('archived', '2026-01-01T00:00:00Z'))));
  const out = [];
  const ok = S.forEachLine({ file, gz: true }, (l) => S.invocationsInLine(l, out));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(ok, true);
  assert.strictEqual(out[0].name, 'archived');
});

test('an unreadable file is reported, never counted as no invocations', () => {
  const ok = S.forEachLine({ file: '/nonexistent/nope.jsonl', gz: false }, () => {});
  assert.strictEqual(ok, false, 'must be distinguishable from an empty transcript');
});

test('a window excludes what falls outside it', () => {
  const text = [toolCall('a', '2026-01-01T00:00:00Z'), toolCall('a', '2026-08-01T00:00:00Z')].join('\n');
  const iv = S.invocationsIn(text);
  assert.strictEqual(S.summarize(iv, new Set())[0].total, 2);
  const recent = S.summarize(iv, new Set(), { from: Date.parse('2026-07-01T00:00:00Z') });
  assert.strictEqual(recent[0].total, 1);
});

test('byPeriod does not corrupt a bucket that has an auto-fired invocation', () => {
  // auto はスキャン側(scan())でのみ合成される特殊ソースで、単純な
  // invocationsIn() 経由では作れない — byPeriod が受け取る形をそのまま
  // 手で組む。バケット初期値に auto が無いと b.auto++ が NaN になっていた
  // (レビューで発見)。
  const iv = [
    { name: 'deep-research', source: 'auto', ms: Date.parse('2026-08-05T10:00:00Z') },
    { name: 'deep-research', source: 'tool', ms: Date.parse('2026-08-05T11:00:00Z') },
  ];
  const [bucket] = S.byPeriod(iv, new Set(), S.dayKey);
  assert.strictEqual(bucket.total, 2);
  assert.strictEqual(bucket.tool, 1);
  assert.strictEqual(bucket.typed, 0);
  assert.ok(Number.isFinite(bucket.auto), 'auto must be a real number, not NaN');
  assert.strictEqual(bucket.auto, 1);
});

test('daily and monthly bucket the same invocations consistently', () => {
  const text = [toolCall('a', '2026-08-01T10:00:00Z'), toolCall('a', '2026-08-01T20:00:00Z'),
    toolCall('a', '2026-09-02T10:00:00Z')].join('\n');
  const iv = S.invocationsIn(text);
  const days = S.byPeriod(iv, new Set(), S.dayKey);
  const months = S.byPeriod(iv, new Set(), S.monthKey);
  const sum = (rs) => rs.reduce((a, r) => a + r.total, 0);
  assert.strictEqual(sum(days), 3);
  assert.strictEqual(sum(months), sum(days), 'the two views must agree on the total');
  assert.ok(months.length <= days.length);
});

test('a transcript directory name resolves back to its checkout', () => {
  // Claude Code names the directory after the cwd with every '/' turned into
  // '-', which is ambiguous when a real directory contains '-' itself. The
  // longest existing child has to win, or lab-worktrees becomes lab/worktrees.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccskillstats-'));
  const real = fs.realpathSync(dir);
  fs.mkdirSync(path.join(real, 'my-app', 'sub'), { recursive: true });
  const encoded = path.join(real, 'my-app', 'sub').split(path.sep).join('-');
  assert.strictEqual(S.decodeProjectDir(encoded), path.join(real, 'my-app', 'sub'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unresolvable transcript directory name is skipped, not guessed', () => {
  assert.strictEqual(S.decodeProjectDir('-no-such-path-anywhere-at-all-xyzzy'), null);
  assert.strictEqual(S.decodeProjectDir('not-absolute'), null);
});

test('never-fired lists installed skills with no invocation', () => {
  const known = new Set(['ran', 'never']);
  const rows = S.summarize(S.invocationsIn(toolCall('ran', '2026-08-01T00:00:00Z')), known);
  assert.deepStrictEqual(S.neverFired(rows, known), ['never']);
});

test('SKIP_HOME_SUBDIRS names the folders known to hang on readdirSync', () => {
  // 実測: ~/Desktop への readdirSync が iCloud「デスクトップと書類」同期の
  // デーモン応答待ちで無期限にブロックした(1プロセスが1時間47分ハング)。
  // この一覧が空/欠けると同じハングが再発する — 回帰を防ぐため列挙自体を固定する。
  for (const name of ['Desktop', 'Documents', 'Downloads']) {
    assert.ok(S.SKIP_HOME_SUBDIRS.has(name), `${name} should be in the skip list`);
  }
});

test('isDifferentDevice: same filesystem returns false', () => {
  // ホームディレクトリ配下の通常のチェックアウトは同じデバイス上にあり、
  // 除外されてはいけない(除外しすぎるとチェックアウトを見失う)。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccskillstats-dev-'));
  const homeDev = fs.statSync(os.tmpdir()).dev;
  assert.strictEqual(S.isDifferentDevice(homeDev, dir), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isDifferentDevice: nonexistent path does not throw and is not treated as different', () => {
  assert.strictEqual(S.isDifferentDevice(0, '/no/such/path/at/all/xyzzy'), false);
});

test('CLI: a malformed --days / --top exits 2 instead of printing nothing', () => {
  const { spawnSync } = require('child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccskillstats-cli-'));
  const proj = path.join(home, '.claude', 'projects', '-p-a');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 's.jsonl'), toolCall('hunt', new Date(Date.now() - 3600000).toISOString()) + '\n');
  const bin = path.join(__dirname, '..', 'bin', 'ccskillstats.js');
  const run = (...args) => spawnSync('node', [bin, '--no-archive', ...args], { encoding: 'utf8', env: Object.assign({}, process.env, { HOME: home, CCSKILLSTATS_LANG: 'en' }) });
  try {
    for (const args of [['--top', 'abc'], ['--top', '-1'], ['--top', '0'], ['--days', '-3'], ['--days', 'abc']]) {
      assert.strictEqual(run(...args).status, 2, `${args.join(' ')} should exit 2`);
    }
    const good = run('--top', '5', '--days', '7');
    assert.strictEqual(good.status, 0);
    assert.ok(good.stdout.includes('hunt'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed`);
