/*
 * 深海采集站 · 故障闭环审计 —— 可诊断性判定核心
 *
 * 判定问题：是否存在一对无限执行 ρ1、ρ2，使得
 *   - ρ1 至少经过一次“故障”迁移（已发生故障），
 *   - ρ2 从未经过“故障”迁移，
 *   - 两者的可观察回执序列完全相同（按回执项逐一比较，静默迁移不产生回执）。
 * 存在 ⟺ 不可诊断；不存在 ⟺ 可诊断。
 *
 * 方法（精确判定，非有限回放）：双厂验证器（twin plant）。
 *   状态 = (左位置, 左旗标) × (右位置, 右旗标)，旗标 ∈ {N 未故障, F 已故障}。
 *   - 静默迁移：单侧独立推进；
 *   - 带回执迁移：两侧按“回执相等”同步推进。
 *   充分必要条件：某个旗标为 (F,N) 或 (N,F) 的可达验证器状态，
 *   位于一条“两侧都至少推进一步”的闭环上。该闭环可无限重复，
 *   从而给出两个回执序列完全相同的无限执行。
 *
 * 裁决顺序（稳定、确定）：共同前缀回执数 → 前缀步数 → 前缀迁移标识序列字典序
 *   → 闭环回执数 → 闭环步数 → 闭环迁移标识序列字典序。
 *
 * 本文件同时运行于浏览器（window.Diagnoser）、Web Worker（importScripts）
 * 与 Node.js（module.exports）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Diagnoser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 回执必须为非空的可打印 ASCII（0x20–0x7E）
  var RECEIPT_RE = /^[\x20-\x7E]+$/;
  var DEFAULT_MAX_TWIN_STATES = 50000;

  function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  // 迁移标识对 [左标识, 右标识] 序列的字典序；空串表示该侧该步未动
  function cmpSeq(a, b) {
    var n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) {
      var c = cmpStr(a[i][0], b[i][0]);
      if (c) return c;
      c = cmpStr(a[i][1], b[i][1]);
      if (c) return c;
    }
    return a.length - b.length;
  }

  // 代价序：回执数 → 步数 → 迁移标识序列字典序
  function cmpCost(a, b) {
    return (a.rec - b.rec) || (a.steps - b.steps) || cmpSeq(a.seq, b.seq);
  }

  function zeroCost() { return { rec: 0, steps: 0, seq: [] }; }

  function extendCost(cost, step) {
    return {
      rec: cost.rec + (step.rec == null ? 0 : 1),
      steps: cost.steps + 1,
      seq: cost.seq.concat([[step.l || '', step.r || '']])
    };
  }

  function MinHeap(cmp) { this.a = []; this.cmp = cmp; }
  MinHeap.prototype.size = function () { return this.a.length; };
  MinHeap.prototype.push = function (x) {
    var a = this.a, i = a.length;
    a.push(x);
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (this.cmp(a[i], a[p]) < 0) { var t = a[i]; a[i] = a[p]; a[p] = t; i = p; }
      else break;
    }
  };
  MinHeap.prototype.pop = function () {
    var a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      var i = 0;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, m = i;
        if (l < a.length && this.cmp(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.cmp(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        var t = a[i]; a[i] = a[m]; a[m] = t; i = m;
      }
    }
    return top;
  };

  function heapCmp(x, y) { return cmpCost(x.cost, y.cost) || (x.id - y.id); }

  // 规格化：去空白、位置去重（重复位置仅告警）、静默迁移忽略回执文本
  function normalizeSpec(raw) {
    raw = raw || {};
    var positions = [], seen = new Set(), dupPositions = [];
    (raw.positions || []).forEach(function (p) {
      var name = String(p == null ? '' : p).trim();
      if (!name) return;
      if (seen.has(name)) { dupPositions.push(name); return; }
      seen.add(name);
      positions.push(name);
    });
    var migrations = (raw.migrations || []).map(function (m) {
      m = m || {};
      var silent = !!m.silent;
      return {
        id: String(m.id == null ? '' : m.id).trim(),
        from: String(m.from == null ? '' : m.from).trim(),
        to: String(m.to == null ? '' : m.to).trim(),
        fault: !!m.fault,
        silent: silent,
        receipt: silent ? null : String(m.receipt == null ? '' : m.receipt)
      };
    });
    return {
      positions: positions,
      duplicatePositions: dupPositions,
      initial: String(raw.initial == null ? '' : raw.initial).trim(),
      migrations: migrations
    };
  }

  // 校验：悬空目标/源/初始位置、重复迁移标识、非法回执；返回可定位的 path
  function validateSpec(raw) {
    var spec = normalizeSpec(raw);
    var errors = [];
    var warnings = spec.duplicatePositions.map(function (name) {
      return { kind: 'duplicate-position', message: '位置 “' + name + '” 重复录入，已按一处处理。', path: { type: 'positions' } };
    });
    var posSet = new Set(spec.positions);

    if (spec.positions.length === 0) {
      errors.push({ kind: 'empty-positions', message: '位置集为空：请至少录入一个有限位置。', path: { type: 'positions' } });
    }
    if (!spec.initial) {
      errors.push({ kind: 'missing-initial', message: '未填写初始位置。', path: { type: 'initial' } });
    } else if (posSet.size && !posSet.has(spec.initial)) {
      errors.push({ kind: 'dangling-position', message: '初始位置 “' + spec.initial + '” 不在位置集中（悬空目标）。', path: { type: 'initial' } });
    }

    var idSeen = new Map();
    spec.migrations.forEach(function (m, i) {
      var no = i + 1;
      if (!m.id) {
        errors.push({ kind: 'missing-id', message: '第 ' + no + ' 条迁移缺少标识。', path: { type: 'migration', index: i, field: 'id' } });
      } else if (idSeen.has(m.id)) {
        errors.push({
          kind: 'duplicate-migration-id',
          message: '迁移标识 “' + m.id + '” 重复（第 ' + (idSeen.get(m.id) + 1) + ' 条与第 ' + no + ' 条）。',
          path: { type: 'migration', index: i, field: 'id' }
        });
      } else {
        idSeen.set(m.id, i);
      }
      if (!posSet.has(m.from)) {
        errors.push({
          kind: 'dangling-position',
          message: '迁移 ' + (m.id ? '“' + m.id + '”' : '第 ' + no + ' 条') + ' 的源位置 “' + m.from + '” 不在位置集中（悬空目标）。',
          path: { type: 'migration', index: i, field: 'from' }
        });
      }
      if (!posSet.has(m.to)) {
        errors.push({
          kind: 'dangling-position',
          message: '迁移 ' + (m.id ? '“' + m.id + '”' : '第 ' + no + ' 条') + ' 的目标位置 “' + m.to + '” 不在位置集中（悬空目标）。',
          path: { type: 'migration', index: i, field: 'to' }
        });
      }
      if (!m.silent) {
        if (!m.receipt) {
          errors.push({
            kind: 'illegal-receipt',
            message: '迁移 ' + (m.id ? '“' + m.id + '”' : '第 ' + no + ' 条') + ' 未标静默却未填写回执：非静默迁移必须填写 ASCII 回执。',
            path: { type: 'migration', index: i, field: 'receipt' }
          });
        } else if (!RECEIPT_RE.test(m.receipt)) {
          errors.push({
            kind: 'illegal-receipt',
            message: '迁移 ' + (m.id ? '“' + m.id + '”' : '第 ' + no + ' 条') + ' 的回执含非可打印 ASCII 字符（非法回执）。',
            path: { type: 'migration', index: i, field: 'receipt' }
          });
        }
      }
    });

    return { ok: errors.length === 0, errors: errors, warnings: warnings, spec: spec };
  }

  /*
   * 精确判定。输入须先通过 validateSpec。
   * options: { maxTwinStates, onProgress }
   * 返回 { status: 'diagnosable'|'non-diagnosable'|'indeterminate', stats, witness? }
   */
  function diagnose(spec, options) {
    options = options || {};
    var maxTwinStates = options.maxTwinStates || DEFAULT_MAX_TWIN_STATES;
    var onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

    var Q = spec.positions.slice();
    var n = Q.length;
    var qIndex = new Map();
    Q.forEach(function (q, i) { qIndex.set(q, i); });
    var initial = qIndex.get(spec.initial);

    var migrations = spec.migrations.map(function (m) {
      return {
        id: m.id,
        from: qIndex.get(m.from),
        to: qIndex.get(m.to),
        fault: !!m.fault,
        silent: !!m.silent,
        receipt: m.silent ? null : String(m.receipt)
      };
    });
    var byId = new Map();
    migrations.forEach(function (m) { byId.set(m.id, m); });
    var outgoing = [];
    for (var i0 = 0; i0 < n; i0++) outgoing.push([]);
    migrations.slice().sort(function (a, b) { return cmpStr(a.id, b.id); })
      .forEach(function (m) { outgoing[m.from].push(m); });

    // 验证器状态编码：((q1*2+f1)*n + q2)*2 + f2
    function encode(q1, f1, q2, f2) { return ((q1 * 2 + f1) * n + q2) * 2 + f2; }
    function decode(id) {
      var f2 = id & 1, r = id >> 1, q2 = r % n, r2 = (r - q2) / n, f1 = r2 & 1, q1 = r2 >> 1;
      return { q1: q1, f1: f1, q2: q2, f2: f2 };
    }
    var twinTotal = n * n * 4;
    var initialId = encode(initial, 0, initial, 0);

    // 后继：静默迁移单侧推进；回执迁移两侧按回执相等同步推进
    function forEachSucc(id, fn) {
      var s = decode(id), i, j, m, a, b;
      var out1 = outgoing[s.q1], out2 = outgoing[s.q2];
      for (i = 0; i < out1.length; i++) {
        m = out1[i];
        if (m.silent) fn(encode(m.to, s.f1 | (m.fault ? 1 : 0), s.q2, s.f2), { l: m.id, r: null, rec: null });
      }
      for (i = 0; i < out2.length; i++) {
        m = out2[i];
        if (m.silent) fn(encode(s.q1, s.f1, m.to, s.f2 | (m.fault ? 1 : 0)), { l: null, r: m.id, rec: null });
      }
      for (i = 0; i < out1.length; i++) {
        a = out1[i];
        if (a.silent) continue;
        for (j = 0; j < out2.length; j++) {
          b = out2[j];
          if (!b.silent && a.receipt === b.receipt) {
            fn(encode(a.to, s.f1 | (a.fault ? 1 : 0), b.to, s.f2 | (b.fault ? 1 : 0)), { l: a.id, r: b.id, rec: a.receipt });
          }
        }
      }
    }

    // —— 第一阶段：从初始诊断对出发的 Dijkstra（代价序见 cmpCost）——
    var dist = new Array(twinTotal).fill(null);
    var parent = new Array(twinTotal).fill(null);
    var heap = new MinHeap(heapCmp);
    dist[initialId] = zeroCost();
    heap.push({ id: initialId, cost: dist[initialId] });
    var explored = 0, edges = 0, truncated = false;
    while (heap.size()) {
      var cur = heap.pop();
      if (cur.cost !== dist[cur.id]) continue; // 惰性删除过期堆项
      explored++;
      if (explored > maxTwinStates) { truncated = true; break; }
      if (onProgress && explored % 256 === 0) onProgress({ explored: explored, edges: edges });
      forEachSucc(cur.id, function (to, step) {
        edges++;
        var nc = extendCost(cur.cost, step);
        if (!dist[to] || cmpCost(nc, dist[to]) < 0) {
          dist[to] = nc;
          parent[to] = { prev: cur.id, step: step };
          heap.push({ id: to, cost: nc });
        }
      });
    }

    // 统计已检查的诊断对
    var byFlags = { 'N-N': 0, 'F-N': 0, 'N-F': 0, 'F-F': 0 };
    var mixed = [];
    for (var id = 0; id < twinTotal; id++) {
      if (!dist[id]) continue;
      var dd = decode(id);
      byFlags[(dd.f1 ? 'F' : 'N') + '-' + (dd.f2 ? 'F' : 'N')]++;
      if (dd.f1 !== dd.f2) mixed.push(id);
    }

    // —— 第二阶段：在每个混合旗标状态上找“双侧均推进”的最小闭环 ——
    var cycleBudget = { left: Math.max(400000, maxTwinStates * 8) };

    function minCycle(s) {
      // 增广状态：验证器状态 * 4 + 左已动*2 + 右已动；目标 = 回到 s 且两侧均已动
      var startAug = s * 4;
      var distA = new Map(), parentA = new Map();
      var z = zeroCost();
      distA.set(startAug, z);
      var h = new MinHeap(heapCmp);
      h.push({ id: startAug, cost: z });
      while (h.size()) {
        var cur = h.pop();
        if (distA.get(cur.id) !== cur.cost) continue;
        if ((cur.id >> 2) === s && (cur.id & 3) === 3) {
          return { cost: cur.cost, parent: parentA, end: cur.id };
        }
        if (--cycleBudget.left < 0) return { exceeded: true };
        forEachSucc(cur.id >> 2, function (to, step) {
          var ml = (cur.id & 2) | (step.l ? 2 : 0);
          var mr = (cur.id & 1) | (step.r ? 1 : 0);
          var toAug = to * 4 + ml + mr;
          var nc = extendCost(cur.cost, step);
          if (!distA.has(toAug) || cmpCost(nc, distA.get(toAug)) < 0) {
            distA.set(toAug, nc);
            parentA.set(toAug, { prev: cur.id, step: step });
            h.push({ id: toAug, cost: nc });
          }
        });
      }
      return null;
    }

    var witness = null;
    if (!truncated) {
      mixed.sort(function (a, b) { return cmpCost(dist[a], dist[b]) || (a - b); });
      for (var mi = 0; mi < mixed.length; mi++) {
        var s = mixed[mi];
        if (witness && cmpCost(dist[s], witness.prefixCost) > 0) break; // 前缀代价递增，可截断
        var cyc = minCycle(s);
        if (cyc && cyc.exceeded) { truncated = true; break; }
        if (!cyc) continue;
        if (!witness ||
            cmpCost(dist[s], witness.prefixCost) < 0 ||
            (cmpCost(dist[s], witness.prefixCost) === 0 && cmpCost(cyc.cost, witness.cycleCost) < 0)) {
          witness = { entry: s, prefixCost: dist[s], cycleCost: cyc.cost, cycleParent: cyc.parent, cycleEnd: cyc.end };
        }
      }
    }

    var reachable = byFlags['N-N'] + byFlags['F-N'] + byFlags['N-F'] + byFlags['F-F'];
    var stats = {
      positions: n,
      migrations: migrations.length,
      twinStates: reachable,
      twinEdges: edges,
      byFlags: byFlags,
      mixedStates: mixed.length,
      mixedList: mixed.slice(0, 20).map(function (mid) {
        var d = decode(mid);
        return { left: Q[d.q1], right: Q[d.q2], leftFlag: d.f1 ? 'F' : 'N', rightFlag: d.f2 ? 'F' : 'N' };
      })
    };

    if (truncated) {
      return {
        status: 'indeterminate',
        reason: '诊断对规模超过上限（' + maxTwinStates + '）。为避免误判，本次不给出结论；请化简规程后重试。',
        stats: stats
      };
    }

    if (witness) {
      var pre = [];
      var cur2 = witness.entry;
      while (cur2 !== initialId) { var p = parent[cur2]; pre.push(p.step); cur2 = p.prev; }
      pre.reverse();

      var cycSteps = [];
      var aug = witness.cycleEnd;
      while (aug !== witness.entry * 4) { var pa = witness.cycleParent.get(aug); cycSteps.push(pa.step); aug = pa.prev; }
      cycSteps.reverse();

      var dEntry = decode(witness.entry);
      var faultySide = dEntry.f1 === 1 ? 'left' : 'right';
      var faultStep = -1;
      for (var fi = 0; fi < pre.length; fi++) {
        var fm = faultySide === 'left' ? pre[fi].l : pre[fi].r;
        if (fm && byId.get(fm).fault) { faultStep = fi; break; }
      }

      function migInfo(mid) {
        if (!mid) return null;
        var m = byId.get(mid);
        return { id: m.id, from: Q[m.from], to: Q[m.to], fault: m.fault, silent: m.silent, receipt: m.receipt };
      }
      function decorate(steps) {
        return steps.map(function (st) {
          return { left: migInfo(st.l), right: migInfo(st.r), receipt: st.rec };
        });
      }
      function receiptsOf(steps) {
        var r = [];
        steps.forEach(function (st) { if (st.rec != null) r.push(st.rec); });
        return r;
      }

      return {
        status: 'non-diagnosable',
        stats: stats,
        witness: {
          entry: { left: Q[dEntry.q1], right: Q[dEntry.q2], faultySide: faultySide },
          prefix: { steps: decorate(pre), receipts: receiptsOf(pre) },
          cycle: { steps: decorate(cycSteps), receipts: receiptsOf(cycSteps) },
          faultStep: faultStep
        }
      };
    }

    return { status: 'diagnosable', stats: stats };
  }

  return {
    RECEIPT_RE: RECEIPT_RE,
    DEFAULT_MAX_TWIN_STATES: DEFAULT_MAX_TWIN_STATES,
    normalizeSpec: normalizeSpec,
    validateSpec: validateSpec,
    diagnose: diagnose
  };
});
