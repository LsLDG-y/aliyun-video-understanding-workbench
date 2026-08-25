/**
 * 端到端自检脚本（可选工具，交付后可用于复验）
 * 用法：node scripts/端到端验证.mjs [模型ID]   （默认 qwen3-omni-flash）
 * 前置：本地服务已启动（启动.cmd），config.json 已配置 API Key。
 *
 * 流程：/api/upload（两阶段：先落盘得 uploadKey）→ 轮询 /api/upload_status 等待转存完成
 *      → /api/chat 首轮（附带视频）→ /api/chat 第二轮（纯文本上下文追问）
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8686';
const MODEL = process.argv[2] || 'qwen3-omni-flash';
const VIDEO = path.join(process.cwd(), '测试.mp4');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function parseSSE(res) {
  let text = '', reasoning = '', usage = null;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const s = line.slice(5).trim();
      if (s === '[DONE]') continue;
      let obj; try { obj = JSON.parse(s); } catch { continue; }
      if (obj.usage) { usage = obj.usage; continue; }
      const ch = obj.choices && obj.choices[0];
      if (!ch || !ch.delta) continue;
      if (ch.delta.reasoning_content) reasoning += ch.delta.reasoning_content;
      if (ch.delta.content) text += ch.delta.content;
    }
  }
  return { text, reasoning, usage };
}

function usageSummary(u) {
  if (!u) return '(无 usage)';
  const inT = u.prompt_tokens ?? u.input_tokens ?? 0;
  const outT = u.completion_tokens ?? u.output_tokens ?? 0;
  return `输入 ${inT} · 输出 ${outT} · 合计 ${u.total_tokens ?? inT + outT}`;
}

console.log('== 模型:', MODEL, '==');

// ---------- 1) 上传视频（两阶段） ----------
console.log('\n[1/3] 上传视频…');
const fd = new FormData();
fd.append('model', MODEL);
fd.append('file', new Blob([fs.readFileSync(VIDEO)]), path.basename(VIDEO));
const rUp = await fetch(`${BASE}/api/upload`, { method: 'POST', body: fd });
const up = await rUp.json();
if (!up.ok) { console.error('上传失败:', up.error || up); process.exit(1); }
console.log('    文件已接收 ✓ uploadKey:', up.uploadKey, '(' + Math.round((up.fileSize || 0) / 1024) + ' KB · ' + up.expireInSeconds / 3600 + 'h)');

let transit = null;
for (let i = 0; i < 1900; i += 1) {
  const s = await (await fetch(`${BASE}/api/upload_status?key=${encodeURIComponent(up.uploadKey)}`, { cache: 'no-store' })).json();
  if (s.error) { console.error('转存查询失败:', s.error); process.exit(1); }
  if (s.phase === 'done' && s.result) { transit = s.result; break; }
  if (s.phase === 'error') { console.error('转存失败:', s.error); process.exit(1); }
  if (i % 10 === 0) process.stdout.write(`\r    转存中… phase=${s.phase} progress=${((s.progress || 0) * 100).toFixed(0)}%`);
  await sleep(1000);
}
if (!transit) { console.error('\n转存超时（30 分钟）'); process.exit(1); }
console.log('\n    转存完成 ✓ url:', transit.url.slice(0, 64) + '…');

// ---------- 2) 第一轮：视频理解 ----------
console.log('\n[2/3] 视频理解（首轮，附带视频）…');
const messages = [{
  role: 'user',
  content: [
    { type: 'video_url', video_url: { url: transit.url } },
    { type: 'text', text: '请用中文描述这段视频的主要内容，并用时间戳（HH:mm:ss）列出关键事件，最后给出 50 字以内的摘要。' },
  ],
}];
const r1 = await fetch(`${BASE}/api/chat`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: MODEL, messages, stream: true, stream_options: { include_usage: true } }),
});
if (!r1.ok) { const e = await r1.json(); console.error('请求失败:', r1.status, e.error || e); process.exit(1); }
const ans1 = await parseSSE(r1);
console.log('    思考:', (ans1.reasoning || '(无)').slice(0, 120).replace(/\n/g, ' '));
console.log('    回答:', (ans1.text || '(空)').slice(0, 600).replace(/\n/g, ' '));
console.log('    usage:', usageSummary(ans1.usage));
messages.push({ role: 'assistant', content: ans1.text });

// ---------- 3) 第二轮：上下文对话 ----------
console.log('\n[3/3] 上下文追问（第二轮，纯文本）…');
messages.push({ role: 'user', content: '视频里出现了什么人物或动物？请只依据视频内容回答。' });
const r2 = await fetch(`${BASE}/api/chat`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: MODEL, messages, stream: true, stream_options: { include_usage: true } }),
});
if (!r2.ok) { const e = await r2.json(); console.error('请求失败:', r2.status, e.error || e); process.exit(1); }
const ans2 = await parseSSE(r2);
console.log('    回答:', (ans2.text || '(空)').slice(0, 400).replace(/\n/g, ' '));
console.log('    usage:', usageSummary(ans2.usage));

console.log('\n✅ 端到端验证完成');
