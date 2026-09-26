/*
 * 故障闭环审计台 —— 页面逻辑
 * 关键点：每次提交生成新的任务序号（runSeq），Worker 回包携带序号；
 * 序号不匹配（规程已修改 / 已取消）的回包一律丢弃，过期任务不得改写草稿与结果。
 */
(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var positionsEl = $('#positions');
  var initialEl = $('#initial');
  var tbody = document.querySelector('#migrations tbody');
  var errorsEl = $('#errors');
  var warningsEl = $('#warnings');
  var conclusionEl = $('#conclusion');
  var statusEl = $('#status');
  var staleBadge = $('#stale-badge');
  var submitBtn = $('#submit');
  var cancelBtn = $('#cancel');

  var runSeq = 0;        // 当前有效任务序号；递增即作废旧任务
  var worker = null;     // 在途 Worker
  var hasConclusion = false;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function setStatus(text) { statusEl.textContent = text; }

  // ---------- 迁移行 ----------
  function renumber() {
    Array.prototype.forEach.call(tbody.rows, function (tr, i) {
      tr.cells[0].textContent = i + 1;
    });
  }

  function addRow(m) {
    m = m || {};
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td class="row-num"></td>' +
      '<td><input data-field="id" type="text" spellcheck="false" placeholder="如 m1"></td>' +
      '<td><input data-field="from" type="text" spellcheck="false"></td>' +
      '<td><input data-field="to" type="text" spellcheck="false"></td>' +
      '<td><select data-field="kind"><option value="normal">正常</option><option value="fault">故障</option></select></td>' +
      '<td><input data-field="receipt" type="text" spellcheck="false" placeholder="可打印 ASCII"></td>' +
      '<td class="center"><input data-field="silent" type="checkbox" title="静默：不产生回执"></td>' +
      '<td><button type="button" class="del" title="删除该迁移">×</button></td>';
    tbody.appendChild(tr);

    var idEl = tr.querySelector('[data-field=id]');
    var fromEl = tr.querySelector('[data-field=from]');
    var toEl = tr.querySelector('[data-field=to]');
    var kindEl = tr.querySelector('[data-field=kind]');
    var receiptEl = tr.querySelector('[data-field=receipt]');
    var silentEl = tr.querySelector('[data-field=silent]');

    if (m.id != null) idEl.value = m.id;
    if (m.from != null) fromEl.value = m.from;
    if (m.to != null) toEl.value = m.to;
    if (m.fault) kindEl.value = 'fault';
    if (m.receipt != null) receiptEl.value = m.receipt;
    if (m.silent) silentEl.checked = true;

    function syncSilent() {
      receiptEl.disabled = silentEl.checked;
      if (silentEl.checked) receiptEl.value = '';
    }
    silentEl.addEventListener('change', function () { syncSilent(); markDirty(); });
    tr.querySelector('.del').addEventListener('click', function () {
      tr.remove(); renumber(); markDirty();
    });
    tr.addEventListener('input', markDirty);
    syncSilent();
    renumber();
    return tr;
  }

  // ---------- 草稿修改：使在途任务过期 ----------
  function markDirty() {
    if (worker) { worker.terminate(); worker = null; }
    runSeq++; // 在途任务（若有）回包序号将失配，被直接丢弃
    cancelBtn.disabled = true;
    setStatus('规程已修改，尚未提交新的诊断。');
    if (hasConclusion) staleBadge.hidden = false; // 旧结论保留但标记可能过期
  }

  positionsEl.addEventListener('input', markDirty);
  initialEl.addEventListener('input', markDirty);

  // ---------- 规格收集 ----------
  function collectSpec() {
    var positions = positionsEl.value.split(/[\s,，、;；]+/).filter(function (s) { return s.trim(); });
    var migrations = Array.prototype.map.call(tbody.rows, function (tr) {
      return {
        id: tr.querySelector('[data-field=id]').value,
        from: tr.querySelector('[data-field=from]').value,
        to: tr.querySelector('[data-field=to]').value,
        fault: tr.querySelector('[data-field=kind]').value === 'fault',
        silent: tr.querySelector('[data-field=silent]').checked,
        receipt: tr.querySelector('[data-field=receipt]').value
      };
    });
    return { positions: positions, initial: initialEl.value, migrations: migrations };
  }

  // ---------- 校验错误定位 ----------
  function clearMarks() {
    Array.prototype.forEach.call(document.querySelectorAll('.invalid'), function (el) {
      el.classList.remove('invalid');
    });
    errorsEl.innerHTML = '';
    warningsEl.innerHTML = '';
  }

  function locateField(path) {
    if (!path) return null;
    if (path.type === 'positions') return positionsEl;
    if (path.type === 'initial') return initialEl;
    if (path.type === 'migration') {
      var tr = tbody.rows[path.index];
      return tr ? tr.querySelector('[data-field=' + path.field + ']') : null;
    }
    return null;
  }

  function showIssues(errors, warnings) {
    errorsEl.innerHTML = '';
    warningsEl.innerHTML = '';
    (errors || []).forEach(function (e) {
      var li = document.createElement('li');
      var field = locateField(e.path);
      if (field) {
        field.classList.add('invalid');
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'locate';
        btn.textContent = '定位';
        btn.addEventListener('click', function () {
          field.focus();
          field.scrollIntoView({ block: 'center', behavior: 'smooth' });
        });
        li.appendChild(btn);
      }
      li.appendChild(document.createTextNode(e.message));
      errorsEl.appendChild(li);
    });
    (warnings || []).forEach(function (w) {
      var li = document.createElement('li');
      li.textContent = w.message;
      warningsEl.appendChild(li);
    });
  }

  // ---------- 任务生命周期 ----------
  function startRun(spec, warnings) {
    runSeq++;
    var seq = runSeq;
    if (worker) { worker.terminate(); worker = null; }
    staleBadge.hidden = true;
    showIssues([], warnings);
    cancelBtn.disabled = false;
    setStatus('计算中……');
    var t0 = Date.now();

    function apply(result) {
      if (seq !== runSeq) return; // 过期任务不得改写结果
      cancelBtn.disabled = true;
      worker = null;
      hasConclusion = true;
      renderResult(result, Date.now() - t0);
    }
    function fail(msg) {
      if (seq !== runSeq) return;
      cancelBtn.disabled = true;
      worker = null;
      conclusionEl.innerHTML = '<p class="error">计算异常：' + esc(msg) + '</p>';
      setStatus('计算异常。');
    }

    function runMainThread() {
      // 无 Web Worker（或创建失败）的退化路径：结果返回前仍做序号检查，保证过期任务不改写结果
      setStatus('当前环境无法使用 Web Worker，将在主线程计算（大规格可能短暂卡顿）。');
      setTimeout(function () {
        try { apply(Diagnoser.diagnose(spec)); }
        catch (err) { fail(String((err && err.stack) || err)); }
      }, 0);
    }

    if (window.Worker) {
      try {
        worker = new Worker('worker.js');
      } catch (e) {
        worker = null;
        runMainThread();
        return;
      }
      worker.onmessage = function (e) {
        var d = e.data;
        if (!d || d.seq !== seq) return; // 过期任务回包直接丢弃
        if (d.type === 'progress') {
          setStatus('计算中……已探索 ' + d.progress.explored + ' 个诊断对、' + d.progress.edges + ' 条同步边');
        } else if (d.type === 'result') {
          apply(d.result);
        } else if (d.type === 'error') {
          fail(d.message);
        }
      };
      worker.onerror = function (ev) { fail(ev.message || 'Worker 错误'); };
      worker.postMessage({ seq: seq, spec: spec });
    } else {
      runMainThread();
    }
  }

  submitBtn.addEventListener('click', function () {
    clearMarks();
    var v = Diagnoser.validateSpec(collectSpec());
    if (!v.ok) {
      // 校验失败：定位错误并清除旧结论
      runSeq++;
      if (worker) { worker.terminate(); worker = null; }
      cancelBtn.disabled = true;
      hasConclusion = false;
      staleBadge.hidden = true;
      conclusionEl.innerHTML = '<p class="muted">录入校验未通过，旧结论已清除。请修正后重新提交。</p>';
      showIssues(v.errors, v.warnings);
      setStatus('校验失败：' + v.errors.length + ' 处错误。');
      return;
    }
    showIssues([], v.warnings);
    startRun(v.spec, v.warnings);
  });

  cancelBtn.addEventListener('click', function () {
    runSeq++; // 使在途任务过期：其回包将被丢弃
    if (worker) { worker.terminate(); worker = null; }
    cancelBtn.disabled = true;
    setStatus('已取消：过期任务不会改写当前草稿与结果。');
  });

  // ---------- 结果渲染 ----------
  function receiptSeqHtml(receipts) {
    if (!receipts.length) return '<span class="muted">（空序列）</span>';
    return receipts.map(function (r) { return '<code class="receipt">' + esc(r) + '</code>'; })
      .join('<span class="sep">▸</span>');
  }

  function migCellHtml(m) {
    if (!m) return '<td class="muted">—（未推进）</td>';
    return '<td><code>' + esc(m.id) + '</code>：' + esc(m.from) + ' → ' + esc(m.to) +
      (m.fault ? ' <span class="tag fault">故障</span>' : ' <span class="tag normal">正常</span>') +
      (m.silent ? ' <span class="tag silent">静默</span>'
                : ' <span class="tag receipt">回执 “' + esc(m.receipt) + '”</span>') + '</td>';
  }

  function stepsTableHtml(steps, faultySide, title) {
    var rows = steps.map(function (st, i) {
      var faulty = faultySide === 'left' ? st.left : st.right;
      var normal = faultySide === 'left' ? st.right : st.left;
      return '<tr><td>' + (i + 1) + '</td>' +
        migCellHtml(faulty) + migCellHtml(normal) +
        '<td>' + (st.receipt != null ? '<code class="receipt">' + esc(st.receipt) + '</code>' : '<span class="muted">—</span>') + '</td></tr>';
    }).join('');
    return '<h4>' + esc(title) + '</h4>' +
      '<table class="steps"><thead><tr><th>步</th><th>故障侧迁移</th><th>正常侧迁移</th><th>回执</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>';
  }

  function statsLine(stats, ms) {
    return '<p class="muted stats">本次判定检查诊断对 ' + stats.twinStates +
      ' 个、同步边 ' + stats.twinEdges + ' 条，耗时 ' + ms + ' ms。</p>';
  }

  function renderResult(result, ms) {
    var html = '';
    if (result.status === 'non-diagnosable') {
      var w = result.witness;
      var faultMig = w.faultStep >= 0
        ? (w.entry.faultySide === 'left' ? w.prefix.steps[w.faultStep].left : w.prefix.steps[w.faultStep].right)
        : null;
      html += '<div class="verdict bad">不可诊断：存在故障被无限伪装的风险</div>';
      html += '<p>找到一对无限执行：<b>故障侧</b>已发生故障、<b>正常侧</b>从未发生故障，' +
        '而两侧的可观察回执序列完全相同。下述闭环可无限重复，故两条执行均为无限。</p>';
      html += '<div class="panel"><h3>最短共同前缀（回执序列）</h3><p class="seq">' +
        receiptSeqHtml(w.prefix.receipts) + '</p>';
      html += '<h3>可重复闭环（回执序列）</h3><p class="seq">' + receiptSeqHtml(w.cycle.receipts) + '</p>';
      html += '<p>进入闭环时位置：故障侧 <code>' + esc(w.entry.faultySide === 'left' ? w.entry.left : w.entry.right) +
        '</code>，正常侧 <code>' + esc(w.entry.faultySide === 'left' ? w.entry.right : w.entry.left) + '</code>。';
      if (faultMig) {
        html += '故障发生于前缀第 ' + (w.faultStep + 1) + ' 步（迁移 <code>' + esc(faultMig.id) + '</code>）。';
      }
      html += '</p></div>';
      html += stepsTableHtml(w.prefix.steps, w.entry.faultySide, '两侧逐步迁移对应 · 共同前缀');
      html += stepsTableHtml(w.cycle.steps, w.entry.faultySide, '两侧逐步迁移对应 · 可重复闭环（每绕行一周即重复一次）');
      html += statsLine(result.stats, ms);
      setStatus('判定完成：不可诊断。');
    } else if (result.status === 'diagnosable') {
      var s = result.stats;
      html += '<div class="verdict good">可诊断：不存在能无限伪装故障的执行对</div>';
      html += '<p>全部可达诊断对均已检查，未发现“一故障一正常且两侧均可推进”的闭环。</p>';
      html += '<div class="panel"><h3>已检查的诊断对摘要</h3><ul>' +
        '<li>位置 ' + s.positions + ' 个，迁移 ' + s.migrations + ' 条</li>' +
        '<li>已检查诊断对（验证器状态）' + s.twinStates + ' 个，同步边 ' + s.twinEdges + ' 条</li>' +
        '<li>旗标组合：正常-正常 ' + s.byFlags['N-N'] + '，故障-正常 ' + s.byFlags['F-N'] +
        '，正常-故障 ' + s.byFlags['N-F'] + '，故障-故障 ' + s.byFlags['F-F'] + '</li>' +
        '<li>混合旗标诊断对 ' + s.mixedStates + ' 个，均不位于任何双侧均可推进的闭环上</li></ul>';
      if (s.mixedList.length) {
        html += '<table class="steps"><thead><tr><th>#</th><th>左侧位置</th><th>左侧旗标</th><th>右侧位置</th><th>右侧旗标</th></tr></thead><tbody>' +
          s.mixedList.map(function (p, i) {
            return '<tr><td>' + (i + 1) + '</td><td>' + esc(p.left) + '</td><td>' + (p.leftFlag === 'F' ? '已故障' : '未故障') +
              '</td><td>' + esc(p.right) + '</td><td>' + (p.rightFlag === 'F' ? '已故障' : '未故障') + '</td></tr>';
          }).join('') + '</tbody></table>' +
          (s.mixedStates > s.mixedList.length ? '<p class="muted">（仅列出前 ' + s.mixedList.length + ' 个）</p>' : '');
      }
      html += '</div>' + statsLine(s, ms);
      setStatus('判定完成：可诊断。');
    } else {
      html += '<div class="verdict warn">无法判定</div><p>' + esc(result.reason || '未知原因。') + '</p>';
      setStatus('无法判定。');
    }
    conclusionEl.innerHTML = html;
  }

  // ---------- 示例与清空 ----------
  function loadSpec(spec) {
    positionsEl.value = spec.positions.join(' ');
    initialEl.value = spec.initial;
    tbody.innerHTML = '';
    spec.migrations.forEach(addRow);
    markDirty();
  }

  $('#load-silent-loop').addEventListener('click', function () {
    loadSpec({
      positions: ['蓄压舱', '回流舱', '弃置舱'],
      initial: '蓄压舱',
      migrations: [
        { id: 'f1-泄压失效', from: '蓄压舱', to: '回流舱', fault: true, silent: true },
        { id: 's1-回流自环', from: '回流舱', to: '回流舱', fault: false, silent: true },
        { id: 'n1-正常旁路', from: '蓄压舱', to: '弃置舱', fault: false, silent: true },
        { id: 's2-弃置自环', from: '弃置舱', to: '弃置舱', fault: false, silent: true }
      ]
    });
  });

  $('#load-diagnosable').addEventListener('click', function () {
    loadSpec({
      positions: ['泊位', '检修舱', '巡航舱'],
      initial: '泊位',
      migrations: [
        { id: 'f-潜入检修', from: '泊位', to: '检修舱', fault: true, silent: false, receipt: 'FAULT' },
        { id: 'n-潜入巡航', from: '泊位', to: '巡航舱', fault: false, silent: false, receipt: 'CRUISE' },
        { id: 'p1-检修上报', from: '检修舱', to: '检修舱', fault: false, silent: false, receipt: 'PING' },
        { id: 'p2-巡航上报', from: '巡航舱', to: '巡航舱', fault: false, silent: false, receipt: 'PING' }
      ]
    });
  });

  $('#clear-all').addEventListener('click', function () {
    positionsEl.value = '';
    initialEl.value = '';
    tbody.innerHTML = '';
    markDirty();
  });

  $('#add-migration').addEventListener('click', function () { addRow(); markDirty(); });

  // 初始载入“静默双环”示例，便于值班工程师直接体验
  $('#load-silent-loop').click();
})();
