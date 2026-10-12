#!/usr/bin/env node
'use strict';
/**
 * 移动版同步资产的门禁。
 *
 * 移动版不重写拼页算法，也不另抄一份媒体名单 —— 那些东西都由
 * `npm run mobile:sync` 从桌面端源码生成后落到 android-app 的 assets 下。
 * 于是有一个人人都能犯、而且很难发现的错：**改了桌面端源码，忘了重新同步**。
 *
 * 那种错的表现是：桌面端修好了，手机端还是老行为，而且没有任何报错。
 * 本脚本就是靠 sha256 把「源变了」和「产物没跟着变」这两件事分开：
 * 源与 SYNC.json 里记的不一致 → 提示重新同步；
 * 产物与 SYNC.json 里记的不一致 → 提示产物被手工改过（那也是错的，
 * 因为下次同步会把它覆盖掉）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SYNC = path.join(ROOT, 'android-app', 'app', 'src', 'main', 'assets', 'SYNC.json');

function sha256(file) {
  if (!fs.existsSync(file)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  if (!fs.existsSync(SYNC)) {
    console.error('✗ 找不到 SYNC.json —— 移动版资产还没生成过');
    console.error('  先跑：npm run mobile:sync');
    process.exit(1);
  }

  const meta = JSON.parse(fs.readFileSync(SYNC, 'utf8'));
  let bad = 0;

  console.log('桌面端源文件');
  console.log('─'.repeat(66));
  for (const item of meta.generatedFrom || []) {
    const file = path.join(ROOT, item.source);
    const actual = sha256(file);
    if (actual === null) {
      console.log(`  ✗ ${item.source}  文件不存在`);
      bad++;
      continue;
    }
    if (actual !== item.sha256) {
      // 这是本脚本要抓的主要错误：源改了但没同步。
      console.log(`  ✗ ${item.source}  已改动，产物没跟着同步`);
      bad++;
    } else {
      console.log(`  ✓ ${item.source}`);
    }
  }

  console.log('');
  console.log('移动版产物');
  console.log('─'.repeat(66));
  for (const item of meta.artifacts || []) {
    const file = path.join(ROOT, item.file);
    const actual = sha256(file);
    const name = item.file.replace(/^android-app\/app\/src\/main\//, '');
    if (actual === null) {
      console.log(`  ✗ ${name}  产物缺失`);
      bad++;
      continue;
    }
    const size = fs.statSync(file).size;
    if (actual !== item.sha256) {
      // 产物被手工改过：下次同步会被覆盖掉，所以也是错的。
      console.log(`  ✗ ${name}  与记录不符（可能被手工改过）`);
      bad++;
    } else if (size !== item.bytes) {
      console.log(`  ✗ ${name}  字节数与记录不符：${size} ≠ ${item.bytes}`);
      bad++;
    } else {
      console.log(`  ✓ ${name}  ${fmtBytes(size)}`);
    }
  }

  console.log('');
  if (bad > 0) {
    console.log(`✗ ${bad} 项不一致。`);
    console.log('');
    console.log('  如果你改了桌面端源码 —— 跑 npm run mobile:sync 重新同步。');
    console.log('  如果你只改了手机端 assets 下的文件 —— 那是错的：');
    console.log('    那些文件是生成物，下次同步会被覆盖。要改请改桌面端源，然后重新同步。');
    process.exit(1);
  }
  console.log('✓ 桌面端与移动版资产一致。');
}

function fmtBytes(n) {
  return n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
}

main();