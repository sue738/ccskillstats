#!/usr/bin/env node
/**
 * ccskillstats — which of your skills actually fire?
 *
 *   ccskillstats             ranked table
 *   ccskillstats --daily     per day
 *   ccskillstats --monthly   per month
 *   ccskillstats --unused    installed but never invoked
 *   ccskillstats --xbar      one line + a dropdown, for xbar
 */
'use strict';

const S = require('../lib/skills.js');

const JA = /^ja/i.test(process.env.CCSKILLSTATS_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '');
const L = (en, ja) => (JA ? ja : en);

const HELP = `ccskillstats — which of your skills actually fire?

Usage:
  ccskillstats [view] [options]

Views:
  (default)        ranked table
  --daily          per day
  --monthly        per month
  --unused         installed skills with no invocation on record
  --xbar           one status line plus a dropdown of everything
  --json           machine-readable

Options:
  --days N         only the last N days
  --top N          rows to show (default 15; --all for everything)
  --all            no row limit
  --no-archive     skip ~/.cclogsall, read only live transcripts
  --commands       include built-in slash commands (/model, /login, …)

Counts both shapes an invocation is written in: the model calling the Skill
tool, and you typing /name. They are shown separately because they mean
different things — the first is your description matching what you wrote,
the second is you already knowing the name.`;

function parseArgs(argv) {
  const o = { top: 15 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--daily') o.daily = true;
    else if (a === '--monthly') o.monthly = true;
    else if (a === '--unused') o.unused = true;
    else if (a === '--xbar') o.xbar = true;
    else if (a === '--json') o.json = true;
    else if (a === '--all') o.top = Infinity;
    else if (a === '--top') o.top = +argv[++i];
    else if (a === '--days') o.days = +argv[++i];
    else if (a === '--no-archive') o.archive = false;
    else if (a === '--commands') o.commands = true;
    else if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (a.startsWith('-')) {
      // 知らないフラグを黙って捨てると、typo(--dyas 1)が「全期間の集計」として
      // 成功し、間違った数字を正しい答えだと思って読むことになる(初見レビューで
      // 実際に踏まれた)。知らないものは受け取らない。
      console.error(L(`unknown option: ${a}`, `知らないオプション: ${a}`));
      console.error(L('try --help', '--help を参照してください'));
      process.exit(2);
    }
  }
  // A bad value used to be read as "nothing": --top abc printed an empty
  // table, --days -3 an empty result, --days abc silently meant all history.
  if (o.days != null && !(Number.isFinite(o.days) && o.days > 0)) usageError(L('--days: expected a positive number', '--days: 正の数で指定してください'));
  if (o.top !== Infinity && !(Number.isInteger(o.top) && o.top > 0)) usageError(L('--top: expected a positive whole number', '--top: 正の整数で指定してください'));
  return o;
}

function usageError(msg) { console.error(msg); process.exit(2); }

function pad(s, n) { return String(s) + ' '.repeat(Math.max(0, n - [...String(s)].length)); }
function padL(s, n) { return ' '.repeat(Math.max(0, n - String(s).length)) + String(s); }

function bar(frac, width) {
  const full = Math.round(frac * width);
  return '█'.repeat(full) + '·'.repeat(Math.max(0, width - full));
}

function table(headers, rows, aligns) {
  const widths = headers.map((h, i) => Math.max([...h].length, ...rows.map((r) => [...String(r[i])].length)));
  const line = (cells) => cells.map((c, i) => (aligns[i] === 'r' ? padL(c, widths[i]) : pad(c, widths[i]))).join('  ');
  const out = [line(headers), widths.map((w) => '─'.repeat(w)).join('  ')];
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

function ageDays(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = Math.floor((Date.now() - ms) / 86400000);
  return d <= 0 ? L('today', '今日') : L(`${d}d`, `${d}日前`);
}

function main() {
  const o = parseArgs(process.argv);
  const known = S.installedSkills();
  const { invocations, fileCount, archiveOnly, unreadable } = S.scan({ archive: o.archive !== false });

  const window = {};
  if (o.days) window.from = Date.now() - o.days * 86400000;
  const all = S.summarize(invocations, known, window);
  const rows = o.commands ? all : all.filter((r) => !r.isCommand);
  // unreadable が非0のときだけ足す — 普段は0件で、この注記自体が「今回は
  // 何かを読めなかった」という異常のシグナルになる(黙って落とすと
  // 気づけない、とレビューで指摘された点)。
  const unreadableNote = unreadable.length
    ? L(` · ${unreadable.length} file(s) unreadable`, ` · 読めなかった ${unreadable.length} 件`)
    : '';
  const scopeNote = L(
    `  scanned ${fileCount} transcripts (${archiveOnly} archive-only)  ·  Skill-tool + typed /name${unreadableNote}`,
    `  走査 ${fileCount} transcript (アーカイブ固有 ${archiveOnly})  ·  Skill ツール + 打鍵 /名前${unreadableNote}`);

  // --daily/--monthly の期間集計は json でもテキスト表でも同じ S.byPeriod() を
  // 通す。別計算を作ると片方だけ直した時に数字がズレる(このセッションの教訓)。
  // --days N を月バケットに当てるとき、p.key("2026-08")をDate.parseすると
  // 月の"開始"になる。今月が --days 7 より前に始まっていれば開始日だけで
  // 弾かれ、今月分がまるごと消える(レビューで発見)。月の"終わり"で比較する。
  const periodEndMs = (key) => o.monthly
    ? Date.parse(key) + 32 * 86400000 // 月末を跨ぐ余裕を持たせた上限、月初との比較にしか使わない
    : Date.parse(key) + 86400000;
  const periods = (o.daily || o.monthly)
    ? S.byPeriod(invocations, known, o.monthly ? S.monthKey : S.dayKey, { skillsOnly: !o.commands })
      .filter((p) => !window.from || periodEndMs(p.key) >= window.from)
    : null;

  if (o.json) {
    if (periods) {
      return console.log(JSON.stringify({
        scannedFiles: fileCount, archiveOnly, unreadable: unreadable.length, days: o.days || null,
        period: o.monthly ? 'monthly' : 'daily',
        periods: periods.map((p) => ({ key: p.key, total: p.total, tool: p.tool, typed: p.typed, auto: p.auto })),
      }, null, 2));
    }
    return console.log(JSON.stringify({
      scannedFiles: fileCount, archiveOnly, days: o.days || null,
      skills: rows, unused: S.neverFired(all, known),
    }, null, 2));
  }

  // ---- xbar: one line, everything else behind the dropdown ----
  if (o.xbar) {
    const top = rows.slice(0, 3).map((r) => `${r.name} ${r.total}`).join(' · ');
    console.log(top ? `🧩 ${top}` : '🧩 —');
    console.log('---');
    const runs = rows.reduce((a, r) => a + r.total, 0);
    console.log(`${rows.length} skills fired · ${runs} invocations | size=11 color=#888888`);
    console.log('---');
    for (const r of rows) {
      console.log(`${pad(r.name, 26)} ${padL(r.total, 4)}  (tool ${r.tool} / typed ${r.typed})  ${ageDays(r.lastMs)} | font=Menlo size=12`);
    }
    const unused = S.neverFired(all, known);
    if (unused.length) {
      console.log('---');
      console.log(`never fired (${unused.length}) | size=11 color=#888888`);
      for (const n of unused) console.log(`${n} | font=Menlo size=12 color=#aa5555`);
    }
    console.log('---');
    console.log('Refresh | refresh=true');
    return;
  }

  // ---- installed but never invoked ----
  if (o.unused) {
    const unused = S.neverFired(all, known);
    console.log(L(`ccskillstats — never fired (${unused.length} of ${known.size} installed)`,
      `ccskillstats — 未発火 (インストール済み ${known.size} 件中 ${unused.length} 件)`));
    for (const n of unused) console.log(`  ${n}`);
    console.log(L('\n  A skill that never fires is usually a description problem, not a dead feature.',
      '\n  発火しないスキルは、機能が不要なのではなく description が合っていないことが多い。'));
    console.log(scopeNote);
    return;
  }

  // ---- per period ----
  if (periods) {
    const peak = Math.max(1, ...periods.map((p) => p.total));
    const body = periods.map((p) => {
      const top = [...p.names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([n, c]) => `${n}×${c}`).join(', ');
      return [p.key, String(p.total), String(p.tool), String(p.typed), bar(p.total / peak, 12), top];
    });
    console.log(L(`ccskillstats — ${o.monthly ? 'monthly' : 'daily'}`, `ccskillstats — ${o.monthly ? '月別' : '日別'}`));
    console.log(table(
      [L(o.monthly ? 'month' : 'date', o.monthly ? '月' : '日付'), L('runs', '回数'), L('tool', 'ツール'), L('typed', '打鍵'), '', L('top', '上位')],
      body, ['l', 'r', 'r', 'r', 'l', 'l']));
    console.log(scopeNote);
    return;
  }

  // ---- default: ranked ----
  const shown = rows.slice(0, o.top);
  const peak = Math.max(1, ...rows.map((r) => r.total));
  const body = shown.map((r) => [
    r.name, String(r.total), String(r.interactive), String(r.headless), bar(r.total / peak, 12), ageDays(r.lastMs),
  ]);
  console.log(L('ccskillstats — what actually fired', 'ccskillstats — 実際に発火したもの'));
  console.log(table(
    [L('skill', 'スキル'), L('runs', '回数'), L('interactive', '対話'), L('scheduled', '自動実行'), '', L('last', '最終')],
    body, ['l', 'r', 'r', 'r', 'l', 'r']));
  if (rows.length > shown.length) {
    console.log(L(`  … ${rows.length - shown.length} more (--all)`, `  … 他 ${rows.length - shown.length} 件 (--all)`));
  }
  const unused = S.neverFired(all, known);
  if (unused.length) {
    console.log(L(`\n  ${unused.length} of ${known.size} installed skills never fired (ccskillstats --unused)`,
      `\n  インストール済み ${known.size} 件のうち ${unused.length} 件は未発火 (ccskillstats --unused)`));
  }
  console.log(scopeNote);
}

main();
