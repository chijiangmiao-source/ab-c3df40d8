'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSpec, diagnose } = require('../src/diagnoser.js');

function okSpec(raw) {
  const v = validateSpec(raw);
  assert.equal(v.ok, true, '规格应通过校验: ' + JSON.stringify(v.errors));
  return v.spec;
}

// ---------- 场景一：静默双环（故障侧与正常侧各自静默自环，回执序列皆为空） ----------
const SILENT_DOUBLE_LOOP = {
  positions: ['蓄压舱', '回流舱', '弃置舱'],
  initial: '蓄压舱',
  migrations: [
    { id: 'f1', from: '蓄压舱', to: '回流舱', fault: true, silent: true },
    { id: 's1', from: '回流舱', to: '回流舱', fault: false, silent: true },
    { id: 'n1', from: '蓄压舱', to: '弃置舱', fault: false, silent: true },
    { id: 's2', from: '弃置舱', to: '弃置舱', fault: false, silent: true }
  ]
};

test('静默双环：不可诊断，前后缀与闭环回执均为空，闭环双侧均可推进', () => {
  const r = diagnose(okSpec(SILENT_DOUBLE_LOOP));
  assert.equal(r.status, 'non-diagnosable');
  const w = r.witness;
  assert.deepEqual(w.prefix.receipts, []);
  assert.deepEqual(w.cycle.receipts, []);
  assert.ok(w.cycle.steps.length >= 2, '静默双环的闭环至少两步（两侧各一步）');
  // 闭环中两侧都必须至少推进一步（否则不构成两个无限执行）
  const leftMoved = w.cycle.steps.some((s) => s.left);
  const rightMoved = w.cycle.steps.some((s) => s.right);
  assert.ok(leftMoved && rightMoved, '闭环必须双侧均可推进');
  assert.ok(w.faultStep >= 0, '故障须已在前缀中发生');
  const faultyFirst = w.entry.faultySide === 'left' ? w.prefix.steps[w.faultStep].left : w.prefix.steps[w.faultStep].right;
  assert.equal(faultyFirst.fault, true);
});

// ---------- 场景二：可诊断回执（故障路径与正常路径的回执自某一项起必然不同） ----------
const DIAGNOSABLE_RECEIPTS = {
  positions: ['泊位', '检修舱', '巡航舱'],
  initial: '泊位',
  migrations: [
    { id: 'f', from: '泊位', to: '检修舱', fault: true, silent: false, receipt: 'X' },
    { id: 'n', from: '泊位', to: '巡航舱', fault: false, silent: false, receipt: 'X' },
    { id: 'g1', from: '检修舱', to: '检修舱', fault: false, silent: false, receipt: 'Y' },
    { id: 'g2', from: '巡航舱', to: '巡航舱', fault: false, silent: false, receipt: 'Z' }
  ]
};

test('可诊断回执：故障侧 Y* 与正常侧 Z* 回执序列必然分叉', () => {
  const r = diagnose(okSpec(DIAGNOSABLE_RECEIPTS));
  assert.equal(r.status, 'diagnosable');
  // 诊断对摘要：混合旗标对（含镜像 (F,N)/(N,F)）可达但不在双侧推进闭环上
  assert.equal(r.stats.mixedStates, 2);
  assert.equal(r.stats.byFlags['F-N'], 1);
  assert.equal(r.stats.byFlags['N-F'], 1);
  assert.deepEqual(r.stats.mixedList[0], { left: '检修舱', right: '巡航舱', leftFlag: 'F', rightFlag: 'N' });
});

test('可诊断回执：故障回执与正常回执从首项即不同（无混合对可达）', () => {
  const spec = okSpec({
    positions: ['泊位', '检修舱', '巡航舱'],
    initial: '泊位',
    migrations: [
      { id: 'f', from: '泊位', to: '检修舱', fault: true, silent: false, receipt: 'FAULT' },
      { id: 'n', from: '泊位', to: '巡航舱', fault: false, silent: false, receipt: 'CRUISE' },
      { id: 'p1', from: '检修舱', to: '检修舱', fault: false, silent: false, receipt: 'PING' },
      { id: 'p2', from: '巡航舱', to: '巡航舱', fault: false, silent: false, receipt: 'PING' }
    ]
  });
  const r = diagnose(spec);
  assert.equal(r.status, 'diagnosable');
  assert.equal(r.stats.mixedStates, 0);
  // N-N 对：初始对 + 两侧同走 n 的镜像对
  assert.equal(r.stats.byFlags['N-N'], 2);
});

// ---------- 场景三：故障静默 + 相同回执 → 不可诊断，闭环带非空回执 ----------
test('故障静默、随后回执相同：不可诊断，闭环回执为 [A]', () => {
  const spec = okSpec({
    positions: ['P0', 'P1', 'P2'],
    initial: 'P0',
    migrations: [
      { id: 'f', from: 'P0', to: 'P1', fault: true, silent: true },
      { id: 'a', from: 'P1', to: 'P1', fault: false, silent: false, receipt: 'A' },
      { id: 'b', from: 'P0', to: 'P2', fault: false, silent: false, receipt: 'A' },
      { id: 'c', from: 'P2', to: 'P2', fault: false, silent: false, receipt: 'A' }
    ]
  });
  const r = diagnose(spec);
  assert.equal(r.status, 'non-diagnosable');
  assert.deepEqual(r.witness.prefix.receipts, ['A']);
  assert.deepEqual(r.witness.cycle.receipts, ['A']);
  assert.equal(r.witness.cycle.steps.length, 1, '闭环为一次同步推进');
});

// ---------- 场景四：故障迁移自身携带回执，仍被正常侧完全模仿 ----------
test('故障迁移携带回执但被正常侧模仿：不可诊断，前缀回执 [X]，闭环回执为空', () => {
  const spec = okSpec({
    positions: ['P0', 'P1', 'P2'],
    initial: 'P0',
    migrations: [
      { id: 'f', from: 'P0', to: 'P1', fault: true, silent: false, receipt: 'X' },
      { id: 'n', from: 'P0', to: 'P2', fault: false, silent: false, receipt: 'X' },
      { id: 's1', from: 'P1', to: 'P1', fault: false, silent: true },
      { id: 's2', from: 'P2', to: 'P2', fault: false, silent: true }
    ]
  });
  const r = diagnose(spec);
  assert.equal(r.status, 'non-diagnosable');
  assert.deepEqual(r.witness.prefix.receipts, ['X']);
  assert.deepEqual(r.witness.cycle.receipts, []);
  assert.equal(r.witness.faultStep, 0);
});

// ---------- 场景五：仅单侧推进的闭环不算（正常侧无法无限执行） ----------
test('正常侧死锁、仅故障侧静默自环：可诊断（不存在无限正常执行）', () => {
  const spec = okSpec({
    positions: ['P0', 'P1'],
    initial: 'P0',
    migrations: [
      { id: 'f', from: 'P0', to: 'P1', fault: true, silent: true },
      { id: 's', from: 'P1', to: 'P1', fault: false, silent: true }
    ]
  });
  const r = diagnose(spec);
  assert.equal(r.status, 'diagnosable');
  assert.equal(r.stats.mixedStates, 2, '混合对（含镜像）可达但闭环仅单侧推进');
});

// ---------- 场景六：回执序列按“项”比较，不做字符拼接 ----------
test('回执逐项比较：[AB,AB,…] 与 [A,B,A,B,…] 不相同 → 可诊断', () => {
  const spec = okSpec({
    positions: ['P0', 'P1', 'P2'],
    initial: 'P0',
    migrations: [
      { id: 'f', from: 'P0', to: 'P1', fault: true, silent: true },
      { id: 'x', from: 'P1', to: 'P1', fault: false, silent: false, receipt: 'AB' },
      { id: 'y', from: 'P0', to: 'P2', fault: false, silent: false, receipt: 'A' },
      { id: 'z', from: 'P2', to: 'P2', fault: false, silent: false, receipt: 'B' }
    ]
  });
  const r = diagnose(spec);
  assert.equal(r.status, 'diagnosable');
});

// ---------- 场景七：裁决顺序稳定（按回执长度、再按迁移标识） ----------
test('多个证人对：按前缀回执数 → 步数 → 迁移标识序列稳定裁决', () => {
  const spec = okSpec({
    positions: ['A', 'B', 'C', 'D', 'E'],
    initial: 'A',
    migrations: [
      { id: 'f1', from: 'A', to: 'B', fault: true, silent: true },
      { id: 's1', from: 'B', to: 'B', fault: false, silent: true },
      { id: 'n1', from: 'A', to: 'C', fault: false, silent: true },
      { id: 's2', from: 'C', to: 'C', fault: false, silent: true },
      { id: 'f2', from: 'A', to: 'D', fault: true, silent: true },
      { id: 's3', from: 'D', to: 'D', fault: false, silent: true },
      { id: 'n2', from: 'A', to: 'E', fault: false, silent: true },
      { id: 's4', from: 'E', to: 'E', fault: false, silent: true }
    ]
  });
  const r1 = diagnose(spec);
  const r2 = diagnose(spec);
  assert.deepEqual(r1, r2, '两次判定结果必须完全一致（确定性）');
  assert.equal(r1.status, 'non-diagnosable');
  // 两个分支前缀回执数相同（0），按迁移标识序列字典序应选中 f1/n1 分支
  assert.deepEqual(
    [r1.witness.entry.left, r1.witness.entry.right].sort(),
    ['B', 'C'],
    '应按迁移标识字典序选中标识较小的分支'
  );
});

// ---------- 校验：悬空目标 / 重复标识 / 非法回执 ----------
test('校验：悬空目标被定位到具体迁移与字段', () => {
  const v = validateSpec({
    positions: ['P0'],
    initial: 'P0',
    migrations: [{ id: 'm1', from: 'P0', to: 'P9', fault: false, silent: false, receipt: 'A' }]
  });
  assert.equal(v.ok, false);
  const e = v.errors.find((x) => x.kind === 'dangling-position');
  assert.ok(e, '应报告悬空目标');
  assert.deepEqual(e.path, { type: 'migration', index: 0, field: 'to' });
});

test('校验：初始位置悬空被定位', () => {
  const v = validateSpec({ positions: ['P0'], initial: 'PZ', migrations: [] });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.kind === 'dangling-position' && e.path.type === 'initial'));
});

test('校验：重复迁移标识被定位到后一条', () => {
  const v = validateSpec({
    positions: ['P0'],
    initial: 'P0',
    migrations: [
      { id: 'm', from: 'P0', to: 'P0', fault: false, silent: true },
      { id: 'm', from: 'P0', to: 'P0', fault: true, silent: true }
    ]
  });
  assert.equal(v.ok, false);
  const e = v.errors.find((x) => x.kind === 'duplicate-migration-id');
  assert.ok(e, '应报告重复迁移标识');
  assert.equal(e.path.index, 1);
  assert.equal(e.path.field, 'id');
});

test('校验：非法回执（非 ASCII / 非静默却空回执）被定位', () => {
  const v = validateSpec({
    positions: ['P0'],
    initial: 'P0',
    migrations: [
      { id: 'm1', from: 'P0', to: 'P0', fault: false, silent: false, receipt: '回执' },
      { id: 'm2', from: 'P0', to: 'P0', fault: false, silent: false, receipt: '' }
    ]
  });
  assert.equal(v.ok, false);
  const kinds = v.errors.filter((e) => e.kind === 'illegal-receipt');
  assert.equal(kinds.length, 2);
  assert.equal(kinds[0].path.field, 'receipt');
});

test('校验：静默迁移忽略回执文本；重复位置仅告警不阻断', () => {
  const v = validateSpec({
    positions: ['P0', 'P0'],
    initial: 'P0',
    migrations: [{ id: 'm1', from: 'P0', to: 'P0', fault: false, silent: true, receipt: 'IGNORED' }]
  });
  assert.equal(v.ok, true);
  assert.equal(v.spec.migrations[0].receipt, null, '静默迁移的回执应被规格化为 null');
  assert.equal(v.warnings.length, 1, '重复位置应产生告警');
});

// ---------- 资源上限：超限如实报告“不确定”，绝不误判 ----------
test('资源超限：返回 indeterminate 而非猜测结论', () => {
  const spec = okSpec(SILENT_DOUBLE_LOOP);
  const r = diagnose(spec, { maxTwinStates: 1 });
  assert.equal(r.status, 'indeterminate');
  assert.ok(r.reason.length > 0);
});
