/*
 * 计算 Worker：在后台线程执行双厂验证器判定。
 * 每条消息携带任务序号 seq，主线程据此丢弃过期任务的回包。
 */
importScripts('diagnoser.js');

self.onmessage = function (e) {
  var d = e.data || {};
  try {
    var result = Diagnoser.diagnose(d.spec, {
      onProgress: function (p) {
        self.postMessage({ seq: d.seq, type: 'progress', progress: p });
      }
    });
    self.postMessage({ seq: d.seq, type: 'result', result: result });
  } catch (err) {
    self.postMessage({ seq: d.seq, type: 'error', message: String((err && err.stack) || err) });
  }
};
