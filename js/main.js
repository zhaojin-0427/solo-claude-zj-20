/*
 * main.js —— 退化几何作图验算台 · 主线程
 * 职责：SVG 渲染与拾取、拖拽、工具状态机、撤销（事务快照）、
 *       级联删除对话框、JSON 保存/导入、修订号闸门。
 * 几何计算全部走 Web Worker；若浏览器禁止 file:// Worker，则自动降级为
 * 同内核同步计算，判定逻辑完全一致，断网可用。
 */
(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var SVGNS = 'http://www.w3.org/2000/svg';

  /* ---------------- 全局状态 ---------------- */

  var state = Kernel.createState();
  var history = [];          // 撤销栈：每次结构操作 / 每次拖拽开始前的完整快照
  var HISTORY_MAX = 120;

  var rev = 0;               // 当前修订号（只有 == rev 的 Worker 结果会被接纳）
  var acceptedRev = 0;
  var droppedStale = 0;      // 迟到结果被丢弃的次数
  var lastResult = null;     // 最近接纳的求值结果
  var evalRaf = 0;
  var worker = null;
  var workerMode = 'init';   // init / worker / fallback

  var mode = null;           // {kind:'tool'|'goal', tool, picks:[]}
  var selectedId = null;
  var selectedGoalId = null;

  var view = { scale: 60, tx: 0, ty: 0 };
  var drag = null;           // 拖拽中的点
  var pan = null;

  var scene = $('#scene'), canvas = $('#canvas');

  /* ---------------- Worker 初始化（含降级） ---------------- */

  function initWorker() {
    try {
      worker = new Worker('js/worker.js');
      workerMode = 'worker';
      worker.onmessage = function (ev) {
        var msg = ev.data;
        if (msg.type === 'boot-error') { goFallback('Worker 启动失败：' + msg.message); return; }
        if (msg.type === 'error') {
          if (msg.rev === rev) console.error('内核错误 rev=' + msg.rev, msg.message);
          return;
        }
        if (msg.rev !== rev) {
          // 修订号闸门：迟到结果（哪怕内容正确）一律丢弃，绝不覆盖新状态
          droppedStale++;
          updateStatusBar();
          return;
        }
        if (msg.type === 'eval') acceptResult(msg.result);
        else if (msg.type === 'import') acceptImport(msg.payload);
      };
      worker.onerror = function (e) {
        goFallback('Worker 错误：' + e.message);
      };
    } catch (e) {
      goFallback('无法创建 Worker：' + e.message);
    }
  }
  var fellBack = false;
  function goFallback(reason) {
    if (fellBack) return;
    fellBack = true;
    workerMode = 'fallback';
    if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
    setKernelInfo('同步内核（' + reason + '）');
    runEval();
  }

  function runEval(importSnap) {
    rev++;
    updateStatusBar();
    if (workerMode === 'worker' && worker) {
      // 传快照：Worker 的任何写回（如约束点坐标）都不会污染主线程状态
      worker.postMessage({ type: 'eval', rev: rev, state: Kernel.clone(state), importSnap: !!importSnap });
    } else {
      var result = Kernel.evaluate(state, { rev: rev, importSnap: !!importSnap });
      acceptResult(result);
    }
  }
  function scheduleEval() {
    if (evalRaf) return;
    evalRaf = requestAnimationFrame(function () { evalRaf = 0; runEval(); });
  }

  function acceptResult(result) {
    acceptedRev = result.rev;
    lastResult = result;
    // 把点的最新坐标写回主状态，保证保存的 JSON 与画面一致
    state.objs.forEach(function (o) {
      var g = result.geom[o.id];
      if (g && g.g === 'p' && g.defined) { o.x = g.x; o.y = g.y; }
    });
    render();
    renderLists();
    renderSteps();
    updateStatusBar();
  }

  /* ---------------- 撤销 ---------------- */

  function pushHistory() {
    history.push(Kernel.clone(state));
    if (history.length > HISTORY_MAX) history.shift();
    $('#btn-undo').disabled = false;
  }
  function undo() {
    // 拖动中途撤销：先结束拖拽（不提交），再回到快照 —— 依赖图始终一致
    if (drag) {
      try { canvas.releasePointerCapture(drag.pid); } catch (e) {}
      drag = null;
    }
    mode = null; updateModeBanner();
    if (!history.length) { toast('没有可撤销的操作'); return; }
    state = history.pop();
    selectedId = null;
    $('#btn-undo').disabled = history.length === 0;
    runEval();
  }

  /* ---------------- 工具状态机 ---------------- */

  function startTool(tool) {
    mode = { kind: 'tool', tool: tool, picks: [] };
    selectedId = null;
    updateModeBanner(); render();
  }
  function startGoal(kind) {
    mode = { kind: 'goal', goal: kind, picks: [] };
    selectedId = null;
    updateModeBanner(); render();
  }
  function cancelMode() { mode = null; updateModeBanner(); render(); }

  var TOOL_SPECS = {
    line2: { kinds: ['point', 'point'], verb: ['选择第 1 个点', '选择第 2 个点（直线过这两点）'] },
    linePar: { kinds: ['point', 'line'], verb: ['选择平行线经过的点', '选择参考直线'] },
    linePerp: { kinds: ['point', 'line'], verb: ['选择垂线经过的点', '选择参考直线'] },
    circle: { kinds: ['point', 'point'], verb: ['选择圆心', '选择圆上一点（确定半径）'] },
    mid: { kinds: ['point', 'point'], verb: ['选择第 1 个端点', '选择第 2 个端点'] }
  };

  function pickSpec() {
    if (!mode) return null;
    if (mode.kind === 'goal') return { kinds: Kernel.GOAL_DEFS[mode.goal].kinds,
      verbs: Kernel.GOAL_DEFS[mode.goal].kinds.map(function (k, i) { return '选择第 ' + (i + 1) + ' 个对象（' + kindCN(k) + '）'; }) };
    if (mode.tool === 'inter') return { kinds: null, verbs: ['选择第 1 条直线/圆', '选择第 2 条直线/圆'] };
    var s = TOOL_SPECS[mode.tool];
    return s ? { kinds: s.kinds, verbs: s.verb } : null;
  }

  function kindCN(k) { return k === 'point' ? '点' : k === 'line' ? '直线' : '圆'; }

  function updateModeBanner() {
    var banner = $('#mode-banner');
    if (!mode) { banner.classList.add('hidden'); return; }
    banner.classList.remove('hidden');
    var spec = pickSpec();
    var text;
    if (mode.kind === 'tool' && mode.tool === 'pointOn') {
      text = '约束点：直接单击一条直线或一个圆，点将被约束在该对象上';
    } else if (mode.kind === 'tool' && mode.tool === 'point') {
      text = '自由点：在空白处单击放置（可随时拖动）';
    } else if (spec) {
      text = spec.verbs[mode.picks.length] || '处理中…';
      if (mode.picks.length) text += '　已选：' + mode.picks.map(labelOf).join('、');
    } else {
      text = '选择对象…';
    }
    $('#mode-text').textContent = text;
  }

  // 画布上的拾取（点 / 直线 / 圆）
  function handleCanvasPick(id) {
    var o = Kernel.getObj(state, id);
    if (!o || !lastResult) return;
    var g = lastResult.geom[id];

    if (mode && mode.kind === 'tool' && mode.tool === 'pointOn') {
      createPointOn(o, g);
      return;
    }
    if (!mode) { selectedId = (selectedId === id ? null : id); render(); renderLists(); return; }

    var kd = Kernel.kindOf(o.type);
    if (mode.kind === 'tool' && mode.tool === 'inter') {
      if (kd !== 'line' && kd !== 'circle') { toast('交点工具只能选直线或圆'); return; }
      if (mode.picks.indexOf(id) >= 0) { toast('不能选择同一个对象两次'); return; }
      mode.picks.push(id);
      if (mode.picks.length === 2) { var pair = mode.picks.slice(); mode = null; updateModeBanner(); createIntersections(pair); }
      else updateModeBanner();
      render();
      return;
    }

    var spec = pickSpec();
    if (!spec) return;
    var need = spec.kinds[mode.picks.length];
    if (kd !== need) { toast('这里需要选择' + kindCN(need)); return; }
    mode.picks.push(id);
    if (mode.picks.length === spec.kinds.length) {
      var picks = mode.picks.slice();
      var wasMode = mode;
      mode = null; updateModeBanner();
      if (wasMode.kind === 'tool') commitTool(wasMode.tool, picks);
      else commitGoal(wasMode.goal, picks);
    } else updateModeBanner();
    render();
  }

  /* ---------------- 创建操作（均为撤销栈上的原子事务） ---------------- */

  function commitTool(tool, picks) {
    pushHistory();
    var opts = {}, res;
    switch (tool) {
      case 'line2': res = Kernel.addObject(state, 'line2', { a: picks[0], b: picks[1] }); break;
      case 'linePar': res = Kernel.addObject(state, 'linePar', { p: picks[0], l: picks[1] }); break;
      case 'linePerp': res = Kernel.addObject(state, 'linePerp', { p: picks[0], l: picks[1] }); break;
      case 'circle': res = Kernel.addObject(state, 'circle', { c: picks[0], r: picks[1] }); break;
      case 'mid': res = Kernel.addObject(state, 'midpoint', { a: picks[0], b: picks[1] }); break;
      default: res = { ok: false, error: '未知工具' };
    }
    finishCommit(res);
  }

  function createPointOn(hostObj, hostGeom) {
    if (!hostGeom || !hostGeom.defined) { toast('宿主对象未定义，无法在其上取点'); return; }
    var w = screenToWorld(lastPointer.x, lastPointer.y);
    // 从图元列表点选宿主时没有有效的画布指针：取基点 / 角度 0 作为默认位置
    var cr = canvas.getBoundingClientRect();
    var validPointer = lastPointer.x >= cr.left && lastPointer.x <= cr.right &&
      lastPointer.y >= cr.top && lastPointer.y <= cr.bottom;
    var param;
    if (!validPointer) {
      param = hostGeom.g === 'l' ? 0.5 : 0;
    } else if (hostGeom.g === 'l') {
      var lv2 = hostGeom.vx * hostGeom.vx + hostGeom.vy * hostGeom.vy;
      param = lv2 > 0 ? ((w.x - hostGeom.ox) * hostGeom.vx + (w.y - hostGeom.oy) * hostGeom.vy) / lv2 : 0;
    } else {
      param = Math.atan2(w.y - hostGeom.cy, w.x - hostGeom.cx);
    }
    pushHistory();
    var res = Kernel.addObject(state, 'pointOn', { host: hostObj.id, param: param, x: w.x, y: w.y });
    mode = null; updateModeBanner();
    finishCommit(res);
  }

  function createIntersections(pair) {
    pushHistory();
    var r1 = Kernel.addObject(state, 'intersection', { a: pair[0], b: pair[1], which: 0 });
    if (!r1.ok) { history.pop(); toast(r1.error); runEval(); return; }
    var t1 = Kernel.kindOf(Kernel.getObj(state, pair[0]).type);
    var t2 = Kernel.kindOf(Kernel.getObj(state, pair[1]).type);
    var secondId = null;
    if (t1 !== 'line' || t2 !== 'line') {
      // 直线×圆 / 圆×圆 可能有两个交点：先建第二个候选，求值后按情况在同一事务内收敛
      var r2 = Kernel.addObject(state, 'intersection', { a: pair[0], b: pair[1], which: 1 });
      if (r2.ok) secondId = r2.id;
    }
    var probe = Kernel.evaluate(state);
    if (secondId) {
      var g1 = probe.geom[r1.id], g2 = probe.geom[secondId];
      var keep = g1.defined && g2.defined &&
        Math.hypot(g1.x - g2.x, g1.y - g2.y) > Math.max(probe.eps, 1e-12);
      if (!keep) {
        // 相切（两点重合）或无交点：只保留一个图元，避免列表里出现重复/成对未定义
        state.objs = state.objs.filter(function (o) { return o.id !== secondId; });
        Kernel.assignLabels(state);
      }
    }
    var g = probe.geom[r1.id];
    if (!g.defined) toast('该交点当前未定义：' + g.msg + '（图元已保留，拖动自由点离开退化位置可恢复）');
    runEval();
  }

  function commitGoal(kind, picks) {
    pushHistory();
    var res = Kernel.addGoal(state, kind, picks);
    if (res.ok) { selectedGoalId = res.id; }
    finishCommit(res);
  }

  function finishCommit(res) {
    if (!res.ok) { history.pop(); toast(res.error); }
    runEval();
  }

  function addFreePoint(wx, wy) {
    pushHistory();
    var res = Kernel.addObject(state, 'point', { x: wx, y: wy });
    finishCommit(res);
  }

  /* ---------------- 级联删除 ---------------- */

  function requestDelete(id) {
    var cas = Kernel.deleteCascade(state, id);
    if (!cas.objects.length) return;
    var direct = cas.objects.filter(function (x) { return x.direct; })[0];
    $('#delete-lead').innerHTML = '要删除 <b class="direct">' + direct.label + '（' + direct.typeName + '）</b>，'
      + '以下对象直接或间接依赖它，必须一并删除：';

    // 构造依赖链说明
    var byId = {};
    cas.objects.forEach(function (x) { byId[x.id] = x; });
    var html = '<ul>';
    cas.objects.forEach(function (x) {
      if (x.direct) {
        html += '<li class="direct">' + x.label + '（' + x.typeName + '）— 直接删除的目标</li>';
      } else {
        var via = byId[x.via];
        html += '<li class="indirect">' + x.label + '（' + x.typeName + '）— 依赖 ' +
          (via ? via.label : x.via) + '，连带删除</li>';
      }
    });
    html += '</ul>';
    if (cas.goals.length) {
      html += '<div class="goal-hit">受影响的待证关系：</div><ul>';
      cas.goals.forEach(function (gg) {
        html += '<li class="goal-hit">' + gg.name + '（引用了被删对象）</li>';
      });
      html += '</ul>';
    }
    $('#delete-cascade').innerHTML = html;
    $('#modal-delete').dataset.target = id;
    $('#modal-delete').classList.remove('hidden');
  }
  function confirmDelete() {
    var id = $('#modal-delete').dataset.target;
    $('#modal-delete').classList.add('hidden');
    if (!id) return;
    pushHistory();
    Kernel.applyDelete(state, id);
    if (selectedGoalId && !Kernel.getGoal(state, selectedGoalId)) selectedGoalId = null;
    selectedId = null;
    runEval();
  }

  /* ---------------- 渲染：SVG ---------------- */

  function labelOf(id) {
    var o = Kernel.getObj(state, id);
    return o ? o.label : '?';
  }
  function el(name, attrs) {
    var e = document.createElementNS(SVGNS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function render() {
    scene.innerHTML = '';
    if (!lastResult) { applyView(); return; }
    var geom = lastResult.geom;
    var shapes = document.createElementNS(SVGNS, 'g');
    var points = document.createElementNS(SVGNS, 'g');
    scene.appendChild(shapes);
    scene.appendChild(points);

    state.objs.forEach(function (o) {
      var g = geom[o.id];
      if (!g) return;
      if (g.g === 'l' && g.defined) drawLine(shapes, o, g);
      else if (g.g === 'c' && g.defined) drawCircle(shapes, o, g);
    });
    state.objs.forEach(function (o) {
      var g = geom[o.id];
      if (!g || g.g !== 'p') return;
      drawPoint(points, o, g);
    });
    applyView();
  }

  function drawLine(parent, o, g) {
    var L = 10000 / view.scale;
    var x1 = g.ox - g.dx * L, y1 = g.oy - g.dy * L;
    var x2 = g.ox + g.dx * L, y2 = g.oy + g.dy * L;
    var sel = o.id === selectedId;
    parent.appendChild(el('line', {
      x1: x1, y1: y1, x2: x2, y2: y2,
      class: 'geom-line' + (sel ? ' obj-selected' : '') + (g.nearDegen ? ' geom-ghost' : '')
    }));
    var hit = el('line', { x1: x1, y1: y1, x2: x2, y2: y2, class: 'pick-target', 'data-id': o.id });
    parent.appendChild(hit);
  }
  function drawCircle(parent, o, g) {
    var sel = o.id === selectedId;
    parent.appendChild(el('circle', {
      cx: g.cx, cy: g.cy, r: g.r,
      class: 'geom-circle' + (sel ? ' obj-selected' : '') + (g.nearDegen ? ' geom-ghost' : '')
    }));
    parent.appendChild(el('circle', {
      cx: g.cx, cy: g.cy, r: g.r, class: 'pick-target-circle', 'data-id': o.id
    }));
  }
  function drawPoint(parent, o, g) {
    var pr = 6 / view.scale;
    var cls = 'pt';
    if (!g.defined) cls += ' undefp';
    else if (o.type === 'point') cls += ' free';
    else if (o.type === 'pointOn') cls += ' on';
    else if (o.type === 'intersection') cls += ' inter';
    if (o.id === selectedId || (mode && mode.picks.indexOf(o.id) >= 0)) cls += ' selected';

    if (g.defined) {
      parent.appendChild(el('circle', { cx: g.x, cy: g.y, r: pr, class: cls, 'data-id': o.id }));
      if (g.tangent) {
        parent.appendChild(el('circle', { cx: g.x, cy: g.y, r: pr * 1.9,
          class: 'tangent-mark', fill: 'none', stroke: '#b07a05', 'stroke-width': 1.5 / view.scale, 'pointer-events': 'none' }));
      }
      var t = el('text', { x: g.x + 9 / view.scale, y: g.y - 8 / view.scale, class: 'pt-label' });
      t.textContent = o.label + (g.defined === false ? '' : '');
      parent.appendChild(t);
    } else {
      // 未定义点：在最后已知位置画虚线空心标记
      if (isFinite(o.x) && isFinite(o.y)) {
        parent.appendChild(el('circle', { cx: o.x, cy: o.y, r: pr, class: cls, 'data-id': o.id }));
        var t2 = el('text', { x: o.x + 9 / view.scale, y: o.y - 8 / view.scale, class: 'pt-label undef-label' });
        t2.textContent = o.label + '?';
        parent.appendChild(t2);
      }
    }
  }

  function applyView() {
    scene.setAttribute('transform', 'translate(' + view.tx + ',' + view.ty + ') scale(' + view.scale + ')');
  }

  function fitView(geom) {
    var xs = [], ys = [];
    state.objs.forEach(function (o) {
      var g = geom[o.id];
      if (g && g.defined) {
        if (g.g === 'p') { xs.push(g.x, g.x); ys.push(g.y, g.y); }
        if (g.g === 'c') { xs.push(g.cx - g.r, g.cx + g.r); ys.push(g.cy - g.r, g.cy + g.r); }
        if (g.g === 'l') { xs.push(g.ox, g.ox + g.dx); ys.push(g.oy, g.oy + g.dy); }
      }
    });
    var rect = canvas.getBoundingClientRect();
    if (!xs.length) { view = { scale: 60, tx: rect.width / 2, ty: rect.height / 2 }; applyView(); return; }
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    var w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
    var scale = Math.min(rect.width / w, rect.height / h) * 0.7;
    scale = Math.max(4, Math.min(scale, 400));
    view = {
      scale: scale,
      tx: rect.width / 2 - (minX + w / 2) * scale,
      ty: rect.height / 2 - (minY + h / 2) * scale
    };
    applyView();
  }

  /* ---------------- 渲染：列表与解释 ---------------- */

  function objDesc(o) {
    var L = function (k) { return labelOf(o[k]); };
    switch (o.type) {
      case 'point': return '(' + fmtNum(o.x) + ', ' + fmtNum(o.y) + ')';
      case 'pointOn': return '在 ' + L('host') + ' 上';
      case 'line2': return '过 ' + L('a') + '、' + L('b');
      case 'linePar': return '过 ' + L('p') + ' ∥ ' + L('l');
      case 'linePerp': return '过 ' + L('p') + ' ⟂ ' + L('l');
      case 'circle': return '圆心 ' + L('c') + '，过 ' + L('r');
      case 'midpoint': return L('a') + L('b') + ' 的中点';
      case 'intersection': return L('a') + ' × ' + L('b') + (o.which ? '（第二交点）' : '');
    }
    return '';
  }
  function fmtNum(v) { return v == null ? '—' : (+v.toFixed(3)).toString(); }

  function renderLists() {
    var ul = $('#obj-list');
    ul.innerHTML = '';
    $('#obj-count').textContent = state.objs.length ? '(' + state.objs.length + ')' : '';
    state.objs.forEach(function (o) {
      var g = lastResult && lastResult.geom[o.id];
      var li = document.createElement('li');
      if (g && !g.defined) li.classList.add('undef');
      if (o.id === selectedId) li.classList.add('selected');
      var undefBadge = (g && !g.defined) ? ' <span class="badge undef">未定义</span>' : '';
      li.innerHTML = '<span class="name">' + o.label + '</span><span class="desc" title="' +
        objDesc(o) + '">' + objDesc(o) + '</span>' + undefBadge +
        '<button class="del" title="删除（含级联）">✕</button>';
      li.addEventListener('click', function (e) {
        if (e.target.classList.contains('del')) { requestDelete(o.id); return; }
        handleCanvasPick(o.id);
      });
      ul.appendChild(li);
    });

    var gul = $('#goal-list');
    gul.innerHTML = '';
    $('#goal-count').textContent = state.goals.length ? '(' + state.goals.length + ')' : '';
    state.goals.forEach(function (g) {
      var gr = null;
      if (lastResult) lastResult.goals.forEach(function (x) { if (x.id === g.id) gr = x; });
      var li = document.createElement('li');
      var st = gr ? gr.status : 'bad';
      li.classList.add({ ok: 'okline', bad: 'badline', undef: 'undefline', stale: 'staleline' }[st]);
      if (gr && gr.near) li.classList.add('warnline');
      if (g.id === selectedGoalId) li.classList.add('selected');
      var badge = {
        ok: '<span class="badge ok">成立' + (gr && gr.mode === 'constructive' ? '·构造' : '·数值') + '</span>',
        bad: '<span class="badge bad">' + (gr && gr.near ? '接近但不成立' : '不成立') + '</span>',
        undef: '<span class="badge undef">未定义</span>',
        stale: '<span class="badge stale">版本失配</span>'
      }[st];
      li.innerHTML = '<div class="gmain"><span class="gtext">' + (gr ? gr.name : g.kind) +
        '</span>' + badge + '<button class="gdel" title="删除关系">✕</button></div>' +
        (gr && gr.measured && st !== 'stale' ? '<div class="gbind">' + gr.measured + '</div>' : '');
      li.addEventListener('click', function (e) {
        if (e.target.classList.contains('gdel')) {
          pushHistory();
          state.goals = state.goals.filter(function (x) { return x.id !== g.id; });
          if (selectedGoalId === g.id) selectedGoalId = null;
          runEval();
          return;
        }
        selectedGoalId = (selectedGoalId === g.id ? null : g.id);
        renderLists(); renderSteps();
      });
      gul.appendChild(li);
    });
  }

  function renderSteps() {
    var box = $('#steps-box');
    if (!selectedGoalId) {
      box.innerHTML = '<p class="muted">单击上方任一待证关系，这里会按依赖顺序展示每一步的计算与判定：'
        + '哪些对象正常、哪里因平行 / 相切 / 重合 / 无交点而变为未定义。</p>';
      return;
    }
    var gr = null;
    if (lastResult) lastResult.goals.forEach(function (x) { if (x.id === selectedGoalId) gr = x; });
    if (!gr) { box.innerHTML = '<p class="muted">无结果。</p>'; return; }

    var html = '<h3>' + gr.name + '</h3>';
    html += '<div class="verdict ' + gr.status + '">' + gr.headline + '</div>';
    if (gr.measured) html += '<div class="muted" style="margin-bottom:8px">测量：' + gr.measured + '</div>';
    html += '<div style="margin:4px 0 8px;font-size:12px;color:var(--ink-soft)">逐步解释（按作图链顺序）：</div>';
    gr.steps.forEach(function (s, i) {
      var tag = '';
      if (s.level === 'ok' && /构造/.test(s.title)) tag = '<span class="step-tag exact">由构造保证</span>';
      html += '<div class="step ' + (s.level === 'warn' ? 'warn' : s.level) + '">' +
        '<span class="step-title">' + (i + 1) + '. ' + (s.title.trim() || '计算') + '</span>' + tag +
        '<div class="step-detail">' + s.detail + '</div></div>';
    });
    if (gr.status === 'ok' && gr.mode === 'numeric') {
      html += '<p class="near-note">说明：本关系为数值判定（差值在 1e-9 严格带内），并非由作图定义直接保证；'
        + '若这是一道证明题，建议改用“构造保证”的作图方式。</p>';
    }
    box.innerHTML = html;
  }

  function updateStatusBar() {
    $('#rev-info').textContent = '修订 rev=' + rev + '，已接纳=' + acceptedRev +
      (droppedStale ? '，迟到丢弃=' + droppedStale : '');
    if (lastResult) {
      $('#status-text').textContent = '当前图形尺度 S=' + fmtNum(lastResult.S) +
        '，严格容差 ε=' + lastResult.eps.toExponential(2) +
        '（=1e-9·S）；接近带 1e-6·S 只提示不判成立。';
    }
  }
  function setKernelInfo(txt) { $('#kernel-info').textContent = '内核：' + txt; }

  /* ---------------- 坐标变换与指针交互 ---------------- */

  function screenToWorld(sx, sy) {
    var r = canvas.getBoundingClientRect();
    return { x: (sx - r.left - view.tx) / view.scale, y: (sy - r.top - view.ty) / view.scale };
  }
  var lastPointer = { x: 0, y: 0 };

  canvas.addEventListener('pointerdown', function (e) {
    lastPointer = { x: e.clientX, y: e.clientY };
    var id = e.target.getAttribute && e.target.getAttribute('data-id');
    if (id) {
      var o = Kernel.getObj(state, id);
      // 拖拽：自由点 / 约束点，且当前不在选择模式
      if (!mode && o && (o.type === 'point' || o.type === 'pointOn') &&
          !(e.target.classList.contains('pick-target') || e.target.classList.contains('pick-target-circle'))) {
        // 真正开始移动时才入栈（见 pointermove），保证“拖动中途撤销”回到拖拽前的一致依赖图
        drag = { id: id, pid: e.pointerId, moved: false, committed: false };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      handleCanvasPick(id);
      return;
    }
    // 背景
    if (mode && mode.kind === 'tool' && mode.tool === 'point') {
      var w = screenToWorld(e.clientX, e.clientY);
      drag = { pid: e.pointerId, placeOnUp: true, start: { x: e.clientX, y: e.clientY }, world: w };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (!mode) {
      pan = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
      canvas.classList.add('panning');
    }
  });

  canvas.addEventListener('pointermove', function (e) {
    lastPointer = { x: e.clientX, y: e.clientY };
    if (drag && drag.placeOnUp) {
      drag.moved = Math.hypot(e.clientX - drag.start.x, e.clientY - drag.start.y) > 4;
      return;
    }
    if (drag) {
      if (!drag.committed) { pushHistory(); drag.committed = true; }
      var w = screenToWorld(e.clientX, e.clientY);
      Kernel.movePoint(state, drag.id, w.x, w.y, lastResult ? lastResult.geom : null);
      drag.moved = true;
      scheduleEval(); // 每次移动发一个新 rev；Worker 旧结果到达时会被闸门丢弃
      return;
    }
    if (pan) {
      view.tx = pan.tx + (e.clientX - pan.x);
      view.ty = pan.ty + (e.clientY - pan.y);
      applyView();
    }
  });

  canvas.addEventListener('pointerup', function (e) {
    if (drag && drag.placeOnUp && !drag.moved) {
      addFreePoint(drag.world.x, drag.world.y);
    }
    // 纯点击点（没有移动）不会入栈；发生过移动的拖拽已在首次 move 时入栈，撤销即可整体回到拖拽前
    drag = null; pan = null;
    canvas.classList.remove('panning');
  });

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var factor = Math.exp(-e.deltaY * 0.0012);
    var r = canvas.getBoundingClientRect();
    var mx = e.clientX - r.left, my = e.clientY - r.top;
    var wx = (mx - view.tx) / view.scale, wy = (my - view.ty) / view.scale;
    view.scale = Math.max(2, Math.min(2000, view.scale * factor));
    view.tx = mx - wx * view.scale;
    view.ty = my - wy * view.scale;
    applyView();
  }, { passive: false });

  /* ---------------- 保存 / 导入 ---------------- */

  function saveFile() {
    // 先取一次最新求值（同步内核直接算；Worker 模式坐标已在 acceptResult 写回）
    var blob = new Blob([Kernel.exportJSON(state)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'geometry-construction-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function importText(text) {
    rev++; // 作废在途旧结果
    if (workerMode === 'worker' && worker) {
      worker.postMessage({ type: 'import', rev: rev, text: text });
    } else {
      acceptImport(Kernel.importJSON(text));
    }
  }
  function acceptImport(p) {
    if (!p.ok) { toast('导入失败：' + p.errors.join('；')); return; }
    p.result.rev = rev;
    pushHistory();
    state = p.state;
    selectedId = null; selectedGoalId = null; mode = null; updateModeBanner();
    acceptResult(p.result);
    fitView(p.result.geom);
    var msg = '导入成功：' + state.objs.length + ' 个图元，' + state.goals.length + ' 个待证关系';
    if (p.warnings.length) msg += '；' + p.warnings.length + ' 条警告';
    toast(msg);
    p.warnings.forEach(function (w) { console.warn('[导入]', w); });
    p.errors.forEach(function (x) { console.error('[导入]', x); });
  }

  /* ---------------- 示例构造 ---------------- */

  function loadExample() {
    pushHistory();
    state = Kernel.createState();
    function A(t, o) { return Kernel.addObject(state, t, o); }
    // 三角形 ABC
    var a = A('point', { x: -4, y: -1 }).id;
    var b = A('point', { x: 3, y: -2 }).id;
    var c = A('point', { x: 0, y: 4 }).id;
    var ab = A('line2', { a: a, b: b }).id;
    var bc = A('line2', { a: b, b: c }).id;
    var ca = A('line2', { a: c, b: a }).id;
    // 中点 M、N，连线 MN（三角形中位线：数值上应平行于 BC）
    var m = A('midpoint', { a: a, b: b }).id;
    var n = A('midpoint', { a: a, b: c }).id;
    var mn = A('line2', { a: m, b: n }).id;
    // 过 C 作 AB 的平行线（构造保证平行）；它与 AB 无交点（平行退化）
    var par = A('linePar', { p: c, l: ab }).id;
    var ix = A('intersection', { a: par, b: ab, which: 0 }).id;
    // 圆：圆心 A、半径点 B；过 B 作半径 AB 的垂线 —— 切线（构造保证）
    var cir = A('circle', { c: a, r: b }).id;
    var tan = A('linePerp', { p: b, l: ab }).id;
    // 圆上约束点 Q，同圆半径
    var q = A('pointOn', { host: cir, param: 0.7, x: 0, y: 0 }).id;
    // 两圆：第二个圆拖动到相切/分离可观察
    var d = A('point', { x: 8, y: 1 }).id;
    var e = A('point', { x: 9.2, y: 1 }).id;
    var cir2 = A('circle', { c: d, r: e }).id;
    // 求值一次以确定 q 坐标
    var probe = Kernel.evaluate(state);
    // 待证关系
    A_goal('parallel', [mn, bc]);           // 中位线定理：数值成立
    A_goal('parallel', [par, ab]);          // 构造保证
    A_goal('onLine', [ix, bc]);             // 依赖未定义交点 → 未定义
    A_goal('tangentLC', [tan, cir]);        // 半径端点垂线 → 构造保证相切
    A_goal('lenEq', [a, b, a, q]);          // 同圆半径 → 构造保证
    A_goal('tangentCC', [cir, cir2]);       // 可拖动成相切/分离
    function A_goal(k, refs) { Kernel.addGoal(state, k, refs); }

    runEval();
    setTimeout(function () { if (lastResult) fitView(lastResult.geom); }, 0);
    toast('示例已载入：拖动自由点，观察平行/相切/重合/无交点如何改变判定');
  }

  function clearAll() {
    if (!state.objs.length && !state.goals.length) return;
    pushHistory();
    state = Kernel.createState();
    selectedId = null; selectedGoalId = null; mode = null;
    history = []; // 清空后无可撤销
    $('#btn-undo').disabled = true;
    updateModeBanner();
    runEval();
  }

  /* ---------------- UI 绑定 ---------------- */

  document.querySelectorAll('[data-tool]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('[data-tool]').forEach(function (b) { b.classList.remove('active'); });
      if (mode && mode.kind === 'tool' && mode.tool === btn.dataset.tool) cancelMode();
      else { btn.classList.add('active'); startTool(btn.dataset.tool); }
    });
  });
  document.querySelectorAll('[data-goal]').forEach(function (btn) {
    btn.addEventListener('click', function () { startGoal(btn.dataset.goal); });
  });
  function clearToolButtons() {
    document.querySelectorAll('[data-tool]').forEach(function (b) { b.classList.remove('active'); });
  }
  var _cancelMode = cancelMode;
  cancelMode = function () { _cancelMode(); clearToolButtons(); };
  updateModeBanner = (function (fn) {
    return function () { fn(); if (!mode) clearToolButtons(); };
  })(updateModeBanner);

  $('#mode-cancel').addEventListener('click', function () { cancelMode(); });
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-save').addEventListener('click', saveFile);
  $('#btn-load').addEventListener('click', function () { $('#file-input').click(); });
  $('#file-input').addEventListener('change', function (e) {
    var f = e.target.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () { importText(reader.result); };
    reader.readAsText(f);
    e.target.value = '';
  });
  $('#btn-example').addEventListener('click', loadExample);
  $('#btn-clear').addEventListener('click', clearAll);
  $('#btn-help').addEventListener('click', function () { $('#modal-help').classList.remove('hidden'); });
  $('#help-close').addEventListener('click', function () { $('#modal-help').classList.add('hidden'); });
  $('#delete-cancel').addEventListener('click', function () { $('#modal-delete').classList.add('hidden'); });
  $('#delete-confirm').addEventListener('click', confirmDelete);
  $('#modal-delete').addEventListener('click', function (e) {
    if (e.target.id === 'modal-delete') $('#modal-delete').classList.add('hidden');
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') cancelMode();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  });

  /* ---------------- toast ---------------- */

  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 3200);
  }

  /* ---------------- 启动 ---------------- */

  setKernelInfo(workerMode === 'worker' ? 'Web Worker' : '同步内核');
  initWorker();
  runEval();
  loadExample();
})();
