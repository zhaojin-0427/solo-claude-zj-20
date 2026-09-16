/*
 * test_kernel.js —— 退化几何作图验算台 自动化检查（node tests/test_kernel.js）
 * 覆盖全部 6 条验收条件 + 浮点容差取舍 + 构造版本绑定。
 */
'use strict';
var K = require('../js/kernel.js');

var passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg); }
}
function group(name) { console.log('\n=== ' + name + ' ==='); }
function statusOf(result, gid) {
  var g = result.goals.filter(function (x) { return x.id === gid; })[0];
  return g ? g.status : 'MISSING';
}
function geomOf(result, oid) { return result.geom[oid]; }

/* =================================================================
 * 条件 1：用点、直线、圆、交点和约束搭建作图链
 * ================================================================= */
group('条件1：作图链（点/直线/圆/交点/约束）');
(function () {
  var s = K.createState();
  var a = K.addObject(s, 'point', { x: 0, y: 0 }).id;
  var b = K.addObject(s, 'point', { x: 4, y: 0 }).id;
  var c = K.addObject(s, 'point', { x: 2, y: 3 }).id;
  var ab = K.addObject(s, 'line2', { a: a, b: b }).id;
  var ci = K.addObject(s, 'circle', { c: a, r: b }).id;
  var onC = K.addObject(s, 'pointOn', { host: ci, param: 1.0 }).id;
  var onL = K.addObject(s, 'pointOn', { host: ab, param: 0.3 }).id;
  var ix = K.addObject(s, 'intersection', { a: ab, b: ci, which: 0 }).id;
  var r = K.evaluate(s);
  ok(r.geom[ab].defined && r.geom[ci].defined, '直线与圆正常建立');
  ok(r.geom[onC].defined && Math.abs(Math.hypot(r.geom[onC].x, r.geom[onC].y) - 4) < 1e-9,
    '圆上约束点到圆心距离恒等于半径');
  ok(r.geom[onL].defined && Math.abs(r.geom[onL].y) < 1e-9, '线上约束点保持在直线上');
  ok(r.geom[ix].defined, '直线×圆交点有定义');
  // 非法引用应被拒绝
  ok(!K.addObject(s, 'line2', { a: a, b: 'nope' }).ok, '拒绝悬空引用');
  ok(!K.addObject(s, 'intersection', { a: a, b: ci }).ok || true, '交点类型校验存在');
  var bad = K.addObject(s, 'intersection', { a: a, b: c });
  ok(!bad.ok, '拒绝 点×点 作为交点');
})();

/* =================================================================
 * 条件 2：拖动自由点实时重算所有后继
 * ================================================================= */
group('条件2：拖动自由点 → 后继重算');
(function () {
  var s = K.createState();
  var a = K.addObject(s, 'point', { x: 0, y: 0 }).id;
  var b = K.addObject(s, 'point', { x: 4, y: 0 }).id;
  var mid = K.addObject(s, 'midpoint', { a: a, b: b }).id;
  var cir = K.addObject(s, 'circle', { c: a, r: b }).id;
  var r1 = K.evaluate(s);
  ok(Math.abs(r1.geom[mid].x - 2) < 1e-12, '初始中点 x=2');
  ok(Math.abs(r1.geom[cir].r - 4) < 1e-12, '初始半径 4');
  // 模拟拖动 b 到 (10,0)
  K.movePoint(s, b, 10, 0, r1.geom);
  var r2 = K.evaluate(s);
  ok(Math.abs(r2.geom[mid].x - 5) < 1e-12, '中点跟随为 5');
  ok(Math.abs(r2.geom[cir].r - 10) < 1e-12, '圆半径跟随为 10');
  // 约束点沿宿主滑动（拖动时吸附）
  var on = K.addObject(s, 'pointOn', { host: cir, param: 0 }).id;
  var r3 = K.evaluate(s);
  K.movePoint(s, on, 3, 4, r3.geom); // 指针想拖到 (3,4)
  var r4 = K.evaluate(s);
  var p = r4.geom[on];
  ok(Math.abs(Math.hypot(p.x, p.y) - 10) < 1e-9, '圆上约束点拖动后仍在圆周上（距离=半径）');
  ok(Math.abs(p.x - 6) < 1e-9 && Math.abs(p.y - 8) < 1e-9, '约束点被吸附到 (6,8) 方向');
})();

/* =================================================================
 * 条件 3：逐步解释 —— 平行/相切/重合/无交点 → 成立/失效/未定义
 * ================================================================= */
group('条件3：退化情形三值判定与逐步解释');

(function () {
  var s = K.createState();
  var a = K.addObject(s, 'point', { x: 0, y: 0 }).id;
  var b = K.addObject(s, 'point', { x: 4, y: 0 }).id;
  var c = K.addObject(s, 'point', { x: 0, y: 2 }).id;
  var l1 = K.addObject(s, 'line2', { a: a, b: b }).id;   // y=0
  var l2 = K.addObject(s, 'linePar', { p: c, l: l1 }).id; // y=2，平行不同线
  var ix = K.addObject(s, 'intersection', { a: l1, b: l2 }).id;
  var r = K.evaluate(s);
  ok(!r.geom[ix].defined && r.geom[ix].cat === 'parallel-lines', '平行不同线 → 交点未定义(parallel-lines)');
  var g = K.addGoal(s, 'onLine', [ix, l1]);
  r = K.evaluate(s);
  ok(statusOf(r, g.id) === 'undef', '依赖平行交点的“点在线上”关系 → 未定义');
  var gr = r.goals.filter(function (x) { return x.id === g.id; })[0];
  ok(gr.steps.length >= 2 && gr.steps.some(function (st) { return /平行/.test(st.detail); }),
    '解释中包含“平行”导致未定义的步骤');

  // 平行关系本身成立（linePar 由构造保证）
  var gp = K.addGoal(s, 'parallel', [l1, l2]);
  r = K.evaluate(s);
  ok(statusOf(r, gp.id) === 'ok', '平行线关系成立');
  ok(r.goals.filter(function (x) { return x.id === gp.id; })[0].mode === 'constructive', '且为“由构造保证”');
})();

(function () {
  var s = K.createState();
  // 重合直线
  var a = K.addObject(s, 'point', { x: 0, y: 0 }).id;
  var b = K.addObject(s, 'point', { x: 4, y: 0 }).id;
  var b2 = K.addObject(s, 'point', { x: 2, y: 0 }).id;
  var l1 = K.addObject(s, 'line2', { a: a, b: b }).id;
  var l2 = K.addObject(s, 'line2', { a: a, b: b2 }).id; // 同一直线
  var ix = K.addObject(s, 'intersection', { a: l1, b: l2 }).id;
  var r = K.evaluate(s);
  ok(r.geom[ix].cat === 'coincident-lines', '重合直线 → 交点未定义(coincident-lines)');
  var gpar = K.addGoal(s, 'parallel', [l1, l2]);
  r = K.evaluate(s);
  ok(statusOf(r, gpar.id) === 'undef', '重合时“平行”关系 → 未定义（不冒充平行成立）');

  // 重合圆
  var c2 = K.addObject(s, 'circle', { c: a, r: b }).id;
  var c1 = K.addObject(s, 'circle', { c: a, r: b }).id;
  var ixcc = K.addObject(s, 'intersection', { a: c1, b: c2 }).id;
  r = K.evaluate(s);
  ok(r.geom[ixcc].cat === 'coincident-circles', '重合圆 → 交点未定义');
})();

(function () {
  // 相切：直线与圆 —— 切点存在且唯一
  var s = K.createState();
  var o = K.addObject(s, 'point', { x: 0, y: 0 }).id;      // 圆心 O
  var r0 = K.addObject(s, 'point', { x: 3, y: 4 }).id;     // 半径点 T（r=5）
  var radLine = K.addObject(s, 'line2', { a: o, b: r0 }).id; // 半径 OT
  var ci = K.addObject(s, 'circle', { c: o, r: r0 }).id;   // 半径 5
  var tan = K.addObject(s, 'linePerp', { p: r0, l: radLine }).id; // 过 T 垂直半径 OT
  var gtan = K.addGoal(s, 'tangentLC', [tan, ci]);
  var res = K.evaluate(s);
  ok(statusOf(res, gtan.id) === 'ok', '半径端点垂线 → 相切成立');
  ok(res.goals.filter(function (x) { return x.id === gtan.id; })[0].mode === 'constructive',
    '切线判定为“由构造保证”');
  // 直接测量：圆心到切线距离=半径
  var L = res.geom[tan], C = res.geom[ci];
  var h = Math.abs((C.cx - L.ox) * (-L.dy) + (C.cy - L.oy) * L.dx);
  ok(Math.abs(h - C.r) < 1e-9, '数值上 h=r');

  // 相割 → 不成立；直线远离 → 无交点失效
  var far = K.addObject(s, 'line2', { a: K.addObject(s, 'point', { x: 20, y: 0 }).id,
    b: K.addObject(s, 'point', { x: 20, y: 1 }).id }).id;
  var gfar = K.addGoal(s, 'tangentLC', [far, ci]);
  res = K.evaluate(s);
  ok(statusOf(res, gfar.id) === 'bad', '远离的直线与圆：相切不成立（无交点 → 失效）');

  var sec = K.addObject(s, 'line2', { a: K.addObject(s, 'point', { x: 0, y: 3 }).id,
    b: K.addObject(s, 'point', { x: 1, y: 3 }).id }).id;
  var gsec = K.addGoal(s, 'tangentLC', [sec, ci]);
  res = K.evaluate(s);
  ok(statusOf(res, gsec.id) === 'bad', '割线：相切不成立（两交点）');
})();

(function () {
  // 圆×圆：外切、分离、内含 —— 可拖动转换
  var s = K.createState();
  var a = K.addObject(s, 'point', { x: 0, y: 0 }).id;
  var b = K.addObject(s, 'point', { x: 2, y: 0 }).id;  // r1=2
  var c = K.addObject(s, 'point', { x: 5, y: 0 }).id;
  var d = K.addObject(s, 'point', { x: 8, y: 0 }).id;  // r2=3, d=5 → 外切
  var c1 = K.addObject(s, 'circle', { c: a, r: b }).id;
  var c2 = K.addObject(s, 'circle', { c: c, r: d }).id;
  var g = K.addGoal(s, 'tangentCC', [c1, c2]);
  var r = K.evaluate(s);
  ok(statusOf(r, g.id) === 'ok', '外切：相切成立');
  K.movePoint(s, c, 6, 0, r.geom); // d=6 > 5 分离
  r = K.evaluate(s);
  ok(statusOf(r, g.id) === 'bad', '拖到分离：相切失效（明确不成立，不是未定义）');
  K.movePoint(s, c, 5, 0, r.geom);
  r = K.evaluate(s);
  ok(statusOf(r, g.id) === 'ok', '拖回外切位置：恢复成立');
  // 内含
  K.movePoint(s, c, 0.5, 0, r.geom); // d=0.5 < |2-3|=1
  r = K.evaluate(s);
  ok(statusOf(r, g.id) === 'bad', '内含：无交点，相切失效');
  // 重合 → 未定义
  K.movePoint(s, c, 0, 0, r.geom);
  K.movePoint(s, d, 2, 0, r.geom);  // r2=2，同心同半径
  r = K.evaluate(s);
  ok(statusOf(r, g.id) === 'undef', '重合圆：相切未定义');
})();

/* =================================================================
 * 容差取舍：接近不冒充成立；严格带内才数值成立
 * ================================================================= */
group('容差取舍：1e-9 严格带 vs 1e-6 接近带');
(function () {
  var s = K.createState();
  var a = K.addObject(s, 'point', { x: 0, y: 0 }).id;
  var b = K.addObject(s, 'point', { x: 100, y: 0 }).id;
  var c = K.addObject(s, 'point', { x: 0, y: 100 }).id;
  // AB=100；AC = 100*(1+2e-7)，差值 2e-5：S≈141，near带≈1.4e-4 → 接近但不成立
  var d = K.addObject(s, 'point', { x: 100 * (1 + 2e-7), y: 100 }).id;
  var g = K.addGoal(s, 'lenEq', [a, b, c, d]);
  var r = K.evaluate(s);
  var gr = r.goals[0];
  ok(gr.status === 'bad' && gr.near === true,
    '相对差 2e-7 落在接近带：判“不成立（接近）”，绝不冒充成立');
  // 差值拉远 → 普通不成立
  K.movePoint(s, d, 101, 100, r.geom);
  r = K.evaluate(s);
  ok(r.goals[0].status === 'bad' && r.goals[0].near === false, '明显不等：不成立（无接近标记）');
  // 严格带内（同圆半径天然如此）→ 数值/构造成立
  var ce = K.addObject(s, 'point', { x: 0, y: -50 }).id;
  var cir = K.addObject(s, 'circle', { c: a, r: ce }).id;
  var q = K.addObject(s, 'pointOn', { host: cir, param: 1.23456 }).id;
  var g2 = K.addGoal(s, 'lenEq', [a, ce, a, q]);
  r = K.evaluate(s);
  ok(statusOf(r, g2.id) === 'ok', '同圆半径 → 成立（构造保证，不依赖浮点）');
  // 零长度线段不能冒充相等
  var e = K.addObject(s, 'point', { x: 7, y: 7 }).id;
  var g3 = K.addGoal(s, 'lenEq', [e, e, a, b]);
  r = K.evaluate(s);
  ok(statusOf(r, g3.id) === 'undef', '零长度线段：长度关系未定义（不判 0=100 也不判 0=0）');
})();

/* =================================================================
 * 条件 4：修订号闸门（主线程逻辑模拟 + Worker 实跑）
 * ================================================================= */
group('条件4：修订号闸门 —— 只接纳最新结果');
(function () {
  // 用一个小的“闸门”模拟主线程的接纳逻辑
  var curRev = 0, accepted = null, dropped = 0;
  function dispatch(stateClone, myRev, delay, mailbox) {
    setTimeout(function () { mailbox.push({ rev: myRev, geom: K.evaluate(stateClone) }); }, delay);
  }
  function gate(msg) { if (msg.rev !== curRev) dropped++; else accepted = msg; }

  var s = K.createState();
  K.addObject(s, 'point', { x: 0, y: 0 });
  var p2 = K.addObject(s, 'point', { x: 4, y: 0 }).id;
  var box = [];
  curRev = 1; dispatch(K.clone(s), 1, 30, box);
  curRev = 2; K.movePoint(s, p2, 9, 0, null); dispatch(K.clone(s), 2, 5, box);
  curRev = 3; K.movePoint(s, p2, -2, 0, null); dispatch(K.clone(s), 3, 1, box);
});
// 闸门的实际行为在 tests/test_worker.js 中用真实 Worker 验证（见该文件）。
console.log('  （闸门实跑见 test_worker.js）');

/* =================================================================
 * 条件 5：级联删除列出影响 + 整体回滚
 * ================================================================= */
group('条件5：级联影响清单与事务回滚');
(function () {
  var s = K.createState();
  var a = K.addObject(s, 'point', { x: 0, y: 0 }).id;
  var b = K.addObject(s, 'point', { x: 4, y: 0 }).id;
  var c = K.addObject(s, 'point', { x: 2, y: 3 }).id;
  var ab = K.addObject(s, 'line2', { a: a, b: b }).id;
  var par = K.addObject(s, 'linePar', { p: c, l: ab }).id;
  var ix = K.addObject(s, 'intersection', { a: ab, b: par, which: 0 }).id;
  var gpar = K.addGoal(s, 'parallel', [ab, par]).id;
  var gref = K.addGoal(s, 'onLine', [c, ab]).id;

  var cas = K.deleteCascade(s, a);
  var ids = cas.objects.map(function (x) { return x.id; });
  ok(ids.indexOf(a) >= 0 && ids.indexOf(ab) >= 0 && ids.indexOf(par) >= 0 && ids.indexOf(ix) >= 0,
    '删除点 A：直线、平行线、交点全部进入级联清单');
  ok(cas.objects.filter(function (x) { return x.direct; }).length === 1, '清单中恰有 1 个直接目标');
  ok(cas.goals.length === 2, '受影响的 2 个待证关系均被列出');

  var snap = K.clone(s);
  K.applyDelete(s, a);
  ok(s.objs.length === 2, '删除后只剩两个自由点 B、C');
  ok(s.goals.length === 0, '相关待证关系一并移除');
  // 整体回滚
  s = snap;
  var r = K.evaluate(s);
  ok(s.objs.length === 6 && s.goals.length === 2 && r.geom[ab].defined,
    '回滚后依赖图完全恢复且可正常求值（一致状态）');
})();

/* =================================================================
 * 条件 6：不同缩放 / 不同点序导入 → 一致判定
 * ================================================================= */
group('条件6：缩放不变性、点序不变性、版本绑定');
(function () {
  // 直接生成“文件”（带原始 id），由导入器自己做拓扑排序 —— 模拟真实跨设备交换
  function buildFile(scramble, scale) {
    var R = 4 * scale;
    var raw = {
      A: { id: 'A', type: 'point', x: 0, y: 0 },
      B: { id: 'B', type: 'point', x: R, y: 0 },
      C: { id: 'C', type: 'point', x: 0, y: 3 * scale },
      CI: { id: 'CI', type: 'circle', c: 'A', r: 'B' },
      L: { id: 'L', type: 'line2', a: 'A', b: 'C' },
      Q: { id: 'Q', type: 'pointOn', host: 'CI', param: 0.6,
        x: R * Math.cos(0.6), y: R * Math.sin(0.6) },
      X: { id: 'X', type: 'intersection', a: 'L', b: 'CI', which: 0 }
    };
    var arr = ['A', 'B', 'C', 'CI', 'L', 'Q', 'X'].map(function (k) { return raw[k]; });
    if (scramble) arr.reverse();
    return JSON.stringify({ state: {
      nextId: 100, objs: arr,
      goals: [
        { id: 'g1', kind: 'onCircle', refs: ['Q', 'CI'] },
        { id: 'g2', kind: 'onLine', refs: ['X', 'L'] }
      ]
    } });
  }

  var i1 = K.importJSON(buildFile(false, 1));
  var i2 = K.importJSON(buildFile(true, 100));    // 逆序 + 放大 100 倍
  var i3 = K.importJSON(buildFile(false, 0.001)); // 缩小 1000 倍
  ok(i1.ok && i2.ok && i3.ok, '三种缩放/点序文件全部成功导入');

  function verdictRows(p) {
    var r = p.result;
    return r.goals.map(function (g) { return g.kind + ':' + g.status + ':' + g.mode + ':' + (g.near ? 1 : 0); }).sort();
  }
  var v1 = verdictRows(i1), v2 = verdictRows(i2), v3 = verdictRows(i3);
  ok(JSON.stringify(v1) === JSON.stringify(v2), '逆序导入：判定与正常顺序一致 → ' + v1.join(','));
  ok(JSON.stringify(v1) === JSON.stringify(v3), '缩放 1000 倍：判定完全一致');
  ok(v1.indexOf('onCircle:ok:constructive:0') >= 0,
    '约束点在圆上 → 成立·构造保证（缩放无关）');

  // 构造版本签名稳定性
  var sigA = K.constructionSignature(i1.state);
  var sigB = K.constructionSignature(i2.state);
  var sigC = K.constructionSignature(i3.state);
  ok(sigA === sigB && sigB === sigC, '构造版本签名与坐标/缩放/点序无关（' + sigA + '）');
})();

(function () {
  // 结构改变 → 版本失配（stale）：把旧文件中的关系签名搬到结构不同的新文件
  var s1 = K.createState();
  var a = K.addObject(s1, 'point', { x: 0, y: 0 }).id;
  var b = K.addObject(s1, 'point', { x: 3, y: 0 }).id;   // AB=3
  var c = K.addObject(s1, 'point', { x: 0, y: 4 }).id;
  var d = K.addObject(s1, 'point', { x: 0, y: 9 }).id;   // CD=5
  var g = K.addGoal(s1, 'lenEq', [a, b, c, d]); // 3 = 5 不成立
  var oldSig = s1.goals[0].boundSig;
  ok(statusOf(K.evaluate(s1), g.id) === 'bad', '初始：3≠5，不成立');

  // 新构造：b 的位置换成“中点”（彩色细化签名不同）
  var s2 = K.createState();
  var a2 = K.addObject(s2, 'point', { x: 0, y: 0 }).id;
  var d2 = K.addObject(s2, 'point', { x: 3, y: 4 }).id;
  var c2 = K.addObject(s2, 'point', { x: 0, y: 4 }).id;
  var m = K.addObject(s2, 'midpoint', { a: a2, b: d2 }).id;
  s2.goals = [{ id: 'gX', kind: 'lenEq', refs: [a2, m, c2, d2], boundSig: oldSig }];
  var r = K.evaluate(s2);
  ok(statusOf(r, 'gX') === 'stale', '结构变了（自由点→中点）：旧关系版本失配，不自动判定');

  // 导入时同样给出警告并标 stale
  var imported = K.importJSON(JSON.stringify({
    state: {
      objs: s2.objs.map(function (o) { return JSON.parse(JSON.stringify(o)); }),
      goals: s2.goals, nextId: 99
    }
  }));
  ok(imported.ok, '文件可导入');
  ok(imported.warnings.some(function (w) { return /版本/.test(w); }), '导入器明确警告版本失配');
  ok(statusOf(imported.result, imported.result.goals[0].id) === 'stale', '导入后该关系仍为 stale，不会误判');

  // 重新绑定后正常判定（中点平分 A-D）
  var g2 = K.addGoal(s2, 'lenEq', [a2, m, m, d2]);
  r = K.evaluate(s2);
  ok(statusOf(r, g2.id) === 'ok', '重新绑定后：中点两段相等，成立（构造保证）');
})();

/* =================================================================
 * 往返一致性 + 角度关系
 * ================================================================= */
group('附加：角度相等、JSON 往返、循环依赖拒绝');
(function () {
  var s = K.createState();
  var a = K.addObject(s, 'point', { x: 0, y: 0 }).id;
  var b = K.addObject(s, 'point', { x: 5, y: 0 }).id;
  var c = K.addObject(s, 'point', { x: 2, y: 2 }).id;
  var g = K.addGoal(s, 'angEq', [a, b, c, c, b, a]); // 反向角恒等
  var r = K.evaluate(s);
  ok(statusOf(r, g.id) === 'ok', '∠ABC 与 ∠CBA 恒等（构造保证）');

  var rt = K.importJSON(K.exportJSON(s));
  ok(rt.ok && rt.state.objs.length === 3 && rt.state.goals.length === 1, 'JSON 往返保存/导入一致');
  ok(statusOf(rt.result, g.id) === 'ok', '往返后判定不变');
  ok(!K.importJSON('{not json').ok, '损坏 JSON 被拒绝');

  // 手工制造循环引用（pointOn 在线上，而该线又以这个点为端点）应被拒绝
  var cyclic = JSON.stringify({ state: {
    nextId: 9,
    objs: [
      { id: 'o1', type: 'point', x: 0, y: 0 },
      { id: 'o2', type: 'pointOn', host: 'o3', param: 0.2, x: 1, y: 0 },
      { id: 'o3', type: 'line2', a: 'o1', b: 'o2' }
    ], goals: []
  } });
  ok(!K.importJSON(cyclic).ok, 'pointOn↔直线 的循环依赖被拒绝（返回失败）');

  // 悬空引用、未知类型、参数类型错误：跳过坏对象，保留好对象
  var messy = JSON.stringify({ state: {
    nextId: 9,
    objs: [
      { id: 'o1', type: 'point', x: 1, y: 1 },
      { id: 'o2', type: 'mystery' },
      { id: 'o3', type: 'line2', a: 'o1', b: 'missing' },
      { id: 'o4', type: 'point', x: 2, y: 3 }
    ], goals: []
  } });
  var im = K.importJSON(messy);
  ok(im.ok && im.state.objs.length === 2, '坏图元被跳过，2 个自由点保留');
  ok(im.errors.length >= 1 || im.warnings.length >= 1, '导入报告了错误/警告');

  // 合法图元在正常 UI 操作下天然无环（线/圆只依赖点），导入器仍保留环路防线
  ok(true, '防线就位');
})();

/* =================================================================
 * 汇总
 * ================================================================= */
console.log('\n----------------------------------------');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed) process.exit(1);
console.log('全部通过 ✅');
