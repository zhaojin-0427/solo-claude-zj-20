/*
 * kernel.js —— 退化几何作图验算台 · 几何内核（纯逻辑，无 DOM）
 *
 * 设计要点：
 *  - 三值结论：成立(ok) / 不成立(bad) / 未定义(undef)，结构版本失配(stale)
 *  - 双阈值：严格容差 ε = 1e-9*S（角度 1e-9 rad）；接近带 1e-6*S。
 *    落在接近带绝不判“成立”，只能得到“不成立（接近）/接近退化”。
 *  - 构造保证：方向向量复制、同圆半径、中点平分、反向角、半径端点垂线切线等
 *    由作图定义直接成立，不依赖浮点比较。
 *  - 构造版本：只依赖“类型 + 连接关系”的彩色细化签名，与坐标、缩放、图元顺序无关。
 *  - 归一化导入：拓扑排序 + 携带坐标重吸参数（pointOn 的 λ/θ、交点的 which），
 *    保证同构造在不同缩放、不同点序下判定一致。
 */
(function (global) {
  'use strict';

  /* ---------------- 常量与小工具 ---------------- */

  var STRICT = 1e-9;   // 严格容差系数（乘尺度 S）
  var NEAR = 1e-6;     // 接近提示带系数
  var ANG_STRICT = 1e-9;
  var ANG_NEAR = 1e-6;

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function fmt(v, digits) {
    if (v === undefined || v === null || !isFinite(v)) return '—';
    var d = digits == null ? 6 : digits;
    var s = (digits === 0) ? String(Math.round(v)) : v.toFixed(d);
    // 去掉多余的 0
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }
  function deg(rad) { return rad * 180 / Math.PI; }

  // 稳定字符串散列（仅用于彩色细化的中间记号，同一次计算内配合“字典化”使用）
  function hashStr(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  /* ---------------- 图元模型 ---------------- */

  // 点类图元、线类图元、圆类图元
  function kindOf(type) {
    if (type === 'point' || type === 'pointOn' || type === 'midpoint' || type === 'intersection') return 'point';
    if (type === 'line2' || type === 'linePar' || type === 'linePerp') return 'line';
    if (type === 'circle') return 'circle';
    return null;
  }
  var TYPE_NAME = {
    point: '自由点', pointOn: '约束点', midpoint: '中点', intersection: '交点',
    line2: '直线', linePar: '平行线', linePerp: '垂线', circle: '圆'
  };
  var TYPE_PREFIX = { point: 'P', pointOn: 'P', midpoint: 'P', intersection: 'P',
    line2: 'L', linePar: 'L', linePerp: 'L', circle: 'C' };

  function createState() {
    return { objs: [], goals: [], nextId: 1 };
  }

  function clone(s) {
    return JSON.parse(JSON.stringify(s));
  }

  function getObj(state, id) {
    for (var i = 0; i < state.objs.length; i++)
      if (state.objs[i].id === id) return state.objs[i];
    return null;
  }
  function getGoal(state, id) {
    for (var i = 0; i < state.goals.length; i++)
      if (state.goals[i].id === id) return state.goals[i];
    return null;
  }

  // 返回对象的“有角色依赖”：[角色, 引用id]
  function depRoles(o) {
    switch (o.type) {
      case 'pointOn': return [['host', o.host]];
      case 'line2': return [['a', o.a], ['b', o.b]];
      case 'linePar': return [['p', o.p], ['l', o.l]];
      case 'linePerp': return [['p', o.p], ['l', o.l]];
      case 'circle': return [['c', o.c], ['r', o.r]];
      case 'midpoint': return [['a', o.a], ['b', o.b]];
      case 'intersection': return [['x', o.a], ['x', o.b]]; // 对称
      default: return [];
    }
  }
  function depRefs(o) {
    var roles = depRoles(o), out = [];
    for (var i = 0; i < roles.length; i++)
      if (out.indexOf(roles[i][1]) < 0) out.push(roles[i][1]);
    return out;
  }

  var GOAL_DEFS = {
    lenEq: { arity: 4, kinds: ['point', 'point', 'point', 'point'], name: '长度相等 AB=CD' },
    angEq: { arity: 6, kinds: ['point', 'point', 'point', 'point', 'point', 'point'], name: '角度相等 ∠ABC=∠DEF' },
    parallel: { arity: 2, kinds: ['line', 'line'], name: '两直线平行' },
    perpendicular: { arity: 2, kinds: ['line', 'line'], name: '两直线垂直' },
    tangentLC: { arity: 2, kinds: ['line', 'circle'], name: '直线与圆相切' },
    tangentCC: { arity: 2, kinds: ['circle', 'circle'], name: '两圆相切' },
    onLine: { arity: 2, kinds: ['point', 'line'], name: '点在直线上' },
    onCircle: { arity: 2, kinds: ['point', 'circle'], name: '点在圆上' }
  };

  /* ---------------- 添加 / 移动 ---------------- */

  function addObject(state, type, opts) {
    if (!kindOf(type)) return { ok: false, error: '未知图元类型：' + type };
    var o = { id: 'o' + (state.nextId++), type: type };
    opts = opts || {};
    if (type === 'point') {
      if (!isFinite(opts.x) || !isFinite(opts.y)) return { ok: false, error: '自由点坐标无效' };
      o.x = opts.x; o.y = opts.y;
    } else if (type === 'pointOn') {
      if (!getObj(state, opts.host)) return { ok: false, error: '宿主对象不存在' };
      var hk = kindOf(getObj(state, opts.host).type);
      if (hk !== 'line' && hk !== 'circle') return { ok: false, error: '约束点只能放在直线或圆上' };
      o.host = opts.host;
      o.param = isFinite(opts.param) ? opts.param : 0;
      o.x = isFinite(opts.x) ? opts.x : null;
      o.y = isFinite(opts.y) ? opts.y : null;
    } else {
      ['a', 'b', 'c', 'r', 'p', 'l'].forEach(function (k) {
        if (opts[k] !== undefined) o[k] = opts[k];
      });
      var err = checkRefs(state, o);
      if (err) { state.nextId--; return { ok: false, error: err }; }
      if (type === 'intersection') o.which = opts.which === 1 ? 1 : 0;
    }
    state.objs.push(o);
    assignLabels(state);
    return { ok: true, id: o.id };
  }

  function checkRefs(state, o) {
    var roles = depRoles(o);
    for (var i = 0; i < roles.length; i++) {
      var ref = getObj(state, roles[i][1]);
      if (!ref) return '引用的图元不存在（' + roles[i][1] + '）';
    }
    var need = (o.type === 'intersection') ? {} :
      { a: 'point', b: 'point', c: 'point', r: 'point', p: 'point' };
    for (var k in need) {
      if (o[k] !== undefined && kindOf(getObj(state, o[k]).type) !== need[k])
        return TYPE_NAME[o.type] + ' 的参数 ' + k + ' 必须是点';
    }
    if (o.l !== undefined && kindOf(getObj(state, o.l).type) !== 'line')
      return TYPE_NAME[o.type] + ' 的参考对象必须是直线';
    if (o.type === 'intersection') {
      var ka = kindOf(getObj(state, o.a).type), kb = kindOf(getObj(state, o.b).type);
      var okPair = (ka === 'line' && kb === 'line') || (ka === 'line' && kb === 'circle') ||
                   (ka === 'circle' && kb === 'line') || (ka === 'circle' && kb === 'circle');
      if (!okPair) return '交点只能由 直线×直线 / 直线×圆 / 圆×圆 生成';
    }
    return null;
  }

  // 按当前数组顺序分配显示标签（同类型计数）
  function assignLabels(state) {
    var counters = { P: 0, L: 0, C: 0 };
    state.objs.forEach(function (o) {
      var p = TYPE_PREFIX[o.type];
      counters[p] = (counters[p] || 0) + 1;
      o.label = p + counters[p];
    });
  }

  function addGoal(state, kind, refs) {
    var def = GOAL_DEFS[kind];
    if (!def) return { ok: false, error: '未知待证关系' };
    if (!refs || refs.length !== def.arity) return { ok: false, error: '参数数量不对' };
    for (var i = 0; i < refs.length; i++) {
      var o = getObj(state, refs[i]);
      if (!o) return { ok: false, error: '引用的图元不存在' };
      if (kindOf(o.type) !== def.kinds[i]) return { ok: false, error: '第 ' + (i + 1) + ' 个参数类型应为' + def.kinds[i] };
    }
    var colors = computeColors(state);
    var g = { id: 'g' + (state.nextId++), kind: kind, refs: refs.slice(), boundSig: goalSig(kind, refs, colors) };
    state.goals.push(g);
    return { ok: true, id: g.id };
  }

  // 拖动自由点 / 约束点。geomCache 为最近一次求值结果（用于把指针位置吸回约束）
  function movePoint(state, id, x, y, geomCache) {
    var o = getObj(state, id);
    if (!o) return null;
    if (o.type === 'point') { o.x = x; o.y = y; return { x: x, y: y }; }
    if (o.type === 'pointOn' && geomCache) {
      var g = geomCache[o.host];
      if (g && g.defined) {
        if (g.g === 'l') {
          var vx = g.vx, vy = g.vy, lv2 = vx * vx + vy * vy;
          if (lv2 > 0) o.param = ((x - g.ox) * vx + (y - g.oy) * vy) / lv2;
        } else {
          o.param = Math.atan2(y - g.cy, x - g.cx);
        }
      }
    }
    return null;
  }

  /* ---------------- 构造版本签名（彩色细化 / 类 WL） ---------------- */

  function computeColors(state) {
    var objs = state.objs, n = objs.length;
    var idx = {};
    objs.forEach(function (o, i) { idx[o.id] = i; });
    var seed = { point: 'f', pointOn: 'n', midpoint: 'm', intersection: 'i',
      line2: 'L2', linePar: 'LP', linePerp: 'LV', circle: 'C' };
    var colors = objs.map(function (o) { return seed[o.type]; });
    for (var iter = 0; iter < n + 2; iter++) {
      var raw = objs.map(function (o) {
        var pairs = depRoles(o).map(function (rl) {
          return rl[0] + ':' + colors[idx[rl[1]]];
        }).sort();
        return o.type + '|' + pairs.join(',');
      });
      // 字典化：按签名排序后编号，保证与对象排列顺序无关
      var uniq = Array.from(new Set(raw)).sort();
      var intern = {};
      uniq.forEach(function (s, i) { intern[s] = 'k' + (i + 1); });
      var next = raw.map(function (s) { return intern[s]; });
      var same = true;
      for (var i = 0; i < n; i++) if (next[i] !== colors[i]) { same = false; break; }
      colors = next;
      if (same) break;
    }
    var map = {};
    objs.forEach(function (o, i) { map[o.id] = colors[i]; });
    return map;
  }

  function constructionSignature(state) {
    var colors = computeColors(state);
    var all = state.objs.map(function (o) { return colors[o.id]; }).sort();
    return 'v1:' + hashStr(all.join(','));
  }

  function goalSig(kind, refs, colors) {
    function c(i) { return colors[refs[i]]; }
    var seg = function (i) {
      var a = c(i), b = c(i + 1);
      return a < b ? a + '~' + b : b + '~' + a; // 线段端点无序
    };
    var ang = function (vi) {
      var v = c(vi), r1 = c(vi - 1), r2 = c(vi + 1);
      return r1 < r2 ? v + '<' + r1 + ',' + r2 + '>' : v + '<' + r2 + ',' + r1 + '>';
    };
    switch (kind) {
      case 'lenEq': {
        var s1 = seg(0), s2 = seg(2);
        return 'lenEq:' + (s1 < s2 ? s1 + '|' + s2 : s2 + '|' + s1);
      }
      case 'angEq': {
        // ∠ABC: 顶点 refs[1]；∠DEF: 顶点 refs[4]
        var a1 = colors[refs[1]] + '(' + [colors[refs[0]], colors[refs[2]]].sort() + ')',
            a2 = colors[refs[4]] + '(' + [colors[refs[3]], colors[refs[5]]].sort() + ')';
        return 'angEq:' + (a1 < a2 ? a1 + '|' + a2 : a2 + '|' + a1);
      }
      case 'parallel': case 'perpendicular': case 'tangentCC': {
        var x = c(0), y = c(1);
        return kind + ':' + (x < y ? x + '|' + y : y + '|' + x);
      }
      case 'tangentLC': return 'tangentLC:L=' + c(0) + ',C=' + c(1);
      case 'onLine': return 'onLine:P=' + c(0) + ',L=' + c(1);
      case 'onCircle': return 'onCircle:P=' + c(0) + ',C=' + c(1);
    }
    return kind;
  }

  function currentGoalSig(state, goal) {
    return goalSig(goal.kind, goal.refs, computeColors(state));
  }

  /* ---------------- 级联闭包 ---------------- */

  function deleteCascade(state, id) {
    var removed = {};
    var queue = [id];
    removed[id] = null; // null = 直接删除
    while (queue.length) {
      var cur = queue.shift();
      state.objs.forEach(function (o) {
        if (removed[o.id] !== undefined) return;
        var refs = depRefs(o);
        if (refs.indexOf(cur) >= 0) {
          removed[o.id] = cur;
          queue.push(o.id);
        }
      });
    }
    var objects = state.objs.filter(function (o) { return removed[o.id] !== undefined; })
      .map(function (o) {
        return { id: o.id, label: o.label, type: o.type, typeName: TYPE_NAME[o.type],
          direct: o.id === id, via: removed[o.id] };
      });
    var goals = state.goals.filter(function (g) {
      return g.refs.some(function (r) { return removed[r] !== undefined; });
    }).map(function (g) {
      var hit = g.refs.filter(function (r) { return removed[r] !== undefined; });
      return { id: g.id, kind: g.kind, name: goalDisplayName(g, state), hit: hit };
    });
    return { objects: objects, goals: goals };
  }

  function applyDelete(state, id) {
    var cas = deleteCascade(state, id);
    var rem = {};
    cas.objects.forEach(function (x) { rem[x.id] = true; });
    state.objs = state.objs.filter(function (o) { return !rem[o.id]; });
    state.goals = state.goals.filter(function (g) {
      return !g.refs.some(function (r) { return rem[r]; });
    });
    assignLabels(state);
    return cas;
  }

  function goalDisplayName(g, state) {
    var L = function (i) { var o = getObj(state, g.refs[i]); return o ? o.label : '?'; };
    switch (g.kind) {
      case 'lenEq': return L(0) + L(1) + ' = ' + L(2) + L(3);
      case 'angEq': return '∠' + L(0) + L(1) + L(2) + ' = ∠' + L(3) + L(4) + L(5);
      case 'parallel': return L(0) + ' ∥ ' + L(1);
      case 'perpendicular': return L(0) + ' ⟂ ' + L(1);
      case 'tangentLC': return L(0) + ' 与 ' + L(1) + ' 相切';
      case 'tangentCC': return L(0) + ' 与 ' + L(1) + ' 相切';
      case 'onLine': return L(0) + ' ∈ ' + L(1);
      case 'onCircle': return L(0) + ' ∈ ' + L(1);
    }
    return g.kind;
  }

  /* ---------------- 求值（拓扑顺序） ---------------- */

  // 把直线方向规范化（与输入端点顺序无关：x>0，或 x==0 时 y>0）
  function canonDir(dx, dy) {
    var len = Math.hypot(dx, dy);
    if (len === 0) return { dx: 0, dy: 0, len: 0 };
    dx /= len; dy /= len;
    if (dx < -1e-15 || (Math.abs(dx) <= 1e-15 && dy < 0)) { dx = -dx; dy = -dy; }
    return { dx: dx, dy: dy, len: len };
  }

  function undefGeom(g, cat, msg) {
    return { g: g, defined: false, cat: cat, msg: msg };
  }

  // 单点求值（result 为累积上下文）
  function evalOne(state, o, R, importSnap) {
    var geom = R.geom, recs = R.recs, S = R.S;
    var eps = STRICT * S, near = NEAR * S;

    function rec(status, head, lines) {
      recs[o.id] = { id: o.id, status: status, head: head, lines: lines || [], nearDegen: false };
    }
    function fail(cat, head, lines) {
      geom[o.id] = undefGeom(kindOf(o.type), cat, head);
      rec('undef', head, lines);
      return;
    }
    function depUndef(refId) {
      var d = geom[refId];
      fail('depends', '依赖的 ' + labelOf(state, refId) + ' 未定义，' + TYPE_NAME[o.type] + ' 无法作出',
        ['上游原因：' + (d.msg || '未定义') + '。', '因此本对象标记为【未定义】，所有后继一并未定义。']);
    }
    function definedPoint(x, y, head, lines, extra) {
      geom[o.id] = Object.assign({ g: 'p', defined: true, x: x, y: y }, extra || {});
      rec('ok', head, lines);
    }

    switch (o.type) {
      case 'point':
        definedPoint(o.x, o.y, '自由点 ' + o.label, ['坐标 (' + fmt(o.x) + ', ' + fmt(o.y) + ')，可任意拖动。']);
        return;

      case 'pointOn': {
        var h = geom[o.host];
        if (!h || !h.defined) { depUndef(o.host); return; }
        var ho = getObj(state, o.host);
        if (h.g === 'l') {
          var x = h.ox + o.param * h.vx, y = h.oy + o.param * h.vy;
          if (importSnap && isFinite(o.x) && isFinite(o.y)) {
            var lv2 = h.vx * h.vx + h.vy * h.vy;
            if (lv2 > 0) o.param = ((o.x - h.ox) * h.vx + (o.y - h.oy) * h.vy) / lv2;
            x = h.ox + o.param * h.vx; y = h.oy + o.param * h.vy;
          }
          o.x = x; o.y = y;
          definedPoint(x, y, '约束点 ' + o.label + ' 在直线 ' + ho.label + ' 上',
            ['参数 λ = ' + fmt(o.param) + '，位置 = 直线基点 + λ·方向向量。',
             '拖动时只能沿该直线滑动（约束始终保持）。']);
        } else {
          if (h.r <= 0) { fail('zero-radius', '宿主圆 ' + ho.label + ' 半径为 0，无法取圆周点', []); return; }
          if (importSnap && isFinite(o.x) && isFinite(o.y))
            o.param = Math.atan2(o.y - h.cy, o.x - h.cx);
          x = h.cx + h.r * Math.cos(o.param); y = h.cy + h.r * Math.sin(o.param);
          o.x = x; o.y = y;
          definedPoint(x, y, '约束点 ' + o.label + ' 在圆 ' + ho.label + ' 上',
            ['圆心角 θ = ' + fmt(deg(o.param), 3) + '°，距圆心恒等于半径 ' + fmt(h.r) + '（由构造保证）。']);
        }
        return;
      }

      case 'line2': {
        var A = geom[o.a], B = geom[o.b];
        if (!A.defined) { depUndef(o.a); return; }
        if (!B.defined) { depUndef(o.b); return; }
        var d = canonDir(B.x - A.x, B.y - A.y);
        if (d.len <= eps) {
          fail('coincident-points', '两点 ' + labelOf(state, o.a) + '、' + labelOf(state, o.b) +
            ' 重合，过两点的直线未定义',
            ['两点距离 = ' + fmt(d.len) + '，严格容差 ε = ' + fmt(eps) + '。',
             '距离为 0 时有无穷多条方向，直线不能确定。']);
          return;
        }
        var lines = ['两点距离 = ' + fmt(d.len) + '，单位方向向量 (' + fmt(d.dx) + ', ' + fmt(d.dy) + ')。'];
        if (d.len < near) lines.push('⚠ 两点非常接近（处于 1e-6 接近带内），方向不稳定；仍按直线计算，不判为退化。');
        geom[o.id] = { g: 'l', defined: true, ox: A.x, oy: A.y,
          vx: B.x - A.x, vy: B.y - A.y, dx: d.dx, dy: d.dy, nearDegen: d.len < near };
        rec(d.len < near ? 'warn' : 'ok', '直线 ' + o.label + ' 过 ' + labelOf(state, o.a) + '、' + labelOf(state, o.b), lines);
        return;
      }

      case 'linePar': {
        var P = geom[o.p], L = geom[o.l];
        if (!P.defined) { depUndef(o.p); return; }
        if (!L.defined) { depUndef(o.l); return; }
        geom[o.id] = { g: 'l', defined: true, ox: P.x, oy: P.y, vx: L.dx, vy: L.dy, dx: L.dx, dy: L.dy };
        rec('ok', '过 ' + labelOf(state, o.p) + ' 作 ' + labelOf(state, o.l) + ' 的平行线 ' + o.label,
          ['方向向量直接复制自 ' + labelOf(state, o.l) + '，两线平行【由构造保证】，无需浮点比较。']);
        return;
      }

      case 'linePerp': {
        var P2 = geom[o.p], L2 = geom[o.l];
        if (!P2.defined) { depUndef(o.p); return; }
        if (!L2.defined) { depUndef(o.l); return; }
        var px = -L2.dy, py = L2.dx;
        geom[o.id] = { g: 'l', defined: true, ox: P2.x, oy: P2.y, vx: px, vy: py, dx: px, dy: py };
        rec('ok', '过 ' + labelOf(state, o.p) + ' 作 ' + labelOf(state, o.l) + ' 的垂线 ' + o.label,
          ['方向向量取 (' + fmt(L2.dx) + ', ' + fmt(L2.dy) + ') 旋转 90°，垂直【由构造保证】。']);
        return;
      }

      case 'circle': {
        var C = geom[o.c], Rr = geom[o.r];
        if (!C.defined) { depUndef(o.c); return; }
        if (!Rr.defined) { depUndef(o.r); return; }
        var r = Math.hypot(Rr.x - C.x, Rr.y - C.y);
        if (r <= eps) {
          fail('zero-radius', '圆心 ' + labelOf(state, o.c) + ' 与半径点 ' + labelOf(state, o.r) +
            ' 重合，圆未定义（零半径）',
            ['半径 r = ' + fmt(r) + '，严格容差 ε = ' + fmt(eps) + '。']);
          return;
        }
        var clines = ['圆心 (' + fmt(C.x) + ', ' + fmt(C.y) + ')，半径 r = ' + fmt(r) + '。'];
        if (r < near) clines.push('⚠ 半径极小（接近带内），仍按圆计算。');
        geom[o.id] = { g: 'c', defined: true, cx: C.x, cy: C.y, r: r, nearDegen: r < near };
        rec(r < near ? 'warn' : 'ok', '圆 ' + o.label + '（圆心 ' + labelOf(state, o.c) + '，过 ' + labelOf(state, o.r) + '）', clines);
        return;
      }

      case 'midpoint': {
        var M1 = geom[o.a], M2 = geom[o.b];
        if (!M1.defined) { depUndef(o.a); return; }
        if (!M2.defined) { depUndef(o.b); return; }
        var mx = (M1.x + M2.x) / 2, my = (M1.y + M2.y) / 2;
        o.x = mx; o.y = my;
        var half = Math.hypot(M2.x - M1.x, M2.y - M1.y) / 2;
        definedPoint(mx, my, '中点 ' + o.label + '（' + labelOf(state, o.a) + labelOf(state, o.b) + '）',
          ['坐标 = 两端点平均。', labelOf(state, o.a) + o.label + ' = ' + o.label + labelOf(state, o.b) +
           ' = ' + fmt(half) + '，两线段相等【由构造保证】；两端点重合时本点仍有定义。']);
        return;
      }

      case 'intersection':
        evalIntersection(state, o, R, importSnap);
        return;
    }
  }

  function labelOf(state, id) {
    var o = getObj(state, id);
    return o ? o.label : id;
  }

  function evalIntersection(state, o, R, importSnap) {
    var geom = R.geom, recs = R.recs, S = R.S;
    var eps = ANG_STRICT, linEps = STRICT * S, nearEps = NEAR * S;
    var A = geom[o.a], B = geom[o.b];
    var la = labelOf(state, o.a), lb = labelOf(state, o.b);

    function fail(cat, head, lines) {
      geom[o.id] = undefGeom('point', cat, head);
      recs[o.id] = { id: o.id, status: 'undef', head: head, lines: lines, nearDegen: false };
    }
    function ok(x, y, head, lines, extra) {
      o.x = x; o.y = y;
      geom[o.id] = Object.assign({ g: 'p', defined: true, x: x, y: y }, extra || {});
      recs[o.id] = { id: o.id, status: 'ok', head: head, lines: lines, nearDegen: false };
    }
    if (!A.defined) { fail('depends', '交点依赖的 ' + la + ' 未定义，交点未定义', ['上游：' + A.msg]); return; }
    if (!B.defined) { fail('depends', '交点依赖的 ' + lb + ' 未定义，交点未定义', ['上游：' + B.msg]); return; }

    var g1 = A, g2 = B;
    if (g1.g === 'circle' && g2.g === 'line') { g1 = B; g2 = A; var tt = la; la = lb; lb = tt; } // g1=line, g2=circle

    /* ---- 直线 × 直线 ---- */
    if (g1.g === 'l' && g2.g === 'l') {
      var L1 = g1, L2 = g2;
      var cross = L1.dx * L2.dy - L1.dy * L2.dx;
      var ang = Math.abs(Math.atan2(Math.abs(cross), L1.dx * L2.dx + L1.dy * L2.dy));
      var headBase = la + ' 与 ' + lb;
      var common = ['两方向夹角 = ' + fmt(deg(ang), 6) + '°，叉积 |u×v| = ' + fmt(Math.abs(cross), 4) +
        '，严格阈值 ' + fmt(ANG_STRICT, 0) + ' rad。'];
      if (Math.abs(cross) <= eps) {
        // 方向平行：区分 重合 / 平行不同线
        var sep = (L2.ox - L1.ox) * L1.dy - (L2.oy - L1.oy) * L1.dx;
        if (Math.abs(sep) <= linEps) {
          fail('coincident-lines', headBase + ' 重合，交点未定义',
            common.concat(['两线完全重合 → 有无穷多个公共点，无法唯一确定交点。',
              '【重合】使本交点及其所有待证关系变为未定义。']));
        } else {
          fail('parallel-lines', headBase + ' 平行（不同线），无交点',
            common.concat(['两线间距 = ' + fmt(Math.abs(sep)) + ' ≠ 0（阈值 ε = ' + fmt(linEps) + '）。',
              '【平行】→ 0 个交点；本对象未定义，后继关系逐级未定义。']));
        }
        return;
      }
      var t = ((L2.ox - L1.ox) * L2.dy - (L2.oy - L1.oy) * L2.dx) / cross;
      var x = L1.ox + t * L1.dx, y = L1.oy + t * L1.dy;
      var ln = common.slice();
      if (ang < ANG_NEAR) ln.push('⚠ 夹角极小（< 1e-6 rad），交点位置不稳定；不构成平行，仍按相交计算。');
      ok(x, y, headBase + ' 相交于 ' + o.label, ln, { nearDegen: ang < ANG_NEAR });
      recs[o.id].status = ang < ANG_NEAR ? 'warn' : 'ok';
      return;
    }

    /* ---- 直线 × 圆 ---- */
    if (g1.g === 'l' && g2.g === 'c') {
      var L = g1, C = g2;
      var nx = -L.dy, ny = L.dx;
      var hsigned = (C.cx - L.ox) * nx + (C.cy - L.oy) * ny;
      var h = Math.abs(hsigned);
      var s = (C.cx - L.ox) * L.dx + (C.cy - L.oy) * L.dy;
      var fx = L.ox + s * L.dx, fy = L.oy + s * L.dy;
      var base = la + ' 与圆 ' + lb;
      var info = ['圆心到直线距离 h = ' + fmt(h) + '，圆半径 r = ' + fmt(C.r) +
        '，差值 |h−r| = ' + fmt(Math.abs(h - C.r)) + '（严格 ε = ' + fmt(linEps) + '）。'];
      if (h - C.r > linEps) {
        var ln2 = info.concat(['h > r：直线在圆外，【无交点】。', '本交点未定义；依赖它的待证关系变为未定义。']);
        if (h - C.r <= nearEps) ln2.push('⚠ 差值处于接近带，接近相切，但绝不判为相切/成立。');
        fail('line-misses-circle', base + ' 无交点（直线在圆外）', ln2);
        return;
      }
      if (Math.abs(h - C.r) <= linEps) {
        ok(fx, fy, base + ' 相切于 ' + o.label + '（唯一切点）',
          info.concat(['h = r：判别式恰为 0，两个候选交点重合为同一点 —— 切点 ' + o.label + '。',
            '【相切】时交点仍有定义；候选 1 与候选 2 重合。']),
          { tangent: true });
        return;
      }
      var q = Math.sqrt(Math.max(0, C.r * C.r - h * h));
      var p1 = { x: fx + q * L.dx, y: fy + q * L.dy };
      var p2 = { x: fx - q * L.dx, y: fy - q * L.dy };
      if (importSnap && isFinite(o.x) && isFinite(o.y)) {
        o.which = (Math.hypot(o.x - p1.x, o.y - p1.y) <= Math.hypot(o.x - p2.x, o.y - p2.y)) ? 0 : 1;
      }
      var P = o.which === 0 ? p1 : p2;
      var ln3 = info.concat(['h < r：判别式 > 0，有两个交点。',
        '候选① = (' + fmt(p1.x) + ', ' + fmt(p1.y) + ')，候选② = (' + fmt(p2.x) + ', ' + fmt(p2.y) + ')；本对象取候选' +
        (o.which === 0 ? '①' : '②') + '。']);
      if (C.r - h <= nearEps) ln3.push('⚠ 弦长极小，接近相切，但目前是两个不同交点，不判为相切。');
      ok(P.x, P.y, base + ' 相交，取交点 ' + o.label, ln3, { nearDegen: C.r - h <= nearEps });
      recs[o.id].status = (C.r - h <= nearEps) ? 'warn' : 'ok';
      return;
    }

    /* ---- 圆 × 圆 ---- */
    var C1 = g1, C2 = g2;
    var d = Math.hypot(C2.cx - C1.cx, C2.cy - C1.cy);
    var sumr = C1.r + C2.r, diffr = Math.abs(C1.r - C2.r);
    var binfo = ['圆心距 d = ' + fmt(d) + '，r₁+r₂ = ' + fmt(sumr) + '，|r₁−r₂| = ' + fmt(diffr) +
      '，严格 ε = ' + fmt(linEps) + '。'];
    var basec = '圆 ' + la + ' 与圆 ' + lb;
    if (d <= linEps) {
      if (Math.abs(C1.r - C2.r) <= linEps) {
        fail('coincident-circles', basec + ' 重合（同心同半径），交点未定义',
          binfo.concat(['两圆完全重合 → 无穷多个公共点。', '【重合】使交点与后继关系未定义。']));
      } else {
        fail('concentric-distinct', basec + ' 同心但半径不同，无交点',
          binfo.concat(['d = 0 且半径不等：一个圆完全内含（实为同心嵌套），【无交点】。']));
      }
      return;
    }
    if (Math.abs(d - sumr) <= linEps || Math.abs(d - diffr) <= linEps) {
      var ext = Math.abs(d - sumr) <= linEps;
      var qx = C1.cx + (ext ? C1.r : (C1.r * C1.r - C2.r * C2.r + d * d) / (2 * d)) / d * (C2.cx - C1.cx);
      var qy = C1.cy + (ext ? C1.r : (C1.r * C1.r - C2.r * C2.r + d * d) / (2 * d)) / d * (C2.cy - C1.cy);
      ok(qx, qy, basec + (ext ? ' 外切' : ' 内切') + ' 于 ' + o.label,
        binfo.concat([ext ? 'd = r₁+r₂：两圆【外切】。' : 'd = |r₁−r₂|：一圆【内切】于另一圆。',
          '两个候选交点重合为唯一切点 ' + o.label + '，交点仍有定义。']),
        { tangent: true });
      return;
    }
    if (d > sumr) {
      var lns = binfo.concat(['d > r₁+r₂：两圆分离，【无交点】；关系不能成立。']);
      if (d - sumr <= nearEps) lns.push('⚠ 距离外切阈值在接近带内，接近外切，但不判为相切。');
      fail('circles-separate', basec + ' 分离，无交点', lns);
      return;
    }
    if (d < diffr) {
      var lns2 = binfo.concat(['d < |r₁−r₂|：小圆完全在大圆内部，【无交点】；关系不能成立。']);
      if (diffr - d <= nearEps) lns2.push('⚠ 接近内切，但不判为相切。');
      fail('circle-contained', basec + ' 内含，无交点', lns2);
      return;
    }
    var a = (C1.r * C1.r - C2.r * C2.r + d * d) / (2 * d);
    var hh = Math.sqrt(Math.max(0, C1.r * C1.r - a * a));
    var ux = (C2.cx - C1.cx) / d, uy = (C2.cy - C1.cy) / d;
    var mx = C1.cx + a * ux, my = C1.cy + a * uy;
    var q1 = { x: mx + hh * (-uy), y: my + hh * ux };
    var q2 = { x: mx - hh * (-uy), y: my - hh * ux };
    if (importSnap && isFinite(o.x) && isFinite(o.y)) {
      o.which = (Math.hypot(o.x - q1.x, o.y - q1.y) <= Math.hypot(o.x - q2.x, o.y - q2.y)) ? 0 : 1;
    }
    var P0 = o.which === 0 ? q1 : q2;
    var lns3 = binfo.concat(['|r₁−r₂| < d < r₁+r₂：两圆交于两点。',
      '候选① = (' + fmt(q1.x) + ', ' + fmt(q1.y) + ')，候选② = (' + fmt(q2.x) + ', ' + fmt(q2.y) + ')；取候选' +
      (o.which === 0 ? '①' : '②') + '。']);
    ok(P0.x, P0.y, basec + ' 相交于两点，取 ' + o.label, lns3);
  }

  function evaluate(state, opts) {
    opts = opts || {};
    // 尺度：由全部已定义点（自由点为基准；自由点不足时再用其他点）包围盒
    var pts = [];
    state.objs.forEach(function (o) {
      if (o.type === 'point' && isFinite(o.x)) pts.push([o.x, o.y]);
      if ((o.type === 'pointOn' || o.type === 'midpoint' || o.type === 'intersection') && isFinite(o.x))
        pts.push([o.x, o.y]);
    });
    var S = 1;
    if (pts.length >= 1) {
      var xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; });
      var diag = Math.hypot(Math.max.apply(null, xs) - Math.min.apply(null, xs),
                            Math.max.apply(null, ys) - Math.min.apply(null, ys));
      if (diag > 0) S = diag;
    }
    var R = { geom: {}, recs: {}, S: S, eps: STRICT * S };
    state.objs.forEach(function (o) { evalOne(state, o, R, !!opts.importSnap); });

    var colors = computeColors(state);
    var goals = state.goals.map(function (g) {
      return evalGoal(state, g, R, colors);
    });
    return {
      rev: opts.rev, S: S, eps: R.eps,
      geom: R.geom, recs: R.recs,
      goals: goals,
      constructionSig: constructionSignature(state)
    };
  }

  /* ---------------- 待证关系判定 ---------------- */

  function pointLen(geom, a, b) {
    var A = geom[a], B = geom[b];
    if (!A || !B || !A.defined || !B.defined) return null;
    return Math.hypot(B.x - A.x, B.y - A.y);
  }
  function angleAt(geom, a, b, c) {
    var A = geom[a], B = geom[b], C = geom[c];
    if (!A.defined || !B.defined || !C.defined) return null;
    var ux = A.x - B.x, uy = A.y - B.y, vx = C.x - B.x, vy = C.y - B.y;
    var lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (lu === 0 || lv === 0) return { degenerate: true };
    var cr = ux * vy - uy * vx, dt = ux * vx + uy * vy;
    return { value: Math.atan2(Math.abs(cr), dt), lu: lu, lv: lv };
  }

  function firstUndefRef(state, geom, refs) {
    for (var i = 0; i < refs.length; i++) {
      var g = geom[refs[i]];
      if (!g || !g.defined) return { id: refs[i], msg: g ? g.msg : '不存在' };
    }
    return null;
  }

  // 结构级“由构造保证”识别：返回证明文字，否则 null
  function structuralProof(state, g, geom) {
    var objs = {};
    state.objs.forEach(function (o) { objs[o.id] = o; });
    var r = g.refs;
    switch (g.kind) {
      case 'parallel': {
        var A = objs[r[0]], B = objs[r[1]];
        if ((A.type === 'linePar' && A.l === r[1]) || (B.type === 'linePar' && B.l === r[0]))
          return '其中一条直线是用“平行线”工具复制另一条的方向向量作出的，方向完全相同 —— 平行由构造定义直接保证。';
        return null;
      }
      case 'perpendicular': {
        var A2 = objs[r[0]], B2 = objs[r[1]];
        if ((A2.type === 'linePerp' && A2.l === r[1]) || (B2.type === 'linePerp' && B2.l === r[0]))
          return '其中一条直线是用“垂线”工具把另一条的方向旋转 90° 作出的 —— 垂直由构造定义直接保证。';
        return null;
      }
      case 'onLine': {
        var p = objs[r[0]], l = objs[r[1]];
        if (p.type === 'pointOn' && p.host === r[1])
          return '该点是用“约束点”工具直接取在这条直线上的，参数沿直线定义 —— 在线由构造保证。';
        if ((l.type === 'line2' && (l.a === r[0] || l.b === r[0])) ||
            ((l.type === 'linePar' || l.type === 'linePerp') && l.p === r[0]))
          return '该点是这条直线的作图基点（两点之一 / 平行线或垂线经过的点）—— 在线由构造保证。';
        return null;
      }
      case 'onCircle': {
        var pc = objs[r[0]], cc = objs[r[1]];
        if (pc.type === 'pointOn' && pc.host === r[1])
          return '该点是用“约束点”工具直接取在圆周上的，到圆心的距离恒等于半径 —— 在圆上由构造保证。';
        if (cc.type === 'circle' && cc.r === r[0])
          return '该点是圆的“半径点”，圆就是按到它的距离定义的 —— 在圆上由构造保证。';
        return null;
      }
      case 'tangentLC': {
        var Lc = objs[r[0]], Cc = objs[r[1]];
        if (Lc.type === 'linePerp' && Cc.type === 'circle' &&
            Lc.p === Cc.r && Lc.l &&
            objs[Lc.l] && objs[Lc.l].type === 'line2' &&
            ((objs[Lc.l].a === Cc.c && objs[Lc.l].b === Cc.r) ||
             (objs[Lc.l].b === Cc.c && objs[Lc.l].a === Cc.r)))
          return '直线过圆的半径端点，且由“垂线”工具垂直于该半径 —— 切线判定定理的标准作图，相切由构造保证。';
        return null;
      }
      case 'lenEq': {
        return lengthStructural(state, r);
      }
      case 'angEq': {
        // 反向角：∠ABC 与 ∠CBA（同顶点、同两条射线）
        if (r[1] === r[4] && ((r[0] === r[3] && r[2] === r[5]) || (r[0] === r[5] && r[2] === r[3])))
          return '两个角其实是同一个角的正写与反写（∠ABC 与 ∠CBA），射线集合相同 —— 相等由定义保证。';
        return null;
      }
    }
    return null;
  }

  // 点是否“由构造保证”在指定圆上：半径点、圆周约束点、以该圆为父母之一的交点
  function pointOnCircleByConstruction(state, pid, circleId) {
    var objs = {};
    state.objs.forEach(function (o) { objs[o.id] = o; });
    var o = objs[pid];
    if (!o) return false;
    if (o.type === 'point') {
      // 自由点只有当它是该圆的半径点时才算（圆的定义本身）
      var c = objs[circleId];
      return !!(c && c.type === 'circle' && c.r === pid);
    }
    if (o.type === 'pointOn') return o.host === circleId;
    if (o.type === 'intersection') return o.a === circleId || o.b === circleId;
    return false;
  }

  // 线段长度的“构造来源”
  function segmentKind(state, p, q) {
    var objs = {};
    state.objs.forEach(function (o) { objs[o.id] = o; });
    // 同圆半径：一点为圆心，另一点由构造保证在该圆上
    for (var id in objs) {
      var o = objs[id];
      if (o.type !== 'circle') continue;
      if ((o.c === p && pointOnCircleByConstruction(state, q, id)) ||
          (o.c === q && pointOnCircleByConstruction(state, p, id))) {
        return { kind: 'radius', circle: id };
      }
    }
    // 中点平分
    for (var mid in objs) {
      var mo = objs[mid];
      if (mo.type === 'midpoint' &&
          ((mo.a === p && mo.b === q) || (mo.b === p && mo.a === q))) {
        return { kind: 'half', mid: mid };
      }
    }
    return { kind: 'numeric' };
  }

  function lengthStructural(state, r) {
    var s1 = segmentKind(state, r[0], r[1]), s2 = segmentKind(state, r[2], r[3]);
    // 同一条线段（或正反写）
    if ((r[0] === r[2] && r[1] === r[3]) || (r[0] === r[3] && r[1] === r[2]))
      return '两条线段是同一条线段（端点集合相同）—— 长度相等由恒等性保证。';
    if (s1.kind === 'radius' && s2.kind === 'radius' && s1.circle === s2.circle)
      return '两条线段的一个端点是同一圆的圆心，另一个端点都由构造在该圆上（半径点、圆周约束点或圆的交点）'
        + ' —— 同圆半径相等，由构造保证。';
    if (s1.kind === 'half' && s2.kind === 'half' && s1.mid === s2.mid)
      return '两条线段是同一中点分出的左右两段 —— 中点平分线段，由构造保证。';
    return null;
  }

  function evalGoal(state, g, R, colors) {
    var geom = R.geom, S = R.S, eps = R.eps, near = NEAR * S;
    var refs = g.refs;
    var base = { id: g.id, kind: g.kind, name: goalDisplayName(g, state), refs: refs,
      status: 'bad', mode: null, near: false, steps: [], measured: '', headline: '' };

    // —— 构造版本闸门 ——
    var csig = goalSig(g.kind, refs, colors);
    if (csig !== g.boundSig) {
      base.status = 'stale';
      base.headline = '版本失配：作图链结构已改变，该关系创建于旧构造版本，暂停判定。';
      base.steps.push({ level: 'note', title: '为什么不直接判定？',
        detail: '待证关系在创建时绑定构造版本（只记录“谁是谁的父对象”，不记录坐标）。'
          + '删除或重建图元后类型/连接关系变了，旧关系不再自动套用到新构造上，以免把不相干的对象误判为成立。' });
      base.steps.push({ level: 'note', title: '怎么办',
        detail: '确认当前结构后删除本关系并重新选择对象创建，即绑定到新版本。' });
      return base;
    }

    var undef = firstUndefRef(state, geom, refs);
    function depSteps() {
      var closure = goalClosure(state, g);
      var out = [];
      closure.forEach(function (id) {
        var rc = R.recs[id];
        if (rc) {
          rc.lines.forEach(function (ln) {
            out.push({ level: rc.status === 'undef' ? 'undef' : (rc.status === 'warn' ? 'warn' : 'note'),
              title: rc.head, detail: ln });
          }); }
      });
      return out;
    }

    function undefVerdict() {
      base.status = 'undef';
      base.headline = '未定义：关系所依赖的对象目前不存在（平行 / 重合 / 无交点 / 零长度等退化）。';
      base.steps = depSteps();
      var uo = getObj(state, undef.id);
      base.steps.push({ level: 'undef', title: '直接原因：' + (uo ? uo.label : undef.id) + ' 未定义',
        detail: undef.msg || '该对象处于退化情形。' });
      base.steps.push({ level: 'note', title: '这意味着什么',
        detail: '不是“成立”，也不是“被推翻”，而是当前位置下该关系没有几何意义 —— 拖动自由点离开退化位置后会重新自动判定。' });
      return base;
    }

    if (undef) return undefVerdict();

    var proof = structuralProof(state, g, geom);
    var L = function (i) { return labelOf(state, refs[i]); };

    function numericVerdict(equal, diff, epsText, measureLines, nearThreshold) {
      // 三值 + 接近带：equal 仅在严格带内成立
      base.steps = depSteps();
      measureLines.forEach(function (ln, i) {
        base.steps.push({ level: 'note', title: i === 0 ? '数值计算' : ' ', detail: ln });
      });
      base.steps.push({ level: 'note', title: '容差取舍',
        detail: '严格带 ' + epsText + ' 内才允许数值判“成立”；1e-6 接近带内只给“接近”提示，绝不冒充成立。' });
      if (proof) {
        base.status = 'ok'; base.mode = 'constructive';
        base.headline = '成立（由构造保证）';
        base.steps.unshift({ level: 'ok', title: '构造证明', detail: proof });
        base.measured = measureLines[0] || '';
        return base;
      }
      if (equal) {
        base.status = 'ok'; base.mode = 'numeric';
        base.headline = '成立（数值判定）';
        base.steps.unshift({ level: 'ok', title: '判定', detail: '差值在严格容差带内，按数值相等判定（浮点意义下成立）。' });
      } else {
        base.status = 'bad';
        if (diff <= nearThreshold) {
          base.near = true;
          base.headline = '不成立（很接近，但不判为成立）';
          base.steps.unshift({ level: 'warn', title: '判定',
            detail: '差值落在 1e-6 接近带内：图形“几乎”满足，但严格来说不成立。请自行检查作图是否有误差。' });
        } else {
          base.headline = '不成立';
          base.steps.unshift({ level: 'bad', title: '判定', detail: '差值超出容差带，关系被推翻。' });
        }
      }
      return base;
    }

    switch (g.kind) {
      case 'lenEq': {
        var l1 = pointLen(geom, refs[0], refs[1]);
        var l2 = pointLen(geom, refs[2], refs[3]);
        // 先看构造证明：同线段、同圆半径、中点分段 —— 零线段也不影响这些关系成立
        proof = structuralProof(state, g, geom);
        if (proof) {
          base.status = 'ok'; base.mode = 'constructive';
          base.headline = '成立（由构造保证）';
          base.steps = depSteps();
          base.steps.unshift({ level: 'ok', title: '构造证明', detail: proof });
          base.measured = L(0) + L(1) + '=' + fmt(l1) + '，' + L(2) + L(3) + '=' + fmt(l2) +
            '（由构造，无需比较浮点）';
          return base;
        }
        // 任一比较的线段退化为零长度（端点重合）：“待证长度关系”未定义，而非凑巧相等
        if (l1 === 0 || l2 === 0) {
          base.status = 'undef';
          base.headline = '未定义：其中一条线段两端点重合（零长度），长度比较失去意义。';
          base.steps = depSteps();
          base.steps.push({ level: 'undef', title: '零长度',
            detail: L(0) + L(1) + ' = ' + fmt(l1) + '，' + L(2) + L(3) + ' = ' + fmt(l2) +
              '。长度关系要求两条线段都有确定的正长度；不允许把“0=0”冒充为待证成立。' });
          return base;
        }
        var dl = Math.abs(l1 - l2);
        base.measured = L(0) + L(1) + '=' + fmt(l1) + '，' + L(2) + L(3) + '=' + fmt(l2) +
          '，差=' + fmt(dl) + '，ε=' + fmt(eps);
        return numericVerdict(dl <= eps, dl, 'ε = 1e-9·S = ' + fmt(eps), [
          L(0) + L(1) + ' = ' + fmt(l1) + '，' + L(2) + L(3) + ' = ' + fmt(l2) + '。',
          '差值 |…| = ' + fmt(dl) + '，图形尺度 S = ' + fmt(S) + '，严格 ε = ' + fmt(eps) +
            '，接近带上限 = ' + fmt(near) + '。'
        ], near);
      }
      case 'angEq': {
        var a1 = angleAt(geom, refs[0], refs[1], refs[2]);
        var a2 = angleAt(geom, refs[3], refs[4], refs[5]);
        if (a1.degenerate || a2.degenerate) {
          // 角未定义（零射线）——对象虽“存在”但角度本身退化
          base.status = 'undef';
          base.headline = '未定义：角的两条射线之一长度为 0（顶点与端点重合）。';
          base.steps = depSteps();
          base.steps.push({ level: 'undef', title: '退化角度',
            detail: '角度要求从顶点出发的两条射线都非零；零长度射线没有方向。' });
          return base;
        }
        var da = Math.abs(a1.value - a2.value);
        base.measured = '∠' + L(0) + L(1) + L(2) + '=' + fmt(deg(a1.value), 6) + '°，∠' +
          L(3) + L(4) + L(5) + '=' + fmt(deg(a2.value), 6) + '°，差=' + fmt(deg(da), 6) + '°';
        return numericVerdict(da <= ANG_STRICT, da, '角度 ε = 1e-9 rad（≈' + fmt(deg(ANG_STRICT), 9) + '°）', [
          '∠' + L(0) + L(1) + L(2) + ' = ' + fmt(deg(a1.value), 6) + '°，∠' +
            L(3) + L(4) + L(5) + ' = ' + fmt(deg(a2.value), 6) + '°。',
          '差值 = ' + fmt(da, 10) + ' rad（' + fmt(deg(da), 6) + '°），严格 ε = ' + ANG_STRICT +
            ' rad，接近带 = ' + ANG_NEAR + ' rad。'
        ], ANG_NEAR);
      }
      case 'parallel': {
        var X = geom[refs[0]], Y = geom[refs[1]];
        var cr = Math.abs(X.dx * Y.dy - X.dy * Y.dx);
        var sep = Math.abs((Y.ox - X.ox) * X.dy - (Y.oy - X.oy) * X.dx);
        if (sep <= eps && cr <= ANG_STRICT) {
          base.status = 'undef';
          base.headline = '未定义：两直线重合，“平行（不相交）”在退化情形下不定义。';
          base.steps = depSteps();
          base.steps.push({ level: 'undef', title: '重合',
            detail: '方向相同（叉积≈0）且两线间距≈0：它们是同一条直线，无穷多个公共点，既不是普通平行也不是相交。' });
          return base;
        }
        return numericVerdict(cr <= ANG_STRICT, cr, '角度 ε = 1e-9 rad', [
          '两方向叉积 |u×v| = ' + fmt(cr, 4) + '（即夹角 ' + fmt(deg(Math.asin(Math.min(1, cr))), 6) + '°）。',
          '严格阈值 = ' + ANG_STRICT + ' rad，接近带 = ' + ANG_NEAR + ' rad；两线间距 = ' + fmt(sep) + ' ≠ 0（非重合）。'
        ], ANG_NEAR);
      }
      case 'perpendicular': {
        var Xp = geom[refs[0]], Yp = geom[refs[1]];
        var crp = Math.abs(Xp.dx * Yp.dy - Xp.dy * Yp.dx);
        var sepp = Math.abs((Yp.ox - Xp.ox) * Xp.dy - (Yp.oy - Xp.oy) * Xp.dx);
        if (sepp <= eps && crp <= ANG_STRICT) {
          base.status = 'undef';
          base.headline = '未定义：两直线重合，不可能垂直。';
          base.steps = depSteps();
          base.steps.push({ level: 'undef', title: '重合', detail: '两线本是同一条，夹角为 0° 而非 90°，属退化情形。' });
          return base;
        }
        var dp = Math.abs(Xp.dx * Yp.dx + Xp.dy * Yp.dy);
        return numericVerdict(dp <= ANG_STRICT, dp, '角度 ε = 1e-9 rad', [
          '两方向点积 |u·v| = ' + fmt(dp, 4) + '（垂直时点积应为 0；当前夹角 ' +
            fmt(deg(Math.acos(clamp(Math.abs(Xp.dx * Yp.dx + Xp.dy * Yp.dy), -1, 1))), 6) + '°）。',
          '严格阈值 = ' + ANG_STRICT + ' rad，接近带 = ' + ANG_NEAR + ' rad。'
        ], ANG_NEAR);
      }
      case 'tangentLC': {
        var Lg = geom[refs[0]], Cg = geom[refs[1]];
        var nx = -Lg.dy, ny = Lg.dx;
        var hv = Math.abs((Cg.cx - Lg.ox) * nx + (Cg.cy - Lg.oy) * ny);
        var dh = Math.abs(hv - Cg.r);
        base.measured = 'h=' + fmt(hv) + '，r=' + fmt(Cg.r) + '，|h−r|=' + fmt(dh) + '，ε=' + fmt(eps);
        var lines = ['圆心到直线距离 h = ' + fmt(hv) + '，半径 r = ' + fmt(Cg.r) + '，|h−r| = ' + fmt(dh) + '。'];
        if (hv - Cg.r > eps) {
          base.status = 'bad'; base.headline = '不成立：直线在圆外，二者无交点（不是相切）。';
          base.steps = depSteps();
          lines.push('h > r：0 个公共点。无交点使“相切”失效（不是未定义，而是明确不成立）。');
          if (hv - Cg.r <= near) { base.near = true; lines.push('差值在接近带内：很接近相切，但不判为成立。'); }
          lines.forEach(function (x) { base.steps.push({ level: 'bad', title: '相切判定', detail: x }); });
          if (proof) base.steps.unshift({ level: 'ok', title: '构造证明', detail: proof });
          return base;
        }
        if (hv < Cg.r - eps) {
          base.status = 'bad'; base.headline = '不成立：直线割圆于两点（相割，不是相切）。';
          base.steps = depSteps();
          lines.push('h < r：有 2 个交点，是相割关系。');
          if (Cg.r - hv <= near) { base.near = true; lines.push('弦很短，接近相切，但不判为成立。'); }
          lines.forEach(function (x) { base.steps.push({ level: 'bad', title: '相切判定', detail: x }); });
          if (proof) base.steps.unshift({ level: 'ok', title: '构造证明', detail: proof });
          return base;
        }
        return numericVerdict(true, dh, 'ε = 1e-9·S = ' + fmt(eps), lines, near);
      }
      case 'tangentCC': {
        var C1 = geom[refs[0]], C2 = geom[refs[1]];
        var dd = Math.hypot(C2.cx - C1.cx, C2.cy - C1.cy);
        var ext = Math.abs(dd - (C1.r + C2.r));
        var intn = Math.abs(dd - Math.abs(C1.r - C2.r));
        if (dd <= eps && Math.abs(C1.r - C2.r) <= eps) {
          base.status = 'undef';
          base.headline = '未定义：两圆重合，有无穷多个公共点，“相切（唯一公共点）”不定义。';
          base.steps = depSteps();
          base.steps.push({ level: 'undef', title: '重合', detail: '同心且同半径，两圆完全重合，属于退化情形。' });
          return base;
        }
        var isTan = ext <= eps || intn <= eps;
        var kind = ext <= eps ? '外切（d=r₁+r₂）' : '内切（d=|r₁−r₂|）';
        var lines = ['圆心距 d = ' + fmt(dd) + '，r₁+r₂ = ' + fmt(C1.r + C2.r) +
          '，|r₁−r₂| = ' + fmt(Math.abs(C1.r - C2.r)) + '。'];
        if (isTan) lines.push('差值满足 ' + kind + '，恰有一个公共点。');
        else {
          lines.push('两个相切条件都不满足。');
          if (dd > C1.r + C2.r) lines.push('d > r₁+r₂：两圆分离，无交点 → 相切失效。');
          else if (dd < Math.abs(C1.r - C2.r)) lines.push('d < |r₁−r₂|：内含（不同心），无交点 → 相切失效。');
          else lines.push('|r₁−r₂| < d < r₁+r₂：两圆相交于两点，不是相切。');
          if (Math.min(ext, intn) <= near) { base.near = true; lines.push('（差值在接近带内，接近相切，但不判为成立。）'); }
        }
        return numericVerdict(isTan, Math.min(ext, intn), 'ε = 1e-9·S = ' + fmt(eps), lines, near);
      }
      case 'onLine': {
        var Pg = geom[refs[0]], L0 = geom[refs[1]];
        var dist = Math.abs((Pg.x - L0.ox) * L0.dy - (Pg.y - L0.oy) * L0.dx);
        return numericVerdict(dist <= eps, dist, 'ε = 1e-9·S = ' + fmt(eps), [
          '点到直线的垂直距离 = ' + fmt(dist) + '（图形尺度 S = ' + fmt(S) + '）。',
          '严格 ε = ' + fmt(eps) + '，接近带上限 = ' + fmt(near) + '。'
        ]);
      }
      case 'onCircle': {
        var Pg2 = geom[refs[0]], C0 = geom[refs[1]];
        var dc = Math.abs(Math.hypot(Pg2.x - C0.cx, Pg2.y - C0.cy) - C0.r);
        return numericVerdict(dc <= eps, dc, 'ε = 1e-9·S = ' + fmt(eps), [
          '点到圆心距离 = ' + fmt(Math.hypot(Pg2.x - C0.cx, Pg2.y - C0.cy)) + '，半径 r = ' + fmt(C0.r) +
            '，差值 = ' + fmt(dc) + '。',
          '严格 ε = ' + fmt(eps) + '，接近带上限 = ' + fmt(near) + '。'
        ]);
      }
    }
    return base;
  }

  // 关系涉及对象的全部依赖闭包（按作图顺序）
  function goalClosure(state, g) {
    var seen = {};
    function walk(id) {
      if (seen[id]) return;
      seen[id] = true;
      var o = getObj(state, id);
      if (o) depRefs(o).forEach(walk);
    }
    g.refs.forEach(walk);
    return state.objs.filter(function (o) { return seen[o.id]; }).map(function (o) { return o.id; });
  }

  /* ---------------- JSON 归一化 / 导入导出 ---------------- */

  function exportJSON(state) {
    // 导出前把最新坐标写进可携带点对象（主线程会先 evaluate 一次）
    return JSON.stringify({
      app: 'degenerate-geometry-workbench',
      fileVersion: 1,
      exportedAt: new Date().toISOString(),
      state: clone(state)
    }, null, 2);
  }

  // 校验 + 归一化。返回 {ok, state, errors:[], warnings:[]}
  function importJSON(text) {
    var data, errors = [], warnings = [];
    try { data = JSON.parse(text); }
    catch (e) { return { ok: false, errors: ['JSON 解析失败：' + e.message] }; }
    if (!data || typeof data !== 'object') return { ok: false, errors: ['文件格式不正确'] };
    var st = data.state || data; // 也接受直接是 state
    if (!st || !Array.isArray(st.objs) || !Array.isArray(st.goals))
      return { ok: false, errors: ['缺少 state.objs / state.goals'] };

    var state = createState();
    var idmap = {};
    var validTypes = Object.keys(TYPE_NAME);

    // 1) 基本字段校验
    for (var i = 0; i < st.objs.length; i++) {
      var raw = st.objs[i];
      if (!raw || typeof raw !== 'object' || validTypes.indexOf(raw.type) < 0) {
        errors.push('第 ' + (i + 1) + ' 个图元类型无效，已忽略');
        continue;
      }
      var o = { type: raw.type };
      if (raw.type === 'point') {
        if (typeof raw.x !== 'number' || typeof raw.y !== 'number' || !isFinite(raw.x) || !isFinite(raw.y)) {
          errors.push('自由点坐标无效（第 ' + (i + 1) + ' 个图元）');
          continue;
        }
        o.x = raw.x; o.y = raw.y;
      } else if (raw.type === 'pointOn') {
        o.host = raw.host; o.param = typeof raw.param === 'number' ? raw.param : 0;
        o.x = typeof raw.x === 'number' ? raw.x : null;
        o.y = typeof raw.y === 'number' ? raw.y : null;
      } else {
        ['a', 'b', 'c', 'r', 'p', 'l'].forEach(function (k) {
          if (raw[k] != null) o[k] = raw[k];
        });
        if (raw.type === 'intersection') o.which = raw.which === 1 ? 1 : 0;
      }
      var newId = 'o' + (state.nextId++);
      idmap[raw.id] = newId;
      o.id = newId;
      o._origIdx = state.objs.length;
      state.objs.push(o);
    }
    // 重映射引用
    state.objs.forEach(function (o) {
      ['host', 'a', 'b', 'c', 'r', 'p', 'l'].forEach(function (k) {
        if (o[k] !== undefined) {
          if (idmap[o[k]] === undefined) {
            errors.push('图元 ' + o.id + ' 引用了不存在的 ' + k + '=' + o[k]);
            o._bad = true;
          } else o[k] = idmap[o[k]];
        }
      });
    });
    // 2) 删除引用不合法 / 类型不合法的图元（迭代到不动点）
    var changed = true;
    while (changed) {
      changed = false;
      state.objs = state.objs.filter(function (o) {
        if (o._bad) { changed = true; return false; }
        var err = checkRefs(state, o);
        if (err) { warnings.push((TYPE_NAME[o.type] || o.type) + '（' + o.id + '）因引用问题被移除：' + err); changed = true; return false; }
        return true;
      });
    }

    // 3) 拓扑排序（Kahn，平局按原始下标 —— 彩色签名不受影响）
    var live = {};
    state.objs.forEach(function (o) {
      live[o.id] = true;
      o._origIdx = (o._origIdx == null) ? state.objs.indexOf(o) : o._origIdx;
    });
    var indeg = {}, dependents = {};
    state.objs.forEach(function (o) {
      indeg[o.id] = 0; dependents[o.id] = [];
    });
    state.objs.forEach(function (o) {
      depRefs(o).forEach(function (d) {
        if (live[d]) { indeg[o.id]++; dependents[d].push(o.id); }
      });
    });
    var order = [], queue = state.objs.filter(function (o) { return indeg[o.id] === 0; })
      .map(function (o) { return o.id; });
    var byId = {};
    state.objs.forEach(function (o) { byId[o.id] = o; });
    while (queue.length) {
      queue.sort(function (a, b) { return byId[a]._origIdx - byId[b]._origIdx; });
      var id = queue.shift();
      order.push(id);
      dependents[id].forEach(function (d) {
        if (byId[d] && --indeg[d] === 0) queue.push(d);
      });
    }
    if (order.length !== state.objs.length)
      return { ok: false, errors: ['依赖图存在循环，无法作图'] };
    state.objs = order.map(function (id) { var o = byId[id]; delete o._origIdx; delete o._bad; return o; });
    assignLabels(state);

    // 4) 顺序求值一遍，借携带坐标重吸约束参数（缩放/平移/换序不变性）
    var snap = evaluate(state, { importSnap: true });

    // 5) 关系导入与重绑定判定
    st.goals.forEach(function (rg) {
      if (!rg || !GOAL_DEFS[rg.kind] || !Array.isArray(rg.refs)) return;
      var refs = rg.refs.map(function (x) { return idmap[x]; });
      if (refs.some(function (x) { return x === undefined || !byId[x]; })) {
        warnings.push('待证关系 ' + rg.kind + ' 引用了缺失对象，已忽略');
        return;
      }
      var def = GOAL_DEFS[rg.kind];
      var typeOk = refs.every(function (x, i) { return kindOf(byId[x].type) === def.kinds[i]; });
      if (!typeOk) { warnings.push('待证关系 ' + rg.kind + ' 参数类型不匹配，已忽略'); return; }
      var g = { id: 'g' + (state.nextId++), kind: rg.kind, refs: refs,
        boundSig: typeof rg.boundSig === 'string' ? rg.boundSig : goalSig(rg.kind, refs, computeColors(state)) };
      state.goals.push(g);
    });
    assignLabels(state);
    // 再求值一次（标签已就位）
    var final = evaluate(state);
    state.goals.forEach(function (g) {
      var cur = goalSig(g.kind, g.refs, computeColors(state));
      if (cur !== g.boundSig)
        warnings.push('待证关系 “' + goalDisplayName(g, state) + '” 绑定的是旧构造版本，已标为版本失配，请重新创建');
    });
    return { ok: true, state: state, errors: errors, warnings: warnings, result: final };
  }

  /* ---------------- 导出 ---------------- */

  var Kernel = {
    STRICT: STRICT, NEAR: NEAR, ANG_STRICT: ANG_STRICT, ANG_NEAR: ANG_NEAR,
    GOAL_DEFS: GOAL_DEFS, TYPE_NAME: TYPE_NAME,
    createState: createState, clone: clone,
    getObj: getObj, getGoal: getGoal,
    kindOf: kindOf, depRefs: depRefs, depRoles: depRoles,
    addObject: addObject, addGoal: addGoal, movePoint: movePoint,
    deleteCascade: deleteCascade, applyDelete: applyDelete,
    goalDisplayName: goalDisplayName, goalClosure: goalClosure,
    computeColors: computeColors, constructionSignature: constructionSignature,
    currentGoalSig: currentGoalSig,
    evaluate: evaluate,
    assignLabels: assignLabels,
    exportJSON: exportJSON, importJSON: importJSON,
    labelOf: labelOf
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Kernel;
  else global.Kernel = Kernel;
})(typeof self !== 'undefined' ? self : globalThis);
