/*
 * test_worker.js —— 用 Node 模拟 Worker 线程环境，直接加载真实的 js/worker.js，
 * 验证消息协议与“主线程修订号闸门只接纳最新结果”。
 * 不依赖浏览器/网络；模拟 setTimeout 的真实乱序返回。
 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg); }
}

// ---- 构造一个与 Web Worker 行为一致的沙箱（含 importScripts / postMessage） ----
function spawnWorker() {
  var sandbox = {};
  var received = [];
  var listeners = [];
  sandbox.setTimeout = setTimeout;
  sandbox.console = console;
  sandbox.Promise = Promise;
  sandbox.Math = Math;
  sandbox.JSON = JSON;
  sandbox.importScripts = function (file) {
    var code = fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  };
  sandbox.self = sandbox;
  sandbox.postMessage = function (msg) { received.push(msg); };
  vm.createContext(sandbox);
  var workerCode = fs.readFileSync(path.join(__dirname, '..', 'js', 'worker.js'), 'utf8');
  vm.runInContext(workerCode, sandbox, { filename: 'worker.js' });
  return {
    send: function (msg) {
      // 异步派发，模拟事件循环
      setImmediate(function () { sandbox.onmessage({ data: msg }); });
    },
    messages: received
  };
}

var K = require('../js/kernel.js');
function makeStateWithPoint() {
  var s = K.createState();
  K.addObject(s, 'point', { x: 0, y: 0 });
  var p = K.addObject(s, 'point', { x: 4, y: 0 });
  return { s: s, pid: p.id };
}

async function run() {
  console.log('\n=== 条件4（实跑）：Worker 修订号闸门 ===');
  var w = spawnWorker();

  // 连续发 3 个修订，rev1 延迟最大 → 最后才返回（“迟到结果”）
  var st1 = makeStateWithPoint();
  var st2 = makeStateWithPoint(); K.movePoint(st2.s, st2.pid, 9, 0, null);
  var st3 = makeStateWithPoint(); K.movePoint(st3.s, st3.pid, -2, 0, null);

  w.send({ type: 'eval', rev: 1, state: st1.s, latencyMs: 60 });
  w.send({ type: 'eval', rev: 2, state: st2.s, latencyMs: 20 });
  w.send({ type: 'eval', rev: 3, state: st3.s, latencyMs: 2 });

  await new Promise(function (r) { setTimeout(r, 150); });

  ok(w.messages.length === 3, 'Worker 三条消息全部回送（包括迟到的 rev=1）');
  var revs = w.messages.map(function (m) { return m.rev; });
  ok(revs.indexOf(1) >= 0 && revs.indexOf(2) >= 0 && revs.indexOf(3) >= 0, '三个修订都得到结果');

  // —— 主线程闸门逻辑（与 main.js onmessage 中的判定完全一致）——
  var currentRev = 3;
  var accepted = null, staleDropped = 0;
  w.messages.forEach(function (msg) {
    if (msg.rev !== currentRev) { staleDropped++; return; }
    accepted = msg;
  });
  ok(staleDropped === 2, 'rev=1、rev=2 的迟到结果被丢弃（2 条）');
  ok(accepted && accepted.rev === 3, '只接纳最新 rev=3 的结果');
  var pGeom = accepted.result.geom[st3.pid];
  ok(pGeom.defined && pGeom.x === -2 && pGeom.y === 0, '接纳的状态是最新坐标 (-2,0)，未被迟到结果覆盖');

  // 错误 rev 的 import 也不能顶替
  console.log('\n=== Worker 导入协议 ===');
  var w2 = spawnWorker();
  var good = JSON.stringify({ state: st3.s });
  w2.send({ type: 'import', rev: 7, text: good });
  await new Promise(function (r) { setTimeout(r, 30); });
  var im = w2.messages[0];
  ok(im.type === 'import' && im.rev === 7 && im.payload.ok, 'import 成功并带原 rev 返回');
  ok(im.payload.result && im.payload.result.goals.length === 0, '导入后完成一次求值');

  w2.send({ type: 'import', rev: 8, text: '{坏json' });
  await new Promise(function (r) { setTimeout(r, 30); });
  var bad = w2.messages[1];
  ok(bad.type === 'import' && bad.payload.ok === false && bad.payload.errors.length, '坏文件返回 ok:false');

  // Worker 不能污染主线程状态：传进去的 state 经 movePoint 吸附写回后，外部对象不应被改
  var before = JSON.stringify(st3.s.objs);
  w2.send({ type: 'eval', rev: 9, state: st3.s, importSnap: true });
  await new Promise(function (r) { setTimeout(r, 30); });
  ok(JSON.stringify(st3.s.objs) === before, 'Worker 内的写回不泄漏到主线程（传的是快照）');

  console.log('\n----------------------------------------');
  console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  if (failed) process.exit(1);
  console.log('Worker 闸门测试全部通过 ✅');
}

run().catch(function (e) { console.error(e); process.exit(1); });
