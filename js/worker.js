/*
 * worker.js —— 几何内核 Web Worker
 * 消息协议（主线程 → Worker）：
 *   {type: 'eval',   rev, state, importSnap?, latencyMs?}
 *   {type: 'import', rev, text}
 * Worker → 主线程：
 *   {type: 'eval',   rev, result}
 *   {type: 'import', rev, payload:{ok,errors,warnings,result,state}}
 *   {type: 'error',  rev, message}
 *
 * Worker 不取消已在进行的计算：它可能“迟到”，由主线程的修订号闸门丢弃，
 * 这样可显式验证“迟到结果不得覆盖新状态”。
 */
'use strict';
try {
  if (typeof Kernel === 'undefined' && typeof self !== 'undefined' && self.importScripts) {
    importScripts('kernel.js');
  }
} catch (e) {
  (self || globalThis).postMessage({ type: 'boot-error', message: String(e && e.message || e) });
}

(function (scope) {
  var Kernel = scope.Kernel;

  function sleep(ms) {
    if (!ms) return Promise.resolve();
    return new Promise(function (res) { setTimeout(res, ms); });
  }

  scope.onmessage = function (ev) {
    var msg = ev.data;
    if (!msg || !msg.type) return;
    sleep(msg.latencyMs || 0).then(function () {
      try {
        if (msg.type === 'eval') {
          var result = Kernel.evaluate(msg.state, { rev: msg.rev, importSnap: !!msg.importSnap });
          scope.postMessage({ type: 'eval', rev: msg.rev, result: result });
        } else if (msg.type === 'import') {
          var payload = Kernel.importJSON(msg.text);
          if (payload.ok) {
            payload.state = payload.state; // 已归一化状态
          }
          scope.postMessage({ type: 'import', rev: msg.rev, payload: payload });
        } else if (msg.type === 'ping') {
          scope.postMessage({ type: 'pong', rev: msg.rev });
        }
      } catch (err) {
        scope.postMessage({ type: 'error', rev: msg.rev, message: String(err && err.stack || err) });
      }
    });
  };
})(typeof self !== 'undefined' ? self : globalThis);
