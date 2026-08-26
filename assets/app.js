/* =========================================================================
 * 视频理解工作台 · 前端逻辑（浏览器直连本地服务 /api/*）
 * 视频理解：阿里云百炼（DashScope OpenAI 兼容接口）
 * Token 估算：按百炼官方「计算图像的Token / 视频抽帧」规则实现（估算仅供参考）
 * ========================================================================= */
'use strict';

/* ---------------- 版本 ---------------- */
const APP_VERSION = '1.2';

/* ---------------- 小工具 ---------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '' + Math.random());
const nowMs = () => Date.now();

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtDuration(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return '-';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}
function fmtBytes(n) {
  if (n == null || !isFinite(n)) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function fmtNum(n) {
  if (n == null || !isFinite(n)) return '-';
  return n.toLocaleString('zh-CN');
}
function fmtTokens(n) {
  if (n == null || !isFinite(n)) return '-';
  if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
  return fmtNum(Math.round(n));
}
function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let toastTimer = null;
/* 浏览器侧诊断日志：记录最近若干错误消息，供「导出诊断日志」合并使用 */
const diagLogMax = 200;
let diagLog = [];
function pushDiag(msg) {
  try {
    diagLog.push({ ts: new Date().toLocaleString(), msg: String(msg) });
    if (diagLog.length > diagLogMax) diagLog.shift();
  } catch (_) {}
}
function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
  if (type === 'err') pushDiag(msg);
}

/* 第一轮理解默认提示词：所有分支对话都基于此结果，尽量详尽（详细分镜脚本式） */
const DEFAULT_PROMPT = `请以专业影视分析视角，极其详细地分析这段视频，输出完整分镜脚本与深度分析，按以下结构输出：

【一、全局信息】
1. 视频主题、类型（宣传片/纪录/短剧/演示等）与整体风格
2. 画面质量与摄影特点
3. 屏幕上出现的字幕/文案，请全文逐字转录

【二、完整分镜脚本】
按时间顺序输出每一个镜头，每条分镜包含：
- 时间码：起始-结束（HH:mm:ss）
- 景别与运镜：远景/全景/中景/近景/特写；固定/推/拉/摇/移/跟等
- 画面内容：场景、人物（外貌、衣着、动作、表情）、物体与细节
- 文字信息：字幕、Logo、品牌、号码等所有可识别文本
- 声音：人声（逐字转录）、音乐情绪、环境音、音效
- 转场方式：硬切/叠化/淡入淡出等

【三、深度解析】
1. 叙事脉络与人物关系（如有）
2. 色彩基调、光影与布光特点
3. 节奏与剪辑风格
4. 重点细节清单：颜色、数字、符号等逐一列出

【四、总结与延伸】
用 200 字以内高度概括；再列出 3 个围绕该视频值得深入讨论的问题。`;

function markdown(text) {
  // 轻量渲染：代码块 → <pre><code>；行内代码 → <code>；换行 → <br>（不做完整 MD，安全第一）
  const t = esc(text);
  const blocks = t.split(/(```[\s\S]*?```)/g);
  let out = '';
  for (const part of blocks) {
    if (part.startsWith('```')) {
      const code = part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '');
      out += '<pre><code>' + code + '</code></pre>';
    } else {
      out += part
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/\n/g, '<br>');
    }
  }
  return out;
}

/* ---------------- 模型档案（依据百炼官方文档 2026-08 规则） ---------------- */
const MODEL_TIERS = {
  qwen38: { label: 'qwen3.8 系列', maxDuration: 7200, maxSizeMB: 2048, imgMax: 8000, tokenPixels: 1024, factor: 32, videoMaxPixels: 768 * 32 * 32, videoTotalPixels: 65536 * 32 * 32 },
  qwen37: { label: 'qwen3.7 系列', maxDuration: 7200, maxSizeMB: 2048, imgMax: 8000, tokenPixels: 1024, factor: 32, videoMaxPixels: 768 * 32 * 32, videoTotalPixels: 65536 * 32 * 32 },
  qwen36: { label: 'qwen3.6 系列', maxDuration: 7200, maxSizeMB: 2048, imgMax: 8000, tokenPixels: 1024, factor: 32, videoMaxPixels: 768 * 32 * 32, videoTotalPixels: 65536 * 32 * 32 },
  qwen35: { label: 'qwen3.5 系列', maxDuration: 7200, maxSizeMB: 2048, imgMax: 8000, tokenPixels: 1024, factor: 32, videoMaxPixels: 768 * 32 * 32, videoTotalPixels: 65536 * 32 * 32 },
  omniPlus: { label: 'Qwen3.5-Omni-Plus（全模态旗舰）', maxDuration: 3600, maxSizeMB: 1024, imgMax: 2000, tokenPixels: 1024, factor: 32, videoMaxPixels: 768 * 32 * 32, videoTotalPixels: 65536 * 32 * 32 },
  omniFlash: { label: 'Qwen3.5-Omni-Flash / Qwen3-Omni-Flash（全模态轻量）', maxDuration: 150, maxSizeMB: 1024, imgMax: 2000, tokenPixels: 1024, factor: 32, videoMaxPixels: 768 * 32 * 32, videoTotalPixels: 65536 * 32 * 32 },
  qwen3vlx: { label: 'qwen3-vl-plus / flash / 235b', maxDuration: 3600, maxSizeMB: 2048, imgMax: 2000, tokenPixels: 1024, factor: 32, videoMaxPixels: 640 * 32 * 32, videoTotalPixels: 131072 * 32 * 32 },
  qwen3vlo: { label: '其他 qwen3-vl 开源系列', maxDuration: 1200, maxSizeMB: 2048, imgMax: 512, tokenPixels: 1024, factor: 32, videoMaxPixels: 768 * 32 * 32, videoTotalPixels: 65536 * 32 * 32 },
  qwenmax: { label: 'qwen-vl-max（新版）', maxDuration: 1200, maxSizeMB: 2048, imgMax: 80, tokenPixels: 1024, factor: 32, videoMaxPixels: 768 * 32 * 32, videoTotalPixels: 65536 * 32 * 32 },
  qwenvlplus: { label: 'qwen-vl-plus 系列', maxDuration: 600, maxSizeMB: 1024, imgMax: 80, tokenPixels: 1024, factor: 32, videoMaxPixels: 768 * 32 * 32, videoTotalPixels: 65536 * 32 * 32 },
  qwen25vl: { label: 'Qwen2.5-VL 开源 / QVQ 系列', maxDuration: 600, maxSizeMB: 1024, imgMax: 512, tokenPixels: 784, factor: 28, videoMaxPixels: 768 * 28 * 28, videoTotalPixels: 65536 * 28 * 28 },
  generic: { label: '通用估算（未收录模型）', maxDuration: 600, maxSizeMB: 150, imgMax: 80, tokenPixels: 1024, factor: 32, videoMaxPixels: 768 * 32 * 32, videoTotalPixels: 65536 * 32 * 32 },
};

/* 官方单价（北京地域，每百万 Token 元，2026-08 文档）：in=图片/视频输入价，out=文本输出价 */
const MODEL_PRICES = {
  'qwen3.5-omni-plus': { in: 7, out: 40 },
  'qwen3.5-omni-flash': { in: 2.2, out: 13.3 },
  'qwen3-omni-flash': { in: 3.3, out: 6.9 },
  'qwen3-vl-plus': { in: 1, out: 10 },
  'qwen3-vl-flash': { in: 0.15, out: 1.5 },
  'qwen-vl-max': { in: 1.6, out: 4 },
  'qwen-vl-plus': { in: 0.8, out: 2 },
};
function modelPrice(model) { return MODEL_PRICES[model] || null; }
/* 有效单价（¥/千Token）：设置 > 内置表 */
function effPrice(model) {
  const p = modelPrice(model);
  return {
    in: state.settings.priceIn != null ? state.settings.priceIn : (p ? p.in / 1000 : null),
    out: state.settings.priceOut != null ? state.settings.priceOut : (p ? p.out / 1000 : null),
  };
}

const BUILTIN_VISION_MODELS = [
  'qwen3-omni-flash', 'qwen3.5-omni-flash', 'qwen3.5-omni-plus',
  'qwen3.5-omni-flash-realtime', 'qwen3.5-omni-plus-realtime',
  'qwen3-vl-plus', 'qwen3-vl-flash', 'qwen3-vl-235b-a22b-thinking', 'qwen3-vl-235b-a22b-instruct',
  'qwen-vl-max', 'qwen-vl-max-latest', 'qwen-vl-plus', 'qwen-vl-plus-latest',
  'qwen2.5-vl-72b-instruct', 'qwen2.5-vl-32b-instruct', 'qwen2.5-vl-7b-instruct',
];
/* 纯文本模型：可用于理解完成后的分支对话（纯文本，不附带视频），不可用于视频理解首轮 */
const BUILTIN_TEXT_MODELS = [
  'qwen3.8-max', 'qwen3.7-plus', 'qwen3.7-flash', 'qwen3.6-plus', 'qwen3.6-flash',
  'qwen3.5-plus', 'qwen3.5-flash',
  'qwen-max', 'qwen-plus', 'qwen-turbo',
];

/* 模型分类：视觉/全模态（能看视频）vs 纯文本（只能对话）。
   注意：中文模型 id 不一定带 vl/omni 后缀前，用启发式判断——凡是不含视觉线索的 qwen 文本线都归纯文本 */
function modelIsText(modelName) {
  return !/(vl|omni|qvq|vision|image)/i.test(modelName || '');
}

/* 设置/拉取模型列表的保留规则：qwen 系对话模型（视觉 + 纯文本），排除 OCR/向量/音频/图像生成/翻译等非对话模型 */
function keepDialogModel(m) {
  const n = String(m || '').toLowerCase();
  if (!/^qwen/.test(n)) return false;
  if (/(ocr|embedding|audio|asr|tts|segment|speech|generation|arts|image|art|movie|i2v|t2v|copywriting|mt-|rag|search|thinkq|o-group)/i.test(n)) return false;
  return true;
}

function modelProfile(modelName) {
  const n = (modelName || '').toLowerCase();
  if (n.startsWith('qwen3.5-omni-plus')) return MODEL_TIERS.omniPlus;
  if (n.startsWith('qwen3.5-omni-flash')) return MODEL_TIERS.omniFlash;
  if (n.startsWith('qwen3-omni-flash')) return MODEL_TIERS.omniFlash;
  if (n.startsWith('qwen3-omni')) return MODEL_TIERS.omniFlash;
  if (n.startsWith('qwen3.8')) return MODEL_TIERS.qwen38;
  if (n.startsWith('qwen3.7')) return MODEL_TIERS.qwen37;
  if (n.startsWith('qwen3.6')) return MODEL_TIERS.qwen36;
  if (n.startsWith('qwen3.5')) return MODEL_TIERS.qwen35;
  if (n.startsWith('qwen3-vl-plus') || n.startsWith('qwen3-vl-flash') || n.startsWith('qwen3-vl-235b')) return MODEL_TIERS.qwen3vlx;
  if (n.startsWith('qwen3-vl')) return MODEL_TIERS.qwen3vlo;
  if (n.startsWith('qwen-vl-max')) return MODEL_TIERS.qwenmax;
  if (n.startsWith('qwen-vl-plus')) return MODEL_TIERS.qwenvlplus;
  if (n.startsWith('qwen2.5-vl') || n.startsWith('qvq')) return MODEL_TIERS.qwen25vl;
  if (n.startsWith('qwen-vl')) return MODEL_TIERS.qwenvlplus; // 其他 qwen-vl 按 plus 档
  if (n.startsWith('qwen-omni-turbo')) return MODEL_TIERS.omniFlash; // 停止更新，仅作降级
  return MODEL_TIERS.generic;
}
function modelTierKey(modelName) {
  const p = modelProfile(modelName);
  for (const k in MODEL_TIERS) if (MODEL_TIERS[k] === p) return k;
  return 'generic';
}

/* ---------------- 模型指南（选型帮助：推荐标签 / 适用场景 / 限制） ----------------
   brief 用于下拉悬停与输入区一行提示；scene/limit 用于向导与帮助弹层 */
const MODEL_GUIDES = {
  omniFlash: {
    tag: '🏆 主推', brief: '短视频首选 · 可听声音 · ≤150 秒',
    scene: '短视频（≤150 秒）首选：画面 + 声音/音乐/人声全能理解，性价比最高；适合宣传片、短视频、演示、短剧片段。',
    limit: '单次视频 ≤150 秒（超长请截片段或换 omni-plus / vl）；建议以非思考模式运行，出字更快。',
  },
  omniPlus: {
    tag: '💎 旗舰', brief: '长视频旗舰 · 可听声音 · ≤1 小时 · 费用较高',
    scene: '长视频（≤1 小时）深度分析：声音与画面双通道，支持音频输出、联网搜索佐证；电影/纪录片/长课次的严肃理解首选。',
    limit: '≤1 小时；输出音频时需保持流式开启；单价较高，长视频单轮费用明显。',
  },
  qwen3vlx: {
    tag: '📺 长视频·纯视觉', brief: '长视频省钱 · 只看画面 · ≤1 小时',
    scene: '纯视觉（不听声音）：比 Omni 便宜、支持更长视频，适合 2.5 分钟~1 小时内、无需分析声音/字幕的素材。',
    limit: '≤1 小时；无音频感知——"声音/音乐/人声"类问题答不了；价格与画面 Token 挂钩。',
  },
  qwenmax: {
    tag: '🎬 传统视觉主力', brief: '画面质量稳 · 无音频 · ≤20 分钟',
    scene: '经典视觉大模型，画面细节理解稳定，适合 20 分钟内的广告片、产品演示、MV。',
    limit: '≤20 分钟；无音频感知。',
  },
  qwenvlplus: {
    tag: '💡 老牌视觉', brief: '短时长够用 · 无音频 · ≤10 分钟',
    scene: '短时视频的画面分析，便宜够用；快速批量过素材可用它。',
    limit: '≤10 分钟；无音频感知。',
  },
  qwen25vl: {
    tag: '🔧 开源视觉', brief: '开源生态 · 无音频 · ≤10 分钟',
    scene: '开源视觉模型生态（Qwen2.5-VL / QVQ），适合特定开源部署与推理场景。',
    limit: '≤10 分钟；无音频感知；免费额度与商用规则以百炼为准。',
  },
  qwen35: { tag: '📄 纯文本', brief: '追问讨论省钱 · 不能看视频',
    scene: '理解完成后「对话」的最佳选择：追问细节、总结改写、多轮深度讨论，输入便宜。',
    limit: '不能理解视频：仅用于不勾选「每轮附带视频」的纯文本对话；假设性内容建议配视觉模型核对。',
  },
  qwen36: { tag: '📄 纯文本', brief: '追问讨论省钱 · 不能看视频',
    scene: '理解完成后「对话」的最佳选择：追问细节、总结改写、多轮深度讨论，输入便宜。',
    limit: '不能理解视频：仅用于不勾选「每轮附带视频」的纯文本对话；假设性内容建议配视觉模型核对。',
  },
  qwen37: { tag: '📄 纯文本', brief: '追问讨论省钱 · 不能看视频',
    scene: '理解完成后「对话」的最佳选择：追问细节、总结改写、多轮深度讨论，输入便宜。',
    limit: '不能理解视频：仅用于不勾选「每轮附带视频」的纯文本对话；假设性内容建议配视觉模型核对。',
  },
  qwen38: { tag: '📄 纯文本', brief: '追问讨论省钱 · 不能看视频',
    scene: '理解完成后「对话」的最佳选择：追问细节、总结改写、多轮深度讨论，输入便宜。',
    limit: '不能理解视频：仅用于不勾选「每轮附带视频」的纯文本对话；假设性内容建议配视觉模型核对。',
  },
  generic: { tag: '❔ 通用估算', brief: '未收录 · 按通用规则估算',
    scene: '内置档案未收录的模型：界面按通用规则估算 Token 与限制，实际以百炼为准。',
    limit: '请以百炼官方文档确认时长/大小限制；特别提醒：纯文本模型（不带 vl/omni）无法理解视频。',
  },
};

function modelGuide(modelName) {
  const g = MODEL_GUIDES[modelTierKey(modelName)];
  return g || MODEL_GUIDES.generic;
}

/* 模型说明卡片 HTML（向导第 2 步 / 对话区 ⓘ 弹层共用） */
function buildModelInfoHtml(model, priceMode = 'full') {
  const prof = modelProfile(model);
  const g = modelGuide(model);
  const tierKey = modelTierKey(model);
  const pr = effPrice(model);
  const priceLine = (pr.in != null || pr.out != null)
    ? `输入 ¥${(pr.in != null ? pr.in : 0).toFixed(3)} / 输出 ¥${(pr.out != null ? pr.out : 0).toFixed(3)} 每千 Token` +
      (modelPrice(model) ? '' : '（自定义单价）')
    : '价格未收录（可在 ⚙ 设置中填写单价）';
  const maxSize = prof.maxSizeMB >= 1024 ? (prof.maxSizeMB / 1024) + 'GB' : prof.maxSizeMB + 'MB';
  return `
    <div class="mi-top"><span class="mi-tag">${esc(g.tag)}</span><b>${esc(model)}</b>${priceMode === 'wizard' ? '' : ''}</div>
    <div class="mi-line"><span class="mi-k">适用场景</span><span>${esc(g.scene)}</span></div>
    <div class="mi-line"><span class="mi-k">主要限制</span><span>${esc(g.limit)}</span></div>
    <div class="mi-line"><span class="mi-k">当前单价</span><span>${esc(priceLine)}</span></div>
    <div class="mi-params">可传视频时长 <b>2s ~ ${fmtDuration(prof.maxDuration)}</b> · 公网 URL ≤ <b>${maxSize}</b> · 图像列表 ≤ <b>${prof.imgMax} 张</b> · 每视觉 Token 对应 <b>${Math.sqrt(prof.tokenPixels)}×${Math.sqrt(prof.tokenPixels)} 像素</b>（因子 ${prof.factor}）</div>
    ${tierKey === 'generic' ? '<div class="mi-warn">⚠ 该模型未收录于内置档案，按通用规则估算，实际限制以百炼为准。</div>' : ''}`;
}

/* ---------------- Token 估算（百炼官方规则实现） ---------------- */
function roundByFactor(num, factor) { return Math.round(num / factor) * factor; }

/* 视频抽帧数：fps 参数 → 帧数（官方 smart_nframes 简化：最少 4 帧，上限 2000） */
function estimateFrames(durationSec, fps, videoFps) {
  fps = fps || 2.0;
  const totalFrames = Math.max(1, Math.ceil(durationSec * (videoFps || 30)));
  const minFrames = 4;
  const maxFrames = Math.min(2000, totalFrames);
  let nframes = durationSec * fps;
  nframes = Math.min(Math.max(nframes, minFrames), maxFrames);
  // 官方按 FRAME_FACTOR=2 对齐偶数
  return Math.max(4, Math.round(nframes / 2) * 2);
}

/* 单帧 smart_resize：按 factor 对齐，约束在 [minPixels, maxPixels]，并满足视频总像素上限 */
function frameSize(h, w, factor, maxPixels, totalPixels, nframes) {
  h = h > 0 ? h : 1080; w = w > 0 ? w : 1920;
  const minPixels = 4 * factor * factor;
  let hb = Math.max(factor, roundByFactor(h, factor));
  let wb = Math.max(factor, roundByFactor(w, factor));
  if (hb * wb > maxPixels) {
    const beta = Math.sqrt((h * w) / maxPixels);
    hb = Math.max(factor, Math.floor(h / beta / factor) * factor);
    wb = Math.max(factor, Math.floor(w / beta / factor) * factor);
  } else if (hb * wb < minPixels) {
    const beta = Math.sqrt(minPixels / (h * w));
    hb = Math.max(factor, Math.ceil(h * beta / factor) * factor);
    wb = Math.max(factor, Math.ceil(w * beta / factor) * factor);
  }
  if (totalPixels && nframes > 0 && nframes * hb * wb > totalPixels) {
    // 视频总像素超预算：按官方逻辑把每帧缩小（beta>1，缩小系数），对齐 factor
    const perFrame = totalPixels / nframes;
    const beta = Math.sqrt((hb * wb) / perFrame);
    hb = Math.max(factor, Math.floor(hb / beta / factor) * factor);
    wb = Math.max(factor, Math.floor(wb / beta / factor) * factor);
  }
  return [hb, wb];
}

/* 视频输入 Token 估算（视频文件方式，按官方公式：n 帧 × 每帧像素/每Token像素 + 2） */
function estimateVideoTokens(profile, durationSec, width, height, fps, videoFps) {
  const factor = profile.factor;
  const nframes = estimateFrames(durationSec, fps, videoFps);
  const [hb, wb] = frameSize(height, width, factor, profile.videoMaxPixels, profile.videoTotalPixels, nframes);
  const perFrame = (hb * wb) / (factor * factor);
  const videoTokens = Math.round(nframes * perFrame) + 2;
  return { frames: nframes, frameW: wb, frameH: hb, perFrame: Math.round(perFrame), videoTokens };
}

/* 文本 Token 近似估算（中文约 0.65 token/字，英文约 0.28 token/字符） */
function estimateTextTokens(text) {
  const s = String(text == null ? '' : text);
  let cjk = 0, ascii = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0x4e00 && c <= 0x9fff) cjk += 1;
    else if (c < 128) ascii += 1;
    else cjk += 0.8;
  }
  return Math.ceil(cjk * 0.65 + ascii * 0.28);
}

/* 消息数组文本 Token 汇总 */
function messagesTextTokens(messages) {
  let sum = 0;
  for (const m of messages || []) {
    if (typeof m.content === 'string') sum += estimateTextTokens(m.content);
  }
  return sum;
}

/* ---------------- IndexedDB 持久化 ---------------- */
const DB = (() => {
  let dbp = null;
  function open() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const rq = indexedDB.open('vdu-workspace', 1);
        rq.onupgradeneeded = (e) => {
          const db = rq.result;
          if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('conversations')) db.createObjectStore('conversations', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('messages')) {
            const s = db.createObjectStore('messages', { keyPath: 'id' });
            s.createIndex('convId', 'convId', { unique: false });
          }
        };
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => reject(rq.error);
      });
    }
    return dbp;
  }
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const out = fn(s);
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  return {
    put: (store, val) => tx(store, 'readwrite', (s) => s.put(val)),
    get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
    getAll: (store) => tx(store, 'readonly', (s) => s.getAll()),
    del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
    byIndex: (store, idx, key) => tx(store, 'readonly', (s) => s.index(idx).getAll(key)),
    clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
  };
})();

/* ---------------- API 客户端（本地服务代理） ---------------- */
const Api = {
  async health() { const r = await fetch('/api/health'); return r.json(); },
  async config() { const r = await fetch('/api/config'); return r.json(); },
  async saveConfig(cfg) {
    const r = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
    return r.json();
  },
  async checkUrl(url) {
    const r = await fetch('/api/checkurl', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    return r.json();
  },
  upload(file, model, onProgress, onTransit, ctrl) {
    /* ctrl（可选）：{ aborted:false }，用于取消上传。
       - 阶段一（浏览器→本地服务）：ctrl.abortXhr() 中断 XHR；
       - 阶段二（本地服务→百炼 OSS）：轮询中检测到 ctrl.aborted 时通知服务端停止转存 */
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      let settled = false;
      const fail = (err) => { if (!settled) { settled = true; reject(err); } };
      if (ctrl) ctrl.abortXhr = () => { ctrl.aborted = true; try { xhr.abort(); } catch (e) { /* ignore */ } };
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.upload.onerror = () => fail(new Error('上传中断，请检查本地服务是否运行'));
      xhr.onerror = () => fail(new Error('网络错误：无法连接本地服务'));
      xhr.onabort = () => fail(new Error('已取消上传'));
      xhr.onload = () => {
        let obj = null;
        try { obj = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
        if (xhr.status === 200 && obj && obj.ok && obj.uploadKey) {
          /* 接收完成：本地服务后台转存至百炼临时 OSS，轮询进度直到完成/出错/取消 */
          if (settled) return;   // 取消竞态：onabort 可能先于 onload
          if (ctrl) ctrl.uploadKey = obj.uploadKey;   // 供外层记录断点（刷新恢复）
          const abortCheck = () => {
            if (!ctrl || !ctrl.aborted) return false;
            fetch('/api/upload_cancel?key=' + encodeURIComponent(obj.uploadKey), { method: 'POST', cache: 'no-store' }).catch(() => { /* ignore */ });
            return true;
          };
          pollTransit(obj.uploadKey, (v) => { if (!settled) { settled = true; resolve(v); } }, (e) => fail(e), onTransit, abortCheck);
        } else {
          fail(new Error((obj && obj.error) || ('上传失败 (HTTP ' + xhr.status + ')')));
        }
      };
      const fd = new FormData();
      fd.append('model', model);
      fd.append('file', file, file.name);
      xhr.send(fd);
    });
  },
  compress(file, model, settings, onProgress, onPhase, ctrl) {
    /* 压缩：接收视频到本地服务 → 转码（可选并上传百炼）→ 返回结果。ctrl 支持取消 */
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/compress');
      let settled = false;
      const fail = (err) => { if (!settled) { settled = true; reject(err); } };
      if (ctrl) ctrl.abortXhr = () => { ctrl.aborted = true; try { xhr.abort(); } catch (e) {} };
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.upload.onerror = () => fail(new Error('上传中断，请检查本地服务是否运行'));
      xhr.onerror = () => fail(new Error('网络错误：无法连接本地服务'));
      xhr.onabort = () => fail(new Error('已取消压缩'));
      xhr.onload = () => {
        let obj = null;
        try { obj = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhr.status === 200 && obj && obj.ok && obj.compressKey) {
          if (settled) return;
          if (ctrl) ctrl.compressKey = obj.compressKey;
          const abortCheck = () => {
            if (!ctrl || !ctrl.aborted) return false;
            fetch('/api/compress_cancel?key=' + encodeURIComponent(obj.compressKey), { method: 'POST', cache: 'no-store' }).catch(() => {});
            return true;
          };
          pollCompress(obj.compressKey, (v) => { if (!settled) { settled = true; resolve(v); } }, (e) => fail(e), onPhase, abortCheck);
        } else {
          fail(new Error((obj && obj.error) || ('压缩失败 (HTTP ' + xhr.status + ')')));
        }
      };
      const fd = new FormData();
      fd.append('model', model);
      fd.append('target_res', settings.targetRes || '720');
      fd.append('target_fps', settings.targetFps || 'keep');
      fd.append('quality', settings.quality || 'medium');
      fd.append('auto_upload', settings.autoUpload ? '1' : '0');
      fd.append('file', file, file.name);
      xhr.send(fd);
    });
  },
  async models() {
    const r = await fetch('/api/models');
    const obj = await r.json();
    if (!r.ok) throw new Error(obj.error || '获取模型列表失败');
    return obj.models || [];
  },
  async chatStream(payload, onDelta, signal) {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    if (!r.ok) {
      let msg = '请求失败 (HTTP ' + r.status + ')';
      try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    if (!r.body) {
      const j = await r.json();
      const ch = j.choices && j.choices[0];
      if (!ch) throw new Error('接口返回异常');
      onDelta({ content: ch.message && ch.message.content || '', reasoning: (ch.message && ch.message.reasoning_content) || '', finish: ch.finish_reason || 'stop' });
      return { usage: j.usage || null };
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', usage = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const payloadStr = line.slice(5).trim();
        if (payloadStr === '[DONE]') continue;
        let obj; try { obj = JSON.parse(payloadStr); } catch (e) { continue; }
        if (obj.usage) { usage = obj.usage; continue; }
        const ch = obj.choices && obj.choices[0];
        if (!ch || !ch.delta) continue;
        onDelta({ content: ch.delta.content || '', reasoning: ch.delta.reasoning_content || '', finish: ch.finish_reason || null });
      }
    }
    return { usage };
  },
};

/* 轮询服务器端转存进度（服务器后台上传到百炼临时 OSS）：
   phase: received → presign → uploading → done / error / canceled
   超时策略（重要）：不再用"从开始起 30 分钟"的墙钟一刀切——
   1GB 视频在上行慢时转存 >30 分钟完全正常，被误杀后服务端仍在偷偷上传，
   与用户重试任务互相踩踏。改为「活跃度」模型：
     - 有进展（progress 变化）即续命；
     - 总墙钟上限 120 分钟（防永久挂死）；
     - 无任何进展 10 分钟判"停滞"（网络卡死），报错并给出重试指引 */
async function pollTransit(key, resolve, reject, onTransit, abortCheck) {
  const t0 = Date.now();
  const TOTAL_LIMIT = 120 * 60;    // 总上限（秒）
  const STALL_LIMIT = 10 * 60;     // 无进展阈值（秒）
  let lastProg = -1, lastChange = Date.now();
  for (;;) {
    if (abortCheck && abortCheck()) {
      reject(new Error('已取消上传'));
      return;
    }
    let s = null;
    try {
      const r = await fetch('/api/upload_status?key=' + encodeURIComponent(key), { cache: 'no-store' });
      s = await r.json();
    } catch (e) { /* 网络抖动，继续轮询 */ }
    const phase = (s && s.phase) || 'received';
    const progress = (s && s.progress) || 0;
    const waited = Math.floor((Date.now() - t0) / 1000);
    if (s && s.error) { reject(new Error(s.error)); return; }
    if (phase === 'done' && s && s.result) {
      if (onTransit) onTransit({ phase, progress: 1, waited, msg: '转存完成' });
      resolve({ ...s.result, waited });
      return;
    }
    if (phase === 'error') {
      reject(new Error((s && s.error) || '转存失败'));
      return;
    }
    if (phase === 'canceled') {
      reject(new Error('已取消上传'));
      return;
    }
    if (progress !== lastProg) { lastProg = progress; lastChange = Date.now(); }
    const stalled = Math.floor((Date.now() - lastChange) / 1000);
    if (waited > TOTAL_LIMIT) {
      reject(new Error('转存超时（已等待 2 小时仍无结果），请检查网络后重试'));
      return;
    }
    if (waited > 60 && stalled > STALL_LIMIT) {
      reject(new Error('转存停滞（10 分钟无进展，可能网络中断或凭证失效），请检查网络后重试'));
      return;
    }
    if (onTransit) onTransit({ phase, progress, waited, msg: '' });
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/* 轮询服务端压缩进度：phase 为 received → probing → compressing → uploading → done / error / canceled */
async function pollCompress(key, resolve, reject, onPhase, abortCheck) {
  const t0 = Date.now();
  const TOTAL_LIMIT = 60 * 60;    // 总上限（秒）1 小时
  const STALL_LIMIT = 15 * 60;    // 无进展阈值（秒）
  let lastProg = -1, lastChange = Date.now();
  for (;;) {
    if (abortCheck && abortCheck()) { reject(new Error('已取消压缩')); return; }
    let s = null;
    try {
      const r = await fetch('/api/compress_status?key=' + encodeURIComponent(key), { cache: 'no-store' });
      s = await r.json();
    } catch (e) { /* 网络抖动，继续轮询 */ }
    const phase = (s && s.phase) || 'received';
    const progress = (s && s.progress) || 0;
    const waited = Math.floor((Date.now() - t0) / 1000);
    if (s && s.error) { reject(new Error(s.error)); return; }
    if (phase === 'done' && s && s.result) {
      if (onPhase) onPhase({ phase, progress: 1, waited, msg: '完成' });
      resolve({ ...s.result, waited });
      return;
    }
    if (phase === 'error') { reject(new Error((s && s.error) || '压缩失败')); return; }
    if (phase === 'canceled') { reject(new Error('已取消压缩')); return; }
    if (progress !== lastProg) { lastProg = progress; lastChange = Date.now(); }
    const stalled = Math.floor((Date.now() - lastChange) / 1000);
    if (waited > TOTAL_LIMIT) { reject(new Error('压缩超时（已等待 1 小时），请检查后重试')); return; }
    if (waited > 60 && stalled > STALL_LIMIT) { reject(new Error('压缩停滞（15 分钟无进展），可能 ffmpeg 卡住，请重试')); return; }
    if (onPhase) onPhase({ phase, progress, waited, msg: '' });
    await new Promise((r2) => setTimeout(r2, 800));
  }
}

/* ---------------- 视频压缩面板 ---------------- */
let _cmpFile = null, _cmpCtrl = null, _cmpResult = null;
function cmpPhaseLabel(p) {
  return { received: '接收文件', probing: '分析视频', compressing: '压缩中', uploading: '上传到百炼', done: '完成', error: '出错', canceled: '已取消' }[p] || p;
}
function openCompress() {
  if (!wiz.file) { toast('请先选择本地视频文件', 'err'); return; }
  if (!state.settings.hasKey) { toast('未配置 API Key，无法压缩并上传', 'err'); return; }
  if (!state.serverFfmpeg) { toast('未检测到 ffmpeg（请把 ffmpeg.exe 放入项目 ffmpeg\\ 文件夹）', 'err'); return; }
  _cmpFile = wiz.file; _cmpCtrl = null; _cmpResult = null;
  $('#cmpResult').classList.add('hidden');
  $('#cmpStatusWrap').classList.add('hidden');
  $('#cmpStart').classList.remove('hidden');
  $('#cmpCancel').classList.add('hidden');
  $('#cmpUse').classList.add('hidden');
  $('#cmpBarFill').style.width = '0%';
  $('#modalCompress').classList.remove('hidden');
}
async function startCompress() {
  if (!_cmpFile) return;
  const model = $('#wizModelSelect').value;
  const settings = {
    targetRes: $('#cmpRes').value, targetFps: $('#cmpFps').value,
    quality: $('#cmpQuality').value, autoUpload: $('#cmpAutoUpload').checked,
  };
  $('#cmpStatusWrap').classList.remove('hidden');
  $('#cmpResult').classList.add('hidden');
  $('#cmpStart').classList.add('hidden');
  $('#cmpCancel').classList.remove('hidden');
  $('#cmpUse').classList.add('hidden');
  const ctrl = { aborted: false, abortXhr: null, compressKey: null };
  _cmpCtrl = ctrl;
  $('#cmpCancel').onclick = () => { if (ctrl.abortXhr) ctrl.abortXhr(); };
  try {
    const r = await Api.compress(_cmpFile, model, settings, (p) => {
      $('#cmpBarFill').style.width = Math.round(p * 100) + '%';
      if (p < 1) $('#cmpStat').textContent = '上传文件到本地服务… ' + Math.round(p * 100) + '%';
    }, ({ phase, progress, waited }) => {
      const mm = String(Math.floor(waited / 60)).padStart(2, '0'), ss = String(waited % 60).padStart(2, '0');
      $('#cmpStatus').textContent = cmpPhaseLabel(phase);
      if (phase === 'done') { $('#cmpBarFill').style.width = '100%'; $('#cmpStat').textContent = '压缩完成 ✓'; }
      else if (progress > 0) {
        $('#cmpBarFill').style.width = Math.round(Math.max(2, progress * 100)) + '%';
        $('#cmpStat').textContent = cmpPhaseLabel(phase) + ' ' + Math.round(progress * 100) + '% · 已等待 ' + mm + ':' + ss;
      } else {
        $('#cmpBarFill').style.width = '8%';
        $('#cmpStat').textContent = cmpPhaseLabel(phase) + '… 已等待 ' + mm + ':' + ss;
      }
    }, ctrl);
    _finishCompress(r);
  } catch (e) {
    $('#cmpStat').textContent = '失败：' + e.message;
    $('#cmpBarFill').style.width = '0%';
    $('#cmpStart').classList.remove('hidden');
    $('#cmpCancel').classList.add('hidden');
  }
}
function _finishCompress(r) {
  let html = '压缩完成：' + (r.fileName || '') + '<br>';
  if (r.width) html += r.width + '×' + r.height + (r.fps ? ' @' + r.fps.toFixed(1) + 'fps' : '') + ' · ' + fmtBytes(r.fileSize || 0);
  if (r.url) html += '<br>已上传到百炼临时存储（48h 有效）';
  else html += '<br><a href="/compressed/' + encodeURIComponent(r.path) + '" download>下载压缩结果</a>';
  $('#cmpResult').innerHTML = html;
  $('#cmpResult').classList.remove('hidden');
  $('#cmpCancel').classList.add('hidden');
  $('#cmpUse').classList.toggle('hidden', !r.url);
  _cmpResult = r.url ? r : null;
}
function useCompressResult() {
  if (!_cmpResult || !_cmpResult.url) return;
  wiz.uploadResult = _cmpResult;
  wiz.meta = { name: _cmpResult.fileName, size: _cmpResult.fileSize, duration: _cmpResult.duration, width: _cmpResult.width, height: _cmpResult.height, fps: _cmpResult.fps };
  $('#modalCompress').classList.add('hidden');
  toast('已应用压缩结果，点「开始理解」继续', 'ok');
  renderEstimate();
  $('#uploadPanel').classList.remove('hidden');
  $('#upName').textContent = _cmpResult.fileName || '视频';
  $('#upStat').textContent = '压缩已上传 ✓ 临时链接 48 小时有效';
  $('#upBarFill').style.width = '100%';
}

/* ---------------- 全局状态 ---------------- */
const state = {
  projects: [], conversations: [], messages: [],
  activeProjectId: null, activeConvId: null,
  settings: { models: [], hasKey: false, baseUrl: '', priceIn: null, priceOut: null, customModels: [] },
  serverOk: null,
  streaming: false,
};

function activeProject() { return state.projects.find(p => p.id === state.activeProjectId) || null; }
function activeConv() { return state.conversations.find(c => c.id === state.activeConvId) || null; }
function convsOf(pid) { return state.conversations.filter(c => c.projectId === pid).sort((a, b) => a.createdAt - b.createdAt); }
function msgsOf(cid) { return state.messages.filter(m => m.convId === cid).sort((a, b) => a.ts - b.ts); }

/* ---------------- 视频文件探测（本地文件：时长/分辨率/帧率/缩略图） ---------------- */
function probeVideoFile(file) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.src = url;
    const meta = { name: file.name, size: file.size, ext: (file.name.split('.').pop() || '').toUpperCase() };
    /* 总超时兜底：某些编码/容器可能既不触发 loadedmetadata 也不触发 error */
    const failT = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { v.pause(); } catch (e) { /* ignore */ }
      URL.revokeObjectURL(url);
      reject(new Error('解析视频信息超时（浏览器不支持该编码或文件异常）'));
    }, 15000);
    const cleanup = () => { clearTimeout(failT); try { v.pause(); } catch (e) { /* ignore */ } URL.revokeObjectURL(url); };
    const finish = (fps) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ...meta, duration: v.duration, width: v.videoWidth, height: v.videoHeight, fps, file });
    };
    v.onloadedmetadata = () => {
      try { v.currentTime = Math.min(0.1, (v.duration || 1) / 2); } catch (e) { /* ignore */ }
      /* fps 探测二次兜底：帧回调不触发（如后台标签页）则放弃 fps，不阻塞主流程 */
      let fpsDone = false;
      const doneFps = (fps) => { if (fpsDone || settled) return; fpsDone = true; finish(fps); };
      const fpsTimer = setTimeout(() => doneFps(null), 4000);
      if ('requestVideoFrameCallback' in v) {
        let frames = 0, t0 = 0;
        const cb = (now, _md) => {
          frames += 1;
          if (t0 === 0) { t0 = now; v.requestVideoFrameCallback(cb); return; }
          if (now - t0 < 1200) { v.requestVideoFrameCallback(cb); return; }
          clearTimeout(fpsTimer);
          doneFps(frames / ((now - t0) / 1000));
        };
        v.play().then(() => v.requestVideoFrameCallback(cb)).catch(() => doneFps(null));
      } else {
        doneFps(null);
      }
    };
    v.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(failT);
      try { v.pause(); } catch (e) { /* ignore */ }
      URL.revokeObjectURL(url);
      reject(new Error('无法解析该视频文件（浏览器不支持该编码格式）'));
    };
    v.load();
  });
}

function captureThumb(videoEl, maxW = 320, quality = 0.5) {
  return new Promise((resolve) => {
    try {
      const c = document.createElement('canvas');
      const scale = Math.min(1, maxW / (videoEl.videoWidth || 1));
      c.width = Math.max(1, Math.round((videoEl.videoWidth || 1) * scale));
      c.height = Math.max(1, Math.round((videoEl.videoHeight || 1) * scale));
      c.getContext('2d').drawImage(videoEl, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', quality));
    } catch (e) { resolve(null); }
  });
}

/* =========================================================================
 * UI 渲染
 * ========================================================================= */
function renderServerBadge() {
  const b = $('#serverBadge');
  const badge = $('#apiKeyBadge');
  if (state.serverOk === null) {
    b.textContent = '服务检测中…';
    b.className = 'badge badge-warn';
  } else if (state.serverOk === false) {
    b.textContent = '⚠ 本地服务未连接（请双击 启动.cmd）';
    b.className = 'badge badge-warn';
  } else {
    b.textContent = '● 服务已连接: ' + (state.settings.baseUrl || 'dashscope.aliyuncs.com');
    b.className = 'badge badge-ok';
  }
  badge.className = state.settings.hasKey ? 'badge badge-ok' : 'badge badge-warn';
  badge.textContent = state.settings.hasKey ? '● API Key 已配置' : '未配置 API Key';
}

function renderProjects() {
  const list = $('#projectList');
  const empty = $('#projectEmptyHint');
  const projects = state.projects.slice().sort((a, b) => b.createdAt - a.createdAt);
  empty.style.display = projects.length ? 'none' : '';
  list.querySelectorAll('.project-item').forEach((el) => el.remove());
  for (const p of projects) {
    const div = document.createElement('div');
    div.className = 'project-item' + (p.id === state.activeProjectId ? ' active' : '');
    const convCount = state.conversations.filter(c => c.projectId === p.id).length;
    const expired = p.videoRef && p.videoRef.type === 'oss' && p.videoRef.expireAt && nowMs() > p.videoRef.expireAt;
    div.innerHTML = `
      <div class="p-main">
        <div class="p-name" title="${esc(p.name)}">${esc(p.name)}</div>
        <div class="p-sub">
          <span class="pi">${fmtDuration(p.videoInfo ? p.videoInfo.duration : null)}</span>
          <span class="pi" title="${esc(p.model || '')}">${esc(p.model || '-')}</span>
          <span class="pi">${convCount} 个对话</span>
          ${expired ? '<span class="pi warn" title="视频临时链接已过期，需重新上传">⚠ 链接过期</span>' : ''}
        </div>
      </div>
      <div class="p-thumb">${p.thumb ? `<img src="${p.thumb}" alt="">` : '🎞'}</div>`;
    div.addEventListener('click', () => selectProject(p.id));
    list.appendChild(div);
  }
}

function renderVideoCard() {
  const card = $('#videoCard');
  const p = activeProject();
  if (!p) { card.classList.add('hidden'); $('#convPanelTitle').textContent = '对话'; $('#convFoot').textContent = ''; return; }
  card.classList.remove('hidden');
  $('#convPanelTitle').textContent = '对话 · ' + p.name;
  const isOss = p.videoRef && p.videoRef.type === 'oss';
  $('#btnVideoReupload').classList.toggle('hidden', !isOss);
  const expired = p.videoRef && p.videoRef.type === 'oss' && p.videoRef.expireAt && nowMs() > p.videoRef.expireAt;
  $('#videoThumbBox').innerHTML = p.thumb ? `<img src="${p.thumb}" alt="">` : '🎞';
  $('#videoName').textContent = p.name;
  const info = p.videoInfo || {};
  const spec = [];
  if (info.duration) spec.push('时长 ' + fmtDuration(info.duration));
  if (info.width) spec.push((info.width + '×' + info.height));
  if (p.videoRef && p.videoRef.size) spec.push(fmtBytes(p.videoRef.size));
  spec.push(p.videoRef && p.videoRef.type === 'oss' ? '已上传临时链接' : '公网 URL');
  if (expired) spec.push('⚠ 链接已过期，需重新上传');
  $('#videoSpec').innerHTML = spec.map(esc).join(' · ');
  $('#convFoot').textContent = expired ? '视频临时链接已过期（48h），重新理解时需重新上传。' : (p.videoRef && p.videoRef.type === 'oss'
    ? '临时链接有效期至 ' + fmtDate(p.videoRef.expireAt || nowMs()) + '，过期后需重新上传。'
    : '公网 URL 视频：直接引用，无需上传。');
}

async function renderConvList() {
  const list = $('#convList');
  const empty = $('#convEmptyHint');
  const p = activeProject();
  const convs = p ? convsOf(p.id) : [];
  /* 分支对话按钮：有项目才可点 */
  $('#btnNewConv').disabled = !p;
  empty.style.display = convs.length ? 'none' : '';
  list.querySelectorAll('.conv-item').forEach((el) => el.remove());
  /* 注意：state.messages 只保存「当前对话」的消息，其他对话的预览必须从数据库读取 */
  const rows = await Promise.all(convs.map(async (c) => {
    let last = null, count = 0;
    try {
      const msgs = await DB.byIndex('messages', 'convId', c.id);
      count = msgs.length;
      last = msgs.length ? msgs[msgs.length - 1] : null;
    } catch (e) { /* 单条读取失败不影响其他项 */ }
    return { c, last, count };
  }));
  for (const { c, last, count } of rows) {
    const div = document.createElement('div');
    div.className = 'conv-item' + (c.id === state.activeConvId ? ' active' : '');
    let preview = '尚无消息';
    if (last) {
      const roleTag = last.role === 'user' ? '我' : 'AI';
      const txt = (last.error ? '⚠ ' : '') + (typeof last.content === 'string' ? last.content : '[视频消息]');
      preview = `${roleTag}：${txt}`;
    }
    div.innerHTML = `
      <div class="c-dot"></div>
      <div class="c-main">
        <div class="c-name">${esc(c.name)}</div>
        <div class="c-sub" title="${esc(preview)}">${esc(preview)}</div>
      </div>
      <div class="c-time" title="消息数 ${count} · 更新于">${fmtTime(c.updatedAt)}</div>`;
    div.addEventListener('click', () => selectConv(c.id));
    list.appendChild(div);
  }
}

function renderChatHead() {
  const c = activeConv();
  const tools = $('#chatTools');
  if (!c) {
    $('#chatTitle').textContent = '开始';
    tools.classList.add('hidden');
    $('#chatInputArea').classList.add('hidden');
    $('#usageBar').classList.add('hidden');
    $('#btnScrollBottom').classList.add('hidden');
    return;
  }
  tools.classList.remove('hidden');
  $('#chatInputArea').classList.remove('hidden');
  $('#chatTitle').textContent = c.name;
  $('#chatAttachVideo').checked = !!c.attachVideo;
  $('#attachVideoWrap').title = '开启后每一轮对话都会附带视频文件，模型可随时核对画面；每轮都会重新计算视频 Token（费用更高）';
  fillModelSelect($('#chatModelSelect'), c.model);
}

function fillModelSelect(sel, selected, visionOnly = false) {
  /* 分组：视觉/全模态（图、视频、全模态理解） + 纯文本（仅对话，不可附视频）。
     visionOnly=true（向导「理解」步）只显示视觉/全模态 —— 视频理解首轮必须能看视频 */
  const vis = [];
  const txt = [];
  const seen = new Set();
  const push = (arr, m) => { if (m && !seen.has(m)) { seen.add(m); arr.push(m); } };
  for (const m of BUILTIN_VISION_MODELS) push(vis, m);
  for (const m of BUILTIN_TEXT_MODELS) push(txt, m);
  for (const m of state.settings.customModels || []) push(modelIsText(m) ? txt : vis, m);
  const known = new Set([...vis, ...txt]);
  const custom = (selected && !known.has(selected)) ? [selected] : [];
  /* title 只放一句 brief（悬停提示，避免超长 tooltip 在低配机上渲染卡顿；完整说明看 ⓘ / 向导第 2 步） */
  const opt = (m, label) => `<option value="${esc(m)}"${m === selected ? ' selected' : ''} title="${esc(modelGuide(m).brief)}">${esc(label || m)}</option>`;
  let html = `<optgroup label="视觉 / 全模态（视频理解）">` +
    vis.map(m => opt(m)).join('') + '</optgroup>';
  if (!visionOnly) {
    html += `<optgroup label="纯文本模型（仅对话）">` +
      txt.map(m => opt(m, m + '（文本）')).join('') + '</optgroup>';
  }
  if (custom.length) html += '<optgroup label="当前使用">' + custom.map(m => opt(m, m + '（自定义）')).join('') + '</optgroup>';
  sel.innerHTML = html;
}

/* 对话区 ⓘ：查看当前模型说明 */
function openModelInfo() {
  const c = activeConv();
  const model = c ? c.model : ($('#chatModelSelect').value || '');
  if (!model) { toast('请先选择或新建一个对话', ''); return; }
  $('#modelInfoTitle').textContent = '模型说明';
  $('#modelInfoBody').innerHTML = buildModelInfoHtml(model);
  $('#modalModelInfo').classList.remove('hidden');
}

function renderChat() {
  const box = $('#chatMessages');
  const c = activeConv();
  const empty = $('#chatEmptyHint');
  box.querySelectorAll('.msg').forEach((el) => el.remove());
  $('#usageBar').classList.add('hidden');
  if (!c) {
    empty.querySelector('p').textContent = '选择或新建一个对话';
    empty.querySelector('.empty-sub').textContent = '在项目下可建立多个分支对话，围绕同一视频进行不同方向的讨论';
    empty.style.display = '';
    return;
  }
  const msgs = msgsOf(c.id);
  if (msgs.length) {
    empty.style.display = 'none';
    for (const m of msgs) appendMsgEl(box, m, false);
  } else {
    empty.querySelector('p').textContent = '对话已就绪';
    empty.querySelector('.empty-sub').textContent = '在下方向 AI 提问，开始围绕视频内容进行讨论';
    empty.style.display = '';
  }
  box.scrollTop = box.scrollHeight;
  renderUsageBar(c, msgs);
  updateEstBar();
}

function appendMsgEl(box, m, animate = true) {
  const div = document.createElement('div');
  div.className = 'msg ' + (m.role === 'user' ? 'user' : 'assistant') + (m.error ? ' error' : '');
  const body = m.error
    ? `<div class="bubble">⚠ ${esc(m.content)}</div>`
    : `<div class="bubble">${
        m.role === 'user' ? esc(m.content) : markdown(m.content || '')
      }${m.reasoning ? `<details class="reasoning"><summary>思考过程</summary>${esc(m.reasoning)}</details>` : ''}
      ${m.aborted ? '<div class="meta"><span style="color:#b26e1a">⚠ 已手动停止</span></div>' : ''}
      ${m.usage ? `<div class="meta"><span>输入 ${fmtTokens(m.usage.prompt_tokens ?? m.usage.input_tokens ?? 0)}</span><span>输出 ${fmtTokens(m.usage.completion_tokens ?? m.usage.output_tokens ?? 0)}</span><span>合计 ${fmtTokens(m.usage.total_tokens ?? 0)}</span></div>` : ''}
      </div>`;
  div.innerHTML = `<div class="avatar">${m.role === 'user' ? '🧑' : '🤖'}</div>` + body;
  if (!animate) div.style.animation = 'none';
  box.appendChild(div);
  return div;
}

function renderUsageBar(c, msgs) {
  const bar = $('#usageBar');
  if (!msgs.length) { bar.classList.add('hidden'); return; }
  let inT = 0, outT = 0;
  for (const m of msgs) {
    if (m.usage) {
      inT += m.usage.prompt_tokens ?? m.usage.input_tokens ?? 0;
      outT += m.usage.completion_tokens ?? m.usage.output_tokens ?? 0;
    } else if (m.est) {
      inT += (m.est.input || 0);
      outT += (m.est.output || 0);
    }
  }
  let text = `累计消耗：输入 ${fmtTokens(inT)} · 输出 ${fmtTokens(outT)} · 合计 ${fmtTokens(inT + outT)} Token`;
  const pr = effPrice(c.model);
  if (pr.in != null || pr.out != null) {
    const cost = (inT / 1000) * (pr.in || 0) + (outT / 1000) * (pr.out || 0);
    text += ` ≈ ¥${cost.toFixed(4)}（单价 ¥${(pr.in || 0).toFixed(3)}/${(pr.out || 0).toFixed(3)} 每千Token）`;
  }
  bar.classList.remove('hidden');
  $('#usageBarText').textContent = text;
}

/* ---------------- 消息输入预估 ---------------- */
/* 计算「下一次请求」实际发送的输入 Token 估算：
   - 历史文本：state.messages（当前对话已加载的全部消息）
   - 新增文本
   - 附带视频：attach 开启时，历史中每条带 video 的用户消息也会重新附带视频，再加新增一条 */
function buildInputEstimate() {
  const c = activeConv();
  if (!c) return null;
  const p = activeProject();
  const text = $('#chatInput').value;
  const attach = !!(p && p.videoRef && p.videoRef.url && $('#chatAttachVideo').checked);
  const history = Array.isArray(state.messages) ? state.messages : [];
  const valid = !!(p && p.videoRef && p.videoRef.url && !isExpired(p));
  const histText = messagesTextTokens(history.filter(m => typeof m.content === 'string'));
  const textTokens = histText + estimateTextTokens(text);
  let videoTokens = 0, frames = 0, videoCount = 0;
  if (attach && valid) {
    for (const m of history) if (m.role === 'user' && m.video && m.video.url) videoCount += 1;
    videoCount += 1; // 本次新消息
    const est = estimateVideoTokens(modelProfile(c.model || (p && p.model)), (p.videoInfo && p.videoInfo.duration) || 0, (p.videoInfo && p.videoInfo.width) || 0, (p.videoInfo && p.videoInfo.height) || 0, c.fps || (p && p.fps) || 2);
    videoTokens = est.videoTokens * videoCount;
    frames = est.frames * videoCount;
  }
  return { input: textTokens + videoTokens, videoTokens, frames, textTokens, histText, attach, videoCount, valid };
}

function updateEstBar() {
  const est = buildInputEstimate();
  if (!est) { $('#estBarText').textContent = '预计输入 Token：-'; $('#estBarDetail').textContent = ''; $('#estBarModel').textContent = ''; return; }
  const c = activeConv();
  const p = activeProject();
  /* 当前模型指引（一行） */
  const g = modelGuide(c && c.model || (p && p.model));
  $('#estBarModel').textContent = (c && c.model) ? `${c.model} · ${(g || {}).brief || ''}` : '';
  const extra = (c && p && c.attachVideo && !est.valid) ? '（视频链接已过期或不可用）' : '';
  $('#estBarText').textContent = `预计本次输入约 ${fmtTokens(est.input)} Token（历史 ${fmtTokens(est.histText)} + 新消息 ${fmtTokens(est.textTokens - est.histText)}${est.videoTokens ? ` + 视频 ${est.videoCount} 段 ${fmtTokens(est.videoTokens)}` : ''}）${extra}`;
  const pr = effPrice(c.model || (p && p.model));
  if (pr.in != null) {
    $('#estBarDetail').textContent = '输入费用 ≈ ¥' + ((est.input / 1000) * pr.in).toFixed(4);
  } else {
    $('#estBarDetail').textContent = '';
  }
}

/* =========================================================================
 * 选择 / 切换
 * ========================================================================= */
async function selectProject(pid) {
  state.activeProjectId = pid;
  const convs = convsOf(pid);
  state.activeConvId = convs.length ? convs[convs.length - 1].id : null;
  try {
    await loadMessagesForActive();
  } catch (e) {
    console.error('selectProject 加载消息失败', e);
    state.messages = [];
  }
  renderAll();
}

async function selectConv(cid) {
  state.activeConvId = cid;
  try {
    await loadMessagesForActive();
  } catch (e) {
    console.error('selectConv 加载消息失败', e);
    state.messages = [];
  }
  renderAll();
}

async function loadMessagesForActive() {
  if (!state.activeConvId) { state.messages = []; return; }
  state.messages = await DB.byIndex('messages', 'convId', state.activeConvId);
}

function renderAll() {
  renderServerBadge();
  renderProjects();
  renderVideoCard();
  renderConvList();
  renderChatHead();
  renderChat();
}

/* =========================================================================
 * 新建项目（向导）
 * ========================================================================= */
const wiz = {
  file: null,        // File
  meta: null,        // {name,size,ext,duration,width,height,fps}
  thumb: null,
  url: null,         // {url, contentLength, contentType, warning}
  uploadResult: null,// {url,...}
  previewUrl: null,  // 预览视频的 blob URL（释放用）
  step: 1,
  busy: false,
};

function lastUsedModel() {
  try {
    const m = localStorage.getItem('vdu.lastModel');
    if (m) return m;
  } catch (e) { /* ignore */ }
  return 'qwen3-omni-flash';
}

/* 向导「理解」步的默认模型：纯文本模型不能理解视频，回退到全模态默认 */
function lastUsedModelForWizard() {
  const m = lastUsedModel();
  return modelIsText(m) ? 'qwen3-omni-flash' : m;
}

function releaseWizardPreview() {
  if (wiz.previewUrl) { try { URL.revokeObjectURL(wiz.previewUrl); } catch (e) { /* ignore */ } wiz.previewUrl = null; }
  const pv = $('#videoPreview');
  if (pv) {
    try { pv.pause(); } catch (e) { /* ignore */ }
    pv.removeAttribute('src');
    try { pv.load(); } catch (e) { /* ignore */ }
  }
}

/* ---------------- 上传任务断点记录（刷新/关页恢复用） ----------------
   转存阶段由服务端后台线程执行，浏览器刷新不会中断它；把任务参数存入
   localStorage，刷新后 init 时查询服务端状态并恢复向导，避免"白传一遍"。 */
function savePendingUpload(patch) {
  try {
    const cur = JSON.parse(localStorage.getItem('vdu.pendingUpload') || 'null') || {};
    const next = { ...cur, ...patch, ts: Date.now() };
    localStorage.setItem('vdu.pendingUpload', JSON.stringify(next));
  } catch (e) { /* ignore */ }
}
function clearPendingUpload() {
  try { localStorage.removeItem('vdu.pendingUpload'); } catch (e) { /* ignore */ }
}
function readPendingUpload() {
  try { return JSON.parse(localStorage.getItem('vdu.pendingUpload') || 'null'); } catch (e) { return null; }
}

function openWizard() {
  resetWizard();
  $('#modalWizard').classList.remove('hidden');
}

function resetWizard() {
  releaseWizardPreview();
  wiz.file = null; wiz.meta = null; wiz.thumb = null; wiz.url = null; wiz.uploadResult = null;
  wiz.step = 1; wiz.busy = false;
  $('#videoFileInput').value = '';
  $('#videoUrlInput').value = '';
  $('#uploadPanel').classList.add('hidden');
  $('#videoPreviewCard').classList.add('hidden');
  $('#wizProjectName').value = '';
  $('#wizPrev').disabled = true;
  $('#wizNext').classList.remove('hidden');
  $('#wizStart').classList.add('hidden');
  setWizStep(1);
  fillModelSelect($('#wizModelSelect'), lastUsedModelForWizard(), true);
  updateWizModelInfo();
}

function setWizStep(step) {
  wiz.step = step;
  $$('.wstep').forEach((el) => el.classList.toggle('active', Number(el.dataset.step) === step));
  $$('.wstep-pane').forEach((el) => el.classList.toggle('active', Number(el.dataset.pane) === step));
  $('#wizStepInfo').textContent = '第 ' + step + ' / 3 步';
  $('#wizPrev').disabled = step === 1 || wiz.busy;
  $('#wizNext').classList.toggle('hidden', step >= 3 || wiz.busy);
  $('#wizStart').classList.toggle('hidden', step !== 3 || wiz.busy);
  if (step === 3) renderEstimate();
  if (step === 2) updateWizModelInfo();
}

function currentVideoSpec() {
  if (wiz.meta) return wiz.meta;   // 本地文件，或刷新后恢复的上传任务（meta 已恢复）
  if (wiz.url) return { name: null, duration: null, width: null, height: null, size: wiz.url.contentLength, fps: null, urlInfo: wiz.url };
  return null;
}

function updateWizModelInfo() {
  const model = $('#wizModelSelect').value;
  $('#wizModelInfo').innerHTML = buildModelInfoHtml(model, 'wizard');
}

function updateEstimateUI() {
  const model = $('#wizModelSelect').value;
  const prof = modelProfile(model);
  const fps = Number($('#wizFps').value);
  const spec = currentVideoSpec();
  const duration = spec && spec.duration ? spec.duration : null;
  const size = spec ? (spec.size || 0) : 0;

  const est = estimateVideoTokens(prof, duration || 0, spec && spec.width, spec && spec.height, fps, spec && spec.fps);
  const promptText = $('#wizPrompt').value;
  const textTokens = estimateTextTokens(promptText);
  const total = est.videoTokens + textTokens;

  $('#estimateCards').innerHTML = `
    <div class="est-card"><div class="ec-k">抽帧数量</div><div class="ec-v">${est.frames}</div><div class="ec-s">约每 ${(1 / fps).toFixed(1)} 秒 1 帧（fps=${fps}）</div></div>
    <div class="est-card"><div class="ec-k">单帧 Token</div><div class="ec-v">${est.perFrame}</div><div class="ec-s">缩放后 ${est.frameW}×${est.frameH}</div></div>
    <div class="est-card"><div class="ec-k">视觉 Token</div><div class="ec-v hl">${fmtTokens(est.videoTokens)}</div><div class="ec-s">含首尾标记 2</div></div>
    <div class="est-card"><div class="ec-k">本次总输入</div><div class="ec-v hl">${fmtTokens(total)}</div><div class="ec-s">文本 ${fmtTokens(textTokens)} + 视觉 ${fmtTokens(est.videoTokens)}</div></div>`;

  const rows = [];
  rows.push(['模型', model]);
  rows.push(['时长', duration != null ? fmtDuration(duration) : '未探测（URL 模式由百炼读取）']);
  if (spec && spec.width) rows.push(['分辨率', spec.width + '×' + spec.height + (spec.fps ? ' @' + spec.fps.toFixed(1) + 'fps' : '')]);
  if (size) rows.push(['文件大小', fmtBytes(size)]);
  rows.push(['抽帧频率', fps + ' fps']);
  const pr = effPrice(model);
  if (pr.in != null) {
    rows.push(['输入费（理解视频＋提示词）', '≈ ¥' + ((total / 1000) * pr.in).toFixed(4) + '（单价 ¥' + pr.in.toFixed(3) + '/千Token）']);
  }
  $('#estimateTable').innerHTML = `
    <table><thead><tr><th>项目</th><th style="width:60%">值</th></tr></thead>
    <tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`).join('')}</tbody></table>`;

  /* 限制校验 */
  const warns = [];
  if (duration != null) {
    if (duration < 2) warns.push(['视频时长不足 2 秒，模型不支持', true]);
    else if (duration > prof.maxDuration) warns.push([`视频时长 ${fmtDuration(duration)} 超过该模型上限 ${fmtDuration(prof.maxDuration)}（模型：${prof.label}），建议改用 qwen3.8-max / qwen3-vl-plus 系列，或截取片段`, true]);
  }
  if (size && size > prof.maxSizeMB * 1024 * 1024) {
    warns.push([`文件大小 ${fmtBytes(size)} 超过该模型上限 ${prof.maxSizeMB >= 1024 ? (prof.maxSizeMB / 1024) + 'GB' : prof.maxSizeMB + 'MB'}，建议压缩或更换模型`, true]);
  }
  if (duration != null && est.frames >= 2000) warns.push(['帧数已达 2000 帧上限（约 ' + fmtDuration(2000 / fps) + '），模型将均匀降采样，长视频建议降低 fps 以保留更多画面细节', false]);
  if (est.frames > 1500) warns.push(['帧数较多（' + est.frames + ' 帧），理解耗时与费用较高；静态内容可降低 fps', false]);
  if (!wiz.file && !wiz.url && !(wiz.uploadResult && wiz.uploadResult.url)) warns.push(['尚未选择视频', true]);
  if (wiz.file && !(wiz.uploadResult && wiz.uploadResult.url)) warns.push(['本地视频将在点击「开始理解」时上传到百炼临时存储（视文件大小约需 10~60 秒），临时链接 48 小时有效', false]);
  if (wiz.uploadResult && wiz.uploadResult.url) warns.push(['已上传，临时链接有效期至 ' + fmtDate(nowMs() + 48 * 3600 * 1000) + '（48 小时）；过期后对话中附带视频需重新上传', false]);
  if (wiz.url && wiz.url.warning) warns.push(['URL 校验：' + wiz.url.warning, false]);
  if (wiz.url && (duration == null)) warns.push(['公网 URL 视频的时长 / 分辨率未知，上述估算按默认值计算，可能偏差较大；实际消耗以每次 API 返回的 usage 为准', false]);
  if (pr.in != null || pr.out != null) {
    warns.push(['⚠ 以上仅为「输入（理解视频＋提示词）」费用；「输出（模型回答）」消耗无法估算，受视频内容与回答篇幅影响较大。实际总费用以每次 API 返回的 usage 为准（无免费额度时按实时计费）。', false]);
  }
  if (pr.in != null && duration != null && duration > 180) {
    warns.push(['📌 参考：一部约 10 分钟 1080p 纪录片，用全模态旗舰 + 默认详细分镜提示词，输入约 ¥0.4，加上输出后单轮实际常达 ¥2~3（以输出为主、难预估）。长视频建议：降低抽帧 fps、精简提示词，或改用更便宜的视觉模型（如 qwen3-vl-plus / qwen-vl-plus 系列）。', false]);
  }
  $('#warnList').innerHTML = warns.map(([t, isErr]) => `<div class="warn-item${isErr ? ' err' : ''}">${t}</div>`).join('');
  /* 压缩入口：仅本地文件、未上传、且检测到 ffmpeg 时可用 */
  const canCompress = !!wiz.file && !(wiz.uploadResult && wiz.uploadResult.url);
  const cmpRow = $('#wizCompressRow');
  if (cmpRow) {
    cmpRow.classList.toggle('hidden', !canCompress);
    const cmpBtn = $('#btnWizCompress');
    if (cmpBtn) {
      cmpBtn.disabled = !state.serverFfmpeg;
      cmpBtn.title = state.serverFfmpeg ? '先压缩减小体积，以通过百炼 1GB 上传上限' : '未检测到 ffmpeg，无法压缩';
    }
  }
  $('#wizProjectName').value = $('#wizProjectName').value || (wiz.file ? wiz.file.name.replace(/\.[^.]+$/, '') : (wiz.url ? 'URL 视频' : ''));
}

function renderEstimate() { updateEstimateUI(); }

async function startUnderstanding() {
  if (wiz.busy) return;
  const model = $('#wizModelSelect').value;
  if (modelIsText(model)) { toast('「' + model + '」是纯文本模型，不支持视频理解，请从「视觉 / 全模态」分组选择模型', 'err'); return; }
  const fps = Number($('#wizFps').value);
  const prompt = $('#wizPrompt').value.trim() || DEFAULT_PROMPT;
  const name = ($('#wizProjectName').value || ('视频项目 ' + new Date().toLocaleString())).trim();

  wiz.busy = true;
  setWizStep(3);
  let project = null, conv = null, userMsg = null;
  let reopenWizard = false;
  try {
    /* 本地文件：先上传（用最终选定的模型），URL 模式无此步 —— 必须在上传完成后才能引用视频地址 */
    if (wiz.file && !(wiz.uploadResult && wiz.uploadResult.url)) {
      const okUpload = await uploadForWizard();
      if (!okUpload) return;
    }
    const videoRef = wiz.uploadResult && wiz.uploadResult.url
      ? {
          type: 'oss', url: wiz.uploadResult.url,
          fileName: (wiz.file ? wiz.file.name : (wiz.meta && wiz.meta.name)) || 'video',
          size: (wiz.file ? wiz.file.size : (wiz.meta && wiz.meta.size)) || wiz.uploadResult.fileSize || null,
          expireAt: nowMs() + 48 * 3600 * 1000,
        }
      : { type: 'url', url: wiz.url.url, size: wiz.url.contentLength || null, expireAt: null };

    project = {
      id: uuid(), name, thumb: wiz.thumb, videoRef,
      /* 支持「刷新后恢复」：wiz.file 可能为 null，但 wiz.meta 里保留了视频信息 */
      videoInfo: (wiz.file || wiz.meta) ? {
        duration: (wiz.meta || {}).duration, width: (wiz.meta || {}).width,
        height: (wiz.meta || {}).height, fps: (wiz.meta || {}).fps, ext: (wiz.meta || {}).ext,
      } : { ext: 'URL' },
      model, fps, prompt,
      createdAt: nowMs(), updatedAt: nowMs(),
    };
    conv = {
      id: uuid(), projectId: project.id, name: '视频理解', model, fps, prompt,
      attachVideo: false, createdAt: nowMs(), updatedAt: nowMs(),
    };
    userMsg = {
      id: uuid(), convId: conv.id, role: 'user',
      content: buildUserText(prompt),
      video: { url: videoRef.url, fps },   // 仅首轮真实视频
      ts: nowMs(), est: null,
    };
    await DB.put('projects', project);
    await DB.put('conversations', conv);
    await DB.put('messages', userMsg);
    state.projects.push(project);
    state.conversations.push(conv);
    state.activeProjectId = project.id;
    state.activeConvId = conv.id;
    $('#modalWizard').classList.add('hidden');
    await loadMessagesForActive();
    renderAll();
    const res = await firstRoundTell(conv, userMsg); // 发起理解（首轮附带视频文件）
    try { localStorage.setItem('vdu.lastModel', model); } catch (e) { /* ignore */ }
    clearPendingUpload();   // 项目已创建成功，断点不再需要
    toast(res && res.aborted ? '视频理解已停止（部分内容已保存）' : '视频理解完成', 'ok');
  } catch (e) {
    console.error(e);
    /* 清理半成品（仅清理已创建的部分；删除失败不阻断恢复流程） */
    try {
      if (project) { await DB.del('projects', project.id); state.projects = state.projects.filter(p => p.id !== project.id); }
      if (conv) { await DB.del('conversations', conv.id); state.conversations = state.conversations.filter(c => c.id !== conv.id); }
      if (userMsg) { await DB.del('messages', userMsg.id); state.messages = state.messages.filter(m => m.id !== userMsg.id); }
    } catch (e2) { console.warn('[vdu] 清理半成品失败', e2); }
    reopenWizard = !!project;
    state.activeProjectId = null; state.activeConvId = null;
    renderAll();
    toast('开始理解失败：' + (e && e.message ? e.message : e), 'err');
  } finally {
    wiz.busy = false;
    /* 失败时恢复向导并保留已上传结果：点击「开始理解」可立即重试，无需重新上传大文件 */
    if (reopenWizard) {
      $('#modalWizard').classList.remove('hidden');
      setWizStep(3);
      renderEstimate();
    }
  }
}

/* ---------------- 消息构建 ---------------- */
function buildUserText(text) { return String(text || ''); }

function contentForUser(conv, project, text, attachVideo, onlyVideoRef) {
  const parts = [];
  const ref = project && project.videoRef;
  if (attachVideo && ref && ref.url) {
    if (ref.type === 'oss' && ref.expireAt && nowMs() > ref.expireAt) {
      throw { expired: true, message: '视频临时链接已过期（48 小时），请在项目里点击「重新理解」重新上传后再附带视频。' };
    }
    parts.push({ type: 'video_url', video_url: { url: ref.url }, fps: conv.fps || project.fps || 2 });
  }
  parts.push({ type: 'text', text });
  return parts;
}

/* 组装发给 API 的 messages（历史 + 新消息） */
function buildApiMessages(conv, project, historyMsgs, newText, attachVideo) {
  const out = [];
  for (const m of historyMsgs) {
    if (m.role === 'user') {
      if (m.video) {
        const parts = [];
        if (attachVideo && !isExpired(project)) {
          parts.push({ type: 'video_url', video_url: { url: m.video.url || project.videoRef.url }, fps: (conv.fps || project.fps || 2) });
        }
        parts.push({ type: 'text', text: m.content });
        out.push({ role: 'user', content: parts });
      } else {
        out.push({ role: 'user', content: m.content });
      }
    } else if (m.role === 'assistant' && !m.error) {
      out.push({ role: 'assistant', content: m.content });
    }
  }
  if (newText != null) {
    try {
      out.push({ role: 'user', content: contentForUser(conv, project, newText, attachVideo) });
    } catch (e) {
      if (e && e.expired) { toast(e.message, 'err'); return null; }
      throw e;
    }
  }
  return out;
}

function isExpired(project) {
  return project.videoRef && project.videoRef.type === 'oss' &&
    project.videoRef.expireAt && nowMs() > project.videoRef.expireAt;
}

/* ---------------- 流式对话 ---------------- */
let abortCtl = null;   // 当前流式请求的 AbortController（「停止」按钮使用）

/* 流式结束后重写气泡：显示最终内容 + 思考过程 + usage/停止标记
   （流式过程中只显示正文，meta 信息在结束时补齐） */
function finalizeBubble(bubble, acc, reasoning, usage, aborted) {
  if (!bubble || (!acc && !reasoning)) return;
  let meta = '';
  if (aborted) meta += '<div class="meta"><span style="color:#b26e1a">⚠ 已手动停止</span></div>';
  if (usage) {
    meta += `<div class="meta"><span>输入 ${fmtTokens(usage.prompt_tokens ?? usage.input_tokens ?? 0)}</span><span>输出 ${fmtTokens(usage.completion_tokens ?? usage.output_tokens ?? 0)}</span><span>合计 ${fmtTokens(usage.total_tokens ?? 0)}</span></div>`;
  }
  bubble.innerHTML = markdown(acc) +
    (reasoning ? `<details class="reasoning"><summary>思考过程</summary>${esc(reasoning)}</details>` : '') + meta;
}

async function streamTell(conv, msgs, appendMsg, signal) {
  const project = state.projects.find(p => p.id === conv.projectId);
  const contentEl = appendMsg; // 已插入的 assistant 气泡元素
  const bubble = contentEl ? contentEl.querySelector('.bubble') : null;
  const payload = {
    model: conv.model,
    messages: msgs,
    stream: true,
    stream_options: { include_usage: true },
  };
  let acc = '', reasoning = '', usage = null, finished = false;
  try {
    const res = await Api.chatStream(payload, (d) => {
      if (d.reasoning) { reasoning += d.reasoning; }
      if (d.content) { acc += d.content; }
      if (d.finish) { finished = true; }
      if (bubble) {
        bubble.innerHTML = markdown(acc) + (reasoning ? `<details class="reasoning" open><summary>思考过程</summary>${esc(reasoning)}</details>` : '') + (acc || reasoning ? '' : '<span class="cursor"></span>');
        $('#chatMessages').scrollTop = $('#chatMessages').scrollHeight;
      }
    }, signal);
    usage = res.usage;
  } catch (e) {
    /* 用户手动停止：不是错误，把已收到的内容作为本次结果返回 */
    if (e && (e.name === 'AbortError' || (signal && signal.aborted))) {
      finalizeBubble(bubble, acc, reasoning, usage, true);
      return { content: acc, reasoning, usage, aborted: true };
    }
    if (bubble) {
      bubble.innerHTML = markdown(acc) + (reasoning ? `<details class="reasoning"><summary>思考过程</summary>${esc(reasoning)}</details>` : '') + `<div class="meta" style="color:#b33538">⚠ 错误：${esc(e.message)}</div>`;
      bubble.parentElement.classList.add('error');
    }
    throw e;
  }
  if (!finished && !acc && !reasoning) {
    bubble && (bubble.innerHTML = '<span style="color:#b33538">⚠ 无输出（可能超出上下文或触发限流）</span>');
  } else {
    finalizeBubble(bubble, acc, reasoning, usage, false);
  }
  return { content: acc, reasoning, usage };
}

function estimateUsage(conv, project, historyMsgs, newText, attachVideo, outputTokens) {
  const hist = Array.isArray(historyMsgs) ? historyMsgs : [];
  /* 提示词已包含在首条用户消息（历史）中，不再单独累加，避免重复计数 */
  const textTokens = messagesTextTokens(hist.filter(m => typeof m.content === 'string')) +
    estimateTextTokens(newText || '');
  let videoTokens = 0, videoCount = 0;
  if (attachVideo && project && project.videoRef && project.videoRef.url && !isExpired(project)) {
    const est = estimateVideoTokens(modelProfile(conv.model), (project.videoInfo && project.videoInfo.duration) || 0, (project.videoInfo && project.videoInfo.width) || 0, (project.videoInfo && project.videoInfo.height) || 0, conv.fps || project.fps || 2);
    videoCount = hist.filter(m => m.role === 'user' && m.video && m.video.url).length + 1;
    videoTokens = est.videoTokens * videoCount;
  }
  return { input: videoTokens + textTokens, output: outputTokens || 0, videoTokens, videoCount };
}

async function sendMessage(text) {
  const conv = activeConv();
  if (!conv || state.streaming) return;
  const project = activeProject();
  text = text.trim();
  if (!text) return;
  state.streaming = true;
  abortCtl = new AbortController();
  setSendBtn(true);

  const history = msgsOf(conv.id);
  const attach = $('#chatAttachVideo').checked;
  conv.attachVideo = attach;
  await DB.put('conversations', conv);

  // 本地插入 user 消息（保存）
  const userMsg = { id: uuid(), convId: conv.id, role: 'user', content: text, video: attach ? { url: project.videoRef.url, fps: conv.fps || project.fps || 2 } : null, ts: nowMs(), est: null };
  await DB.put('messages', userMsg);
  state.messages.push(userMsg);

  const apiMsgs = buildApiMessages(conv, project, history, text, attach);
  if (!apiMsgs) { state.streaming = false; setSendBtn(false); return; }

  const box = $('#chatMessages');
  const asstEl = appendMsgEl(box, { role: 'assistant', content: '', ts: nowMs() });
  asstEl.querySelector('.bubble').innerHTML = '<div class="typing-dots"><i></i><i></i><i></i></div>';
  box.scrollTop = box.scrollHeight;

  try {
    const { content, reasoning, usage, aborted } = await streamTell(conv, apiMsgs, asstEl, abortCtl.signal);
    const estTokens = estimateUsage(conv, project, history, text, attach, Math.round((content || '').length * 0.6));
    const asstMsg = { id: uuid(), convId: conv.id, role: 'assistant', content, reasoning, usage: usage || { prompt_tokens: estTokens.input, completion_tokens: estTokens.output, total_tokens: estTokens.input + estTokens.output }, est: usage ? null : estTokens, aborted: !!aborted, ts: nowMs() };
    await DB.put('messages', asstMsg);
    state.messages.push(asstMsg);
    conv.updatedAt = nowMs();
    await DB.put('conversations', conv);
    await DB.put('projects', project);
    renderConvList();
    renderUsageBar(conv, msgsOf(conv.id));
  } catch (e) {
    // 错误消息不保存为正式消息（本地 user 消息保留，便于重试）
    toast('请求失败：' + e.message, 'err');
  } finally {
    state.streaming = false;
    abortCtl = null;
    setSendBtn(false);
    $('#chatInput').value = '';
    $('#chatInput').style.height = 'auto';
    updateEstBar();
    $('#chatInput').focus();
  }
}

/* 发送/停止按钮状态切换 */
function setSendBtn(streaming) {
  const b = $('#btnSend');
  b.textContent = streaming ? '■ 停止' : '发送';
  b.classList.toggle('btn-stop', streaming);
  b.title = streaming ? '停止生成（已生成的内容会保留）' : '发送消息';
}

/* 首轮理解（向导调用）：直接现有 conv + first userMsg */
async function firstRoundTell(conv, userMsg) {
  const project = state.projects.find(p => p.id === conv.projectId);
  const box = $('#chatMessages');
  const asstEl = appendMsgEl(box, { role: 'assistant', content: '', ts: nowMs() });
  asstEl.querySelector('.bubble').innerHTML = '<div class="hint">正在识别并理解视频（模型处理中，视频越长所需时间越久，通常 1~5 分钟，首字出现后即开始流式输出）…</div><div class="typing-dots"><i></i><i></i><i></i></div>';
  const agentMsg = [{ role: 'user', content: [{ type: 'video_url', video_url: { url: userMsg.video.url }, fps: conv.fps } , { type: 'text', text: userMsg.content }] }];
  const estTokens = estimateUsage(conv, project, [], userMsg.content, true, 0);
  /* 与普通消息一致：进入流式状态，防止理解期间重复发送；「停止」按钮可中断 */
  state.streaming = true;
  abortCtl = new AbortController();
  setSendBtn(true);
  try {
    const { content, reasoning, usage, aborted } = await streamTell(conv, agentMsg, asstEl, abortCtl.signal);
    const asstMsg = {
      id: uuid(), convId: conv.id, role: 'assistant', content, reasoning,
      usage: usage || { prompt_tokens: estTokens.input, completion_tokens: estTokens.output, total_tokens: estTokens.input + estTokens.output },
      est: usage ? null : estTokens, aborted: !!aborted, ts: nowMs(),
    };
    await DB.put('messages', asstMsg);
    state.messages.push(asstMsg);
    conv.updatedAt = nowMs();
    await DB.put('conversations', conv);
    project.updatedAt = nowMs();
    await DB.put('projects', project);
    renderConvList();
    renderUsageBar(conv, msgsOf(conv.id));
    renderChatHead();          // 强制刷新输入区状态（防止任何残留导致输入框不可见）
    $('#chatInput').focus();
    return { aborted: !!aborted, content };
  } catch (e) {
    /* 不在此处 toast：由调用方统一提示，避免重复弹窗 */
    console.error('[vdu] 首轮理解失败', e);
    throw e;
  } finally {
    state.streaming = false;
    abortCtl = null;
    setSendBtn(false);
  }
}

/* =========================================================================
 * 分支对话
 * ========================================================================= */
async function newBranchConv() {
  const p = activeProject();
  if (!p) { toast('请先选择项目'); return; }
  const id = uuid();
  const all = convsOf(p.id);
  const n = all.length + 1;
  const conv = {
    id, projectId: p.id, name: '分支对话 ' + n, model: p.model, fps: p.fps,
    prompt: p.prompt, attachVideo: false, createdAt: nowMs(), updatedAt: nowMs(),
  };
  /* 继承「视频理解」阶段的问答作为分支对话的起点上下文：
     分支对话打开即可看到理解分析，模型追问时自然知道视频内容（不额外计费） */
  const base = all.find(c => (c.name || '').indexOf('视频理解') === 0) || all[0];
  let inherited = [];
  if (base) {
    /* 基础对话可能不是当前对话：必须从数据库读消息（state.messages 仅含当前对话） */
    const baseMsgs = (await DB.byIndex('messages', 'convId', base.id).catch(() => [])) || [];
    const firstUser = baseMsgs.find(m => m.role === 'user');
    const lastAsst = baseMsgs.filter(m => m.role === 'assistant' && !m.error).pop();
    if (firstUser && lastAsst) {
      const ctxUser = { id: uuid(), convId: id, role: 'user', content: firstUser.content, video: null, ts: nowMs(), est: null, inherited: true };
      const ctxAsst = { id: uuid(), convId: id, role: 'assistant', content: lastAsst.content, reasoning: null, ts: nowMs(), est: null, inherited: true };
      await DB.put('messages', ctxUser);
      await DB.put('messages', ctxAsst);
      inherited = [ctxUser, ctxAsst];
    }
  }
  await DB.put('conversations', conv);
  state.conversations.push(conv);
  state.activeConvId = id;
  state.messages = inherited;
  renderAll();
  toast(inherited.length ? '已创建分支对话，并继承视频理解分析作为上下文' : '已创建分支对话', 'ok');
  $('#chatInput').focus();
}

function renameActiveConv() {
  const c = activeConv();
  if (!c) return;
  const name = prompt('对话名称：', c.name);
  if (name == null) return;
  c.name = name.trim() || c.name;
  DB.put('conversations', c);
  renderConvList(); renderChatHead();
}

async function renameActiveProject() {
  const p = activeProject();
  if (!p) return;
  const name = prompt('项目名称：', p.name);
  if (name == null) return;
  const nm = name.trim();
  if (!nm || nm === p.name) return;
  p.name = nm;
  await DB.put('projects', p);
  renderAll();
  toast('项目已重命名', 'ok');
}

/* 重新上传视频文件：替换项目的临时链接，并把该项目所有对话消息里的旧链接一并替换，
   「每轮附带视频」与「重新理解」随即恢复可用 */
async function reuploadProjectVideo(file) {
  const project = activeProject();
  if (!project || !file) return;
  const prevFoot = $('#convFoot').textContent;
  try {
    $('#convFoot').textContent = '正在上传「' + file.name + '」到本地服务… 0%';
    const r = await Api.upload(file, project.model, (pct) => {
      $('#convFoot').textContent = '正在上传到本地服务… ' + Math.round(pct * 100) + '%';
    }, ({ phase, progress, waited }) => {
      const mm = String(Math.floor(waited / 60)).padStart(2, '0');
      const ss = String(waited % 60).padStart(2, '0');
      if (phase === 'done') {
        $('#convFoot').textContent = '转存完成 ✓ 新临时链接 48 小时有效';
      } else if (phase === 'uploading' || progress > 0) {
        $('#convFoot').textContent = '正在转存至阿里云临时存储… ' + Math.round(Math.max(2, progress * 100)) + '% · 已等待 ' + mm + ':' + ss;
      } else {
        $('#convFoot').textContent = '正在准备转存（获取凭证）… 已等待 ' + mm + ':' + ss;
      }
    });
    project.videoRef = {
      type: 'oss', url: r.url,
      fileName: (project.videoRef && project.videoRef.fileName) || file.name,
      size: r.fileSize || file.size,
      expireAt: nowMs() + 48 * 3600 * 1000,
    };
    await DB.put('projects', project);
    for (const c of convsOf(project.id)) {
      const msgs = (await DB.byIndex('messages', 'convId', c.id).catch(() => [])) || [];
      for (const m of msgs) {
        if (m.video && m.video.url && m.video.url !== r.url) { m.video.url = r.url; await DB.put('messages', m); }
      }
    }
    renderAll();
    toast('已重新上传，新临时链接 48 小时有效', 'ok');
  } catch (e) {
    console.error('[vdu] 重新上传失败', e);
    $('#convFoot').textContent = prevFoot;
    toast('重新上传失败：' + (e && e.message ? e.message : e), 'err');
    renderVideoCard();
  }
}

function deleteConvConfirm() {
  const c = activeConv();
  if (!c) return;
  confirmDialog('删除对话', `确定删除对话「${c.name}」及其全部消息？`, async () => {
    for (const m of msgsOf(c.id)) await DB.del('messages', m.id);
    await DB.del('conversations', c.id);
    state.conversations = state.conversations.filter(x => x.id !== c.id);
    state.messages = [];
    const convs = convsOf(c.projectId);
    state.activeConvId = convs.length ? convs[convs.length - 1].id : null;
    await loadMessagesForActive();
    renderAll();
    toast('已删除对话');
  });
}

function deleteProjectConfirm() {
  const p = activeProject();
  if (!p) return;
  confirmDialog('删除项目', `确定删除项目「${p.name}」及其全部 ${convsOf(p.id).length} 个分支对话？`, async () => {
    for (const c of convsOf(p.id)) {
      const msgs = (await DB.byIndex('messages', 'convId', c.id).catch(() => [])) || [];
      for (const m of msgs) await DB.del('messages', m.id);
      await DB.del('conversations', c.id);
    }
    await DB.del('projects', p.id);
    state.projects = state.projects.filter(x => x.id !== p.id);
    state.conversations = state.conversations.filter(x => x.projectId !== p.id);
    state.activeProjectId = null; state.activeConvId = null; state.messages = [];
    renderAll();
    toast('已删除项目');
  });
}

/* =========================================================================
 * 确认对话框
 * ========================================================================= */
let confirmCb = null;
function confirmDialog(title, text, cb) {
  confirmCb = cb;
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#modalConfirm').classList.remove('hidden');
}

/* =========================================================================
 * 设置
 * ========================================================================= */
async function openSettings() {
  try {
    const cfg = await Api.config();
    $('#setApiKey').value = cfg.hasKey ? 'sk-****************' : '';
    $('#setBaseUrl').value = cfg.baseUrl || 'https://dashscope.aliyuncs.com';
    $('#setPriceIn').value = cfg.priceIn != null ? cfg.priceIn : '';
    $('#setPriceOut').value = cfg.priceOut != null ? cfg.priceOut : '';
    $('#setModelSel').innerHTML = '';
    renderModelManageSel();
    $('#fetchModelStatus').textContent = '';
    $('#modalSettings').classList.remove('hidden');
  } catch (e) {
    toast('无法读取设置（本地服务未连接？）', 'err');
  }
}

async function saveSettings() {
  const apiKey = $('#setApiKey').value.trim();
  const isPlaceholder = apiKey === 'sk-****************';
  const cfg = {
    apiKey: isPlaceholder ? undefined : apiKey,
    baseUrl: $('#setBaseUrl').value.trim(),
    priceIn: $('#setPriceIn').value === '' ? null : Number($('#setPriceIn').value),
    priceOut: $('#setPriceOut').value === '' ? null : Number($('#setPriceOut').value),
  };
  try {
    const r = await Api.saveConfig(cfg);
    if (r.error) { toast('保存失败：' + (r.error || '未知错误'), 'err'); return; }
    state.settings.hasKey = r.hasKey;
    state.settings.baseUrl = cfg.baseUrl;
    state.settings.priceIn = cfg.priceIn;
    state.settings.priceOut = cfg.priceOut;
    $('#modalSettings').classList.add('hidden');
    await refreshHealth(true);
    toast('设置已保存', 'ok');
  } catch (e) {
    toast('保存失败：' + e.message, 'err');
  }
}

async function testConnection() {
  const apiKey = $('#setApiKey').value.trim();
  const baseUrl = $('#setBaseUrl').value.trim();
  if (!apiKey || apiKey === 'sk-****************') { toast('请先填写 API Key 并保存', 'err'); return; }
  const statusEl = $('#fetchModelStatus');
  statusEl.textContent = '测试中…';
  try {
    await Api.saveConfig({ apiKey, baseUrl });
    await refreshHealth(true);
    const models = await Api.models();
    statusEl.textContent = '连接成功，模型库共 ' + models.length + ' 个模型。';
    statusEl.style.color = '#2fa868';
  } catch (e) {
    statusEl.textContent = '连接失败：' + e.message;
    statusEl.style.color = '#e5484d';
  }
}

async function fetchModels() {
  const statusEl = $('#fetchModelStatus');
  statusEl.textContent = '拉取中…';
  statusEl.style.color = '';
  try {
    const models = await Api.models();
    /* 保留 qwen 系对话模型：视觉/全模态（视频理解）+ 纯文本（理解后对话），
       排除 OCR/向量库/音频/图像生成等非对话模型 */
    const keep = models.filter(keepDialogModel);
    const visCount = keep.filter(m => !modelIsText(m)).length;
    const txtCount = keep.length - visCount;
    const existing = new Set(state.settings.customModels || []);
    const added = keep.filter(m => !existing.has(m));
    state.settings.customModels = [...existing, ...added];
    try { localStorage.setItem('vdu.customModels', JSON.stringify(state.settings.customModels)); } catch (e) { /* ignore */ }
    statusEl.textContent = `已拉取 ${models.length} 个模型：新增 ${added.length} 个对话模型（视觉/全模态 ${visCount} 个、纯文本 ${txtCount} 个）；非对话模型（OCR/向量/音频等）已过滤。`;
    statusEl.style.color = '#2fa868';
    renderModelManageSel();
    refreshModelSelects();
  } catch (e) {
    statusEl.textContent = '拉取失败：' + e.message;
    statusEl.style.color = '#e5484d';
  }
}

/* 设置页「模型管理」下拉：展示自定义模型列表 + 移除功能 */
function renderModelManageSel() {
  const sel = $('#setModelSel');
  sel.innerHTML = (state.settings.customModels || []).slice()
    .sort((a, b) => (modelIsText(a) ? 1 : 0) - (modelIsText(b) ? 1 : 0) || a.localeCompare(b))
    .map(m => `<option value="${esc(m)}">${esc(m)}${modelIsText(m) ? '（文本）' : ''}</option>`).join('')
    || '<option value="">（暂无，点击右侧拉取）</option>';
}

function removeCustomModel() {
  const sel = $('#setModelSel');
  const m = sel.value;
  if (!m) { toast('请先在下拉框选择要移除的模型', ''); return; }
  state.settings.customModels = (state.settings.customModels || []).filter(x => x !== m);
  try { localStorage.setItem('vdu.customModels', JSON.stringify(state.settings.customModels)); } catch (e) { /* ignore */ }
  renderModelManageSel();
  refreshModelSelects();
  toast('已移除：' + m, 'ok');
}

async function refreshModelSelects() {
  fillModelSelect($('#chatModelSelect'), state.activeConv ? state.activeConv.model : '');
  fillModelSelect($('#wizModelSelect'), $('#wizModelSelect').value, true);
}

/* =========================================================================
 * 导出 / 导入
 * ========================================================================= */
async function exportData() {
  const projects = await DB.getAll('projects');
  const conversations = await DB.getAll('conversations');
  const messages = await DB.getAll('messages');
  const data = {
    app: 'vdu', version: 1, exportedAt: new Date().toISOString(),
    projects, conversations, messages,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '视频理解工作台-数据备份-' + fmtDate(nowMs()) + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('已导出 ' + projects.length + ' 个项目', 'ok');
}

/* 导出诊断日志：合并服务端 server.log + 本次会话浏览器侧捕获的错误，生成可发送的 .txt
   （绝不包含 API Key） */
async function exportDiagnosticLog() {
  let serverLines = [], serverErr = '';
  try {
    const r = await fetch('/api/log', { cache: 'no-store' });
    const j = await r.json();
    serverLines = (j && Array.isArray(j.entries)) ? j.entries : [];
  } catch (e) {
    serverErr = '（无法读取服务端日志：' + ((e && e.message) || e) + '，请确认本地服务已启动）';
  }
  const L = [];
  L.push('================ 视频理解工作台 · 诊断日志 ================');
  L.push('导出时间: ' + new Date().toLocaleString());
  L.push('应用版本: v' + APP_VERSION);
  L.push('服务端地址: ' + (state.settings.baseUrl || '（未知）'));
  L.push('已配置 API Key: ' + (state.settings.hasKey ? '是' : '否'));
  L.push('');
  L.push('---- 服务端日志（server.log 最近 200 行）----');
  if (serverErr) L.push(serverErr);
  else if (serverLines.length) L.push.apply(L, serverLines);
  else L.push('（服务端日志为空）');
  L.push('');
  L.push('---- 本次会话前端捕获的错误 ----');
  if (!diagLog.length) L.push('（无）');
  else diagLog.forEach(x => L.push('[' + x.ts + '] ' + x.msg));
  const text = L.join('\r\n');
  const blob = new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '诊断日志-' + fmtDate(nowMs()) + '.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('已导出诊断日志', 'ok');
}

async function importData(file) {
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { toast('导入失败：JSON 解析错误', 'err'); return; }
  if (!data || data.app !== 'vdu' || !Array.isArray(data.projects)) { toast('导入失败：文件格式不正确', 'err'); return; }
  await confirmDialog('导入数据', `将导入 ${data.projects.length} 个项目（覆盖同名 ID 数据），继续？`, async () => {
    for (const p of data.projects) await DB.put('projects', p);
    for (const c of data.conversations || []) await DB.put('conversations', c);
    for (const m of data.messages || []) await DB.put('messages', m);
    await reloadAllData();
    renderAll();
    toast('导入完成', 'ok');
  });
}

async function clearAllData() {
  await confirmDialog('清空数据', '将删除本机浏览器中保存的全部项目、对话与消息（不影响 config.json 中的 API Key）。此操作不可恢复！', async () => {
    await DB.clear('projects');
    await DB.clear('conversations');
    await DB.clear('messages');
    state.projects = []; state.conversations = []; state.messages = [];
    state.activeProjectId = null; state.activeConvId = null;
    renderAll();
    toast('已清空', 'ok');
  });
}

/* =========================================================================
 * 健康检查 & 启动
 * ========================================================================= */
async function refreshHealth(silent) {
  try {
    const h = await Api.health();
    state.serverOk = true;
    state.settings.hasKey = h.hasKey;
    state.settings.baseUrl = h.baseUrl;
    state.serverFfmpeg = !!h.ffmpeg;
    state.serverFfmpegVersion = h.ffmpegVersion || null;
    try { const cfg = await Api.config(); state.settings.priceIn = cfg.priceIn; state.settings.priceOut = cfg.priceOut; } catch (e) { /* ignore */ }
  } catch (e) {
    state.serverOk = false;
  }
  renderServerBadge();
  return state.serverOk;
}

async function loadPersisted() {
  try {
    const [projects, conversations] = await Promise.all([
      DB.getAll('projects'), DB.getAll('conversations'),
    ]);
    state.projects = projects || [];
    state.conversations = conversations || [];
    try {
      const list = JSON.parse(localStorage.getItem('vdu.customModels') || '[]');
      if (Array.isArray(list)) {
        // 只保留对话模型（视觉 + 纯文本；自动剔除旧版误存的非对话模型）
        state.settings.customModels = list.filter(keepDialogModel);
      }
    } catch (e) { /* ignore */ }
  } catch (e) {
    console.warn('读取本地数据失败', e);
  }
}

async function reloadAllData() {
  state.projects = await DB.getAll('projects');
  state.conversations = await DB.getAll('conversations');
}

/* =========================================================================
 * 事件绑定
 * ========================================================================= */
function bindEvents() {
  /* 顶栏 */
  $('#btnSettings').addEventListener('click', openSettings);

  /* 项目 */
  $('#btnNewProject').addEventListener('click', openWizard);
  $('#btnNewConv').addEventListener('click', newBranchConv);
  $('#btnVideoDelete').addEventListener('click', deleteProjectConfirm);
  $('#btnVideoReAnalyze').addEventListener('click', () => {
    const p = activeProject();
    if (!p) return;
    if (isExpired(p)) {
      confirmDialog('视频链接已过期', '该项目上传的视频已超过 48 小时临时有效期，请先在项目卡片点击「⬆ 重新上传」重新上传文件，然后再发起重新理解。', () => {});
      return;
    }
    if (!state.serverOk) { toast('本地服务未连接，无法发起重新理解', 'err'); return; }
    confirmDialog('重新理解', '将按当前对话参数重新发起一次视频理解（使用最新的详细分镜提示词，生成一个新对话），原有对话保留。继续？', async () => {
      const p2 = activeProject();
      if (!p2) return;
      try {
        await newBranchConv();
        const conv = activeConv();
        if (conv) {
          conv.name = '视频理解（重新）';
          conv.prompt = DEFAULT_PROMPT;   // 重新理解统一使用最新详细模板
          const userMsg = { id: uuid(), convId: conv.id, role: 'user', content: DEFAULT_PROMPT, video: { url: p2.videoRef.url, fps: conv.fps || p2.fps || 2 }, ts: nowMs(), est: null };
          await DB.put('messages', userMsg);
          state.messages.push(userMsg);
          renderAll();
          const res = await firstRoundTell(conv, userMsg);
          toast(res && res.aborted ? '重新理解已停止（部分内容已保存）' : '重新理解完成', 'ok');
        }
      } catch (e) {
        toast('重新理解失败：' + (e && e.message ? e.message : e), 'err');
      }
    });
  });

  /* 项目卡片：重命名 / 重新上传 */
  $('#btnVideoRename').addEventListener('click', renameActiveProject);
  $('#btnVideoReupload').addEventListener('click', () => {
    const p = activeProject();
    if (!p) return;
    if (p.videoRef && p.videoRef.type !== 'oss') { toast('该项目使用公网 URL，无需上传', ''); return; }
    if (!state.serverOk) { toast('本地服务未连接', 'err'); return; }
    $('#reuploadFileInput').value = '';
    $('#reuploadFileInput').click();
  });
  $('#reuploadFileInput').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) await reuploadProjectVideo(f);
    e.target.value = '';
  });

  /* 聊天 */
  $('#btnChatRename').addEventListener('click', renameActiveConv);
  $('#btnChatDelete').addEventListener('click', deleteConvConfirm);
  $('#btnModelInfo').addEventListener('click', openModelInfo);
  $('#chatModelSelect').addEventListener('change', (e) => {
    const c = activeConv();
    if (!c) return;
    const p = activeProject();
    c.model = e.target.value;
    /* 纯文本模型不支持视频：若「每轮附带视频」开着则自动关闭 */
    if (c.attachVideo && modelIsText(c.model)) {
      c.attachVideo = false;
      $('#chatAttachVideo').checked = false;
      toast('已自动关闭「每轮附带视频」：纯文本模型不支持视频，如需核对画面请切换回视觉模型', 'err');
    } else if (p && c.attachVideo && c.model !== p.model) {
      toast('提示：视频文件上传时绑定的是「' + p.model + '」，开启「每轮附带视频」时请使用相同模型；纯文本对话不受影响', 'err');
    }
    DB.put('conversations', c);
    updateEstBar();
  });
  $('#chatAttachVideo').addEventListener('change', (e) => {
    const c = activeConv();
    if (!c) return;
    const p = activeProject();
    /* 纯文本模型不能附视频：拒绝勾选 */
    if (e.target.checked && modelIsText(c.model)) {
      e.target.checked = false;
      c.attachVideo = false;
      DB.put('conversations', c);
      toast('「' + c.model + '」是纯文本模型，不支持附带视频；请先在模型下拉选择视觉/全模态模型', 'err');
      updateEstBar();
      return;
    }
    c.attachVideo = e.target.checked;
    DB.put('conversations', c);
    if (p && e.target.checked && isExpired(p)) {
      toast('提示：视频临时链接已过期，请先在项目卡片点击「⬆ 重新上传」', 'err');
    } else if (p && e.target.checked && c.model !== p.model) {
      toast('提示：当前对话模型是「' + c.model + '」，与视频上传绑定的「' + p.model + '」不一致；开启附带视频可能会被百炼拒绝，建议切换为「' + p.model + '」', 'err');
    }
    updateEstBar();
  });
  $('#btnSend').addEventListener('click', () => {
    if (state.streaming) {
      if (abortCtl) abortCtl.abort();   // 停止生成：已生成内容保留
      return;
    }
    sendMessage($('#chatInput').value);
  });
  $('#chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!state.streaming) sendMessage($('#chatInput').value);
    }
  });
  $('#chatInput').addEventListener('input', () => {
    const ta = $('#chatInput');
    ta.style.height = 'auto';
    ta.style.height = Math.min(200, ta.scrollHeight) + 'px';
    updateEstBar();
  });

  /* 滚动到底部按钮 */
  const chatBoxEl = $('#chatMessages');
  chatBoxEl.addEventListener('scroll', () => {
    const far = chatBoxEl.scrollHeight - chatBoxEl.scrollTop - chatBoxEl.clientHeight;
    $('#btnScrollBottom').classList.toggle('hidden', far < 120);
  });
  $('#btnScrollBottom').addEventListener('click', () => {
    chatBoxEl.scrollTo({ top: chatBoxEl.scrollHeight, behavior: 'smooth' });
  });

  /* 向导 */
  $('#btnPickVideo').addEventListener('click', () => $('#videoFileInput').click());
  $('#videoFileInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) await handlePickFile(file);
  });
  const dz = $('#dropzone');
  ['dragover', 'drop'].forEach((ev) => {
    dz.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); });
  });
  dz.addEventListener('dragover', () => dz.classList.add('dragover'));
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', async (e) => {
    dz.classList.remove('dragover');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) await handlePickFile(file);
  });
  $('#btnUseUrl').addEventListener('click', async () => {
    const url = $('#videoUrlInput').value.trim();
    if (!/^https?:\/\//.test(url)) { toast('请输入以 http(s):// 开头的公网地址', 'err'); return; }
    $('#btnUseUrl').disabled = true;
    $('#btnUseUrl').textContent = '校验中…';
    try {
      const r = await Api.checkUrl(url);
      wiz.file = null; wiz.uploadResult = null;
      wiz.url = { url, contentLength: r.contentLength, contentType: r.contentType, warning: r.warning };
      $('#videoPreviewCard').classList.add('hidden');
      $('#uploadPanel').classList.add('hidden');
      $('#wizProjectName').value = '';
      toast(r.warning ? ('URL 已通过（注意：' + r.warning + '）') : 'URL 校验通过', 'ok');
    } catch (e) {
      toast('URL 校验失败：' + (e.message || ''), 'err');
    } finally {
      $('#btnUseUrl').disabled = false;
      $('#btnUseUrl').textContent = '使用 URL';
    }
  });
  const resetVideoPick = () => resetWizard();
  $('#btnResetVideo2').addEventListener('click', resetVideoPick);

  $('#wizModelSelect').addEventListener('change', updateWizModelInfo);
  $('#wizFps').addEventListener('input', () => {
    $('#fpsVal').textContent = Number($('#wizFps').value).toFixed(1);
    if (wiz.step === 3) renderEstimate();
  });
  $('#wizPrompt').addEventListener('input', () => { if (wiz.step === 3) renderEstimate(); });
  $('#wizProjectName').addEventListener('input', updateEstimateUI);

  $('#wizPrev').addEventListener('click', () => setWizStep(Math.max(1, wiz.step - 1)));
  $('#wizNext').addEventListener('click', async () => {
    if (wiz.busy) return;
    if (wiz.step === 1 && !wiz.file && !wiz.url) { toast('请先选择视频文件或填写公网 URL', 'err'); return; }
    setWizStep(Math.min(3, wiz.step + 1));
  });
  $('#wizStart').addEventListener('click', startUnderstanding);
  $('#wizCancel').addEventListener('click', () => {
    releaseWizardPreview();
    $('#modalWizard').classList.add('hidden');
  });

  /* 设置 */
  $('#setApiKey').addEventListener('change', () => {
    // 占位符恢复为空，确保用户真的填写
    if ($('#setApiKey').value === 'sk-****************') $('#setApiKey').value = '';
  });
  $('#btnTestKey').addEventListener('click', testConnection);
  $('#btnFetchModels').addEventListener('click', fetchModels);
  $('#btnRemoveModel').addEventListener('click', removeCustomModel);
  /* 设置「保存」按钮：真正保存 API Key / Base URL / 单价到服务端 config.json */
  const settingsSaveBtn = document.querySelector('#modalSettings .modal-foot .btn-primary');
  if (settingsSaveBtn) settingsSaveBtn.addEventListener('click', saveSettings);
  $('#btnExportData').addEventListener('click', exportData);
  $('#btnExportLog').addEventListener('click', exportDiagnosticLog);
  $('#btnImportData').addEventListener('click', () => $('#importFileInput').click());
  $('#importFileInput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) importData(f);
    e.target.value = '';
  });
  $('#btnClearAll').addEventListener('click', clearAllData);

  /* 视频压缩面板 */
  $('#btnWizCompress').addEventListener('click', openCompress);
  $('#cmpStart').addEventListener('click', startCompress);
  $('#cmpUse').addEventListener('click', useCompressResult);

  /* 确认框 */
  $('#confirmOk').addEventListener('click', () => {
    $('#modalConfirm').classList.add('hidden');
    const cb = confirmCb; confirmCb = null;
    if (cb) cb();
  });
  $('#confirmCancel').addEventListener('click', () => { confirmCb = null; $('#modalConfirm').classList.add('hidden'); });

  /* 模态关闭 */
  $$('.modal-close').forEach((el) => el.addEventListener('click', () => {
    if (el.dataset.close) $('#' + el.dataset.close).classList.add('hidden');
  }));
  $$('.modal-mask').forEach((mask) => {
    mask.addEventListener('click', (e) => { if (e.target === mask) mask.classList.add('hidden'); });
  });
}

/* ---------------- 选择文件 ---------------- */
async function handlePickFile(file) {
  if (!file) return;
  wiz.url = null; wiz.uploadResult = null;
  $('#wizProjectName').value = '';
  try {
    const meta = await probeVideoFile(file);
    wiz.file = file;
    wiz.meta = meta;
    /* 缩略图：释放上一次预览的 blob URL，避免内存泄漏 */
    if (wiz.previewUrl) { try { URL.revokeObjectURL(wiz.previewUrl); } catch (e) { /* ignore */ } }
    const v = $('#videoPreview');
    wiz.previewUrl = URL.createObjectURL(file);
    v.src = wiz.previewUrl;
    await new Promise((res) => {
      if (v.readyState >= 2) { res(); return; }
      v.addEventListener('loadeddata', res, { once: true });
      setTimeout(res, 8000); // 兜底：解码慢/失败不阻塞向导
    });
    /* 跳到 0.5s 处截图；等 seeked（带 2s 兜底）后取缩略图，避免截到黑帧 */
    try { v.currentTime = Math.min(0.5, (meta.duration || 1) / 2); } catch (e) { /* ignore */ }
    await new Promise((res) => {
      v.addEventListener('seeked', res, { once: true });
      setTimeout(res, 2000);
    });
    wiz.thumb = await captureThumb(v);
    $('#videoPreviewCard').classList.remove('hidden');
    $('#vpName').textContent = meta.name;
    $('#vpDuration').textContent = fmtDuration(meta.duration);
    $('#vpSize').textContent = (meta.width ? meta.width + '×' + meta.height : '-');
    $('#vpFps').textContent = meta.fps ? meta.fps.toFixed(1) + ' fps' : '-';
    $('#vpBytes').textContent = fmtBytes(meta.size);
    $('#vpFormat').textContent = meta.ext;
    $('#wizProjectName').value = meta.name.replace(/\.[^.]+$/, '');
    /* 上传延后到「开始理解」时执行（此时模型已最终确定，文件与模型绑定一致） */
  } catch (e) {
    toast('视频解析失败：' + (e.message || ''), 'err');
  }
}

/* 恢复刷新/关页前的上传：转存已完成（或等待其完成后）直接回到向导「预估与理解」步，
   用户点击「开始理解」即可继续，无需重新上传 */
function resumePendingUpload(p) {
  openWizard();
  const ext = (p.fileName || '').split('.').pop().toUpperCase();
  wiz.file = null;          // 刷新后 File 对象已丢失，但转存结果在服务端
  wiz.url = null;
  wiz.thumb = null;
  wiz.uploadResult = p.result;
  wiz.meta = p.meta ? { name: p.fileName, size: p.fileSize, ext: ext || '', duration: p.meta.duration, width: p.meta.width, height: p.meta.height, fps: p.meta.fps } : null;
  if (p.prompt) $('#wizPrompt').value = p.prompt;
  if (p.fps) { $('#wizFps').value = p.fps; $('#fpsVal').textContent = Number(p.fps).toFixed(1); }
  if (p.model) { fillModelSelect($('#wizModelSelect'), modelIsText(p.model) ? 'qwen3-omni-flash' : p.model, true); $('#wizModelSelect').value = modelIsText(p.model) ? 'qwen3-omni-flash' : p.model; }
  if (p.projectName) $('#wizProjectName').value = p.projectName; else if (p.fileName) $('#wizProjectName').value = p.fileName.replace(/\.[^.]+$/, '');
  updateWizModelInfo();
  setWizStep(3);
  renderEstimate();
  $('#uploadPanel').classList.remove('hidden');
  $('#upName').textContent = p.fileName || '视频';
  $('#upStat').textContent = '上传已完成 ✓ 临时链接 48 小时有效（刷新前完成，未丢失）';
  $('#upBarFill').style.width = '100%';
  clearPendingUpload();
  toast('已恢复上次上传，直接点「开始理解」即可继续', 'ok');
}

async function uploadForWizard() {
  if (!wiz.file) return false;
  const model = $('#wizModelSelect').value;
  $('#uploadPanel').classList.remove('hidden');
  $('#upName').textContent = wiz.file.name;
  $('#upStat').textContent = '正在上传到本地服务… 0%';
  $('#upBarFill').style.width = '0%';
  /* 断点记录：上传一旦开始就记下任务参数（key 在阶段一完成后回填），
     期间刷新浏览器可在 init 时恢复（转存由服务端后台执行，不受刷新影响） */
  savePendingUpload({
    key: null,
    fileName: wiz.file.name, fileSize: wiz.file.size,
    model, fps: Number($('#wizFps').value),
    prompt: $('#wizPrompt').value, projectName: $('#wizProjectName').value,
    meta: wiz.meta ? { duration: wiz.meta.duration, width: wiz.meta.width, height: wiz.meta.height, fps: wiz.meta.fps } : null,
    result: null,
  });
  /* 取消支持：阶段一中断 XHR；阶段二通知服务端停止转存（服务端会删除临时文件） */
  const upCtrl = { aborted: false, abortXhr: null, uploadKey: null };
  const cancelBtn = $('#btnUpCancel');
  cancelBtn.classList.remove('hidden');
  cancelBtn.onclick = () => { if (upCtrl.abortXhr) upCtrl.abortXhr(); };
  /* 阶段一：浏览器 → 本地服务；阶段二：本地服务 → 百炼临时存储（后台，可查进度） */
  let lastStat = '', lastKey = null;
  const setStat = (s) => {
    lastStat = s;
    $('#upStat').textContent = s;
  };
  try {
    const r = await Api.upload(wiz.file, model, (p) => {
      $('#upBarFill').style.width = Math.round(p * 100) + '%';
      setStat('正在上传到本地服务… ' + Math.round(p * 100) + '%');
    }, ({ phase, progress, waited }) => {
      /* 阶段一完成拿到 uploadKey 后立即落盘断点（此后刷新可恢复） */
      if (upCtrl.uploadKey && lastKey !== upCtrl.uploadKey) {
        lastKey = upCtrl.uploadKey;
        savePendingUpload({ key: upCtrl.uploadKey });
      }
      const mm = String(Math.floor(waited / 60)).padStart(2, '0');
      const ss = String(waited % 60).padStart(2, '0');
      if (phase === 'done') {
        $('#upBarFill').style.width = '100%';
        setStat('转存完成 ✓ 临时链接 48 小时有效');
      } else if (phase === 'presign' && (!progress || progress <= 0)) {
        /* 凭证阶段：尚未开始传输 */
        $('#upBarFill').style.width = '2%';
        setStat('正在获取上传凭证… 已等待 ' + mm + ':' + ss);
      } else if (phase === 'uploading' || progress > 0) {
        /* 转存阶段：百分比实时增长（progress>0 时即认为在转存，避免文案误导） */
        $('#upBarFill').style.width = Math.round(Math.max(2, progress * 100)) + '%';
        setStat('正在转存至阿里云临时存储… ' + Math.round(progress * 100) + '% · 已等待 ' + mm + ':' + ss);
      } else {
        $('#upBarFill').style.width = '8%';
        setStat('文件已接收，正在准备转存… 已等待 ' + mm + ':' + ss);
      }
    }, upCtrl);
    wiz.uploadResult = r;
    $('#upBarFill').style.width = '100%';
    if (lastStat.indexOf('转存完成') < 0) setStat('上传完成 ✓ 临时链接 48 小时有效');
    /* 保留断点（含 result）：此时刷新仍可恢复向导；项目创建成功后由 startUnderstanding 清除 */
    savePendingUpload({ key: upCtrl.uploadKey, result: r });
    return true;
  } catch (e) {
    const cancelled = /取消/.test(e.message || '');
    clearPendingUpload();
    if (cancelled) {
      $('#upStat').textContent = '已取消上传';
      $('#upBarFill').style.width = '0%';
    } else {
      $('#upStat').textContent = '上传失败：' + e.message;
      $('#upBarFill').style.width = '0%';
      toast('上传失败：' + e.message, 'err');
    }
    return false;
  } finally {
    cancelBtn.classList.add('hidden');
  }
}

/* =========================================================================
 * 初始化
 * ========================================================================= */
/* 全局错误可视化：页面任何未捕获错误/未处理 Promise 拒绝都会弹提示，便于定位 */
window.addEventListener('error', (e) => {
  try { toast('页面错误: ' + (e.message || e.error || '未知'), 'err'); } catch (_) {}
  console.error('[vdu] window error:', e);
});
window.addEventListener('unhandledrejection', (e) => {
  try { toast('异步错误: ' + ((e.reason && e.reason.message) || e.reason || '未知'), 'err'); } catch (_) {}
  console.error('[vdu] unhandled rejection:', e.reason);
});

(async function init() {
  const verEl = $('#appVersion');
  if (verEl) verEl.textContent = 'v' + APP_VERSION;
  bindEvents();
  try {
    await loadPersisted();
  } catch (e) {
    console.error('[vdu] loadPersisted failed', e);
  }
  let ok = false;
  try {
    ok = await refreshHealth(false);
  } catch (e) {
    console.error('[vdu] refreshHealth failed', e);
  }
  if (!ok) {
    $('#projectEmptyHint').innerHTML = '<div class="empty-icon">⚠️</div><p>未检测到本地服务</p><p class="empty-sub">请先双击项目文件夹中的「启动.cmd」<br>（需要本机已安装 Python 3.8+）</p>';
    $('#convFoot').textContent = '本地服务未连接，功能不可用';
    toast('未检测到本地服务，请通过「启动.cmd」启动', 'err');
    renderAll();
  } else {
    state.settings.customModels = state.settings.customModels || [];
    /* 刷新/关页前的上传断点恢复：转存由服务端后台线程执行，刷新不会丢数据，
       这里查询服务端任务状态并恢复向导（已完成→直接恢复；进行中→等它完成再恢复；
       失败/取消/任务不存在→清理并提示） */
    try {
      const pend = readPendingUpload();
      if (pend && pend.key) {
        let s = null;
        try {
          const r = await fetch('/api/upload_status?key=' + encodeURIComponent(pend.key), { cache: 'no-store' });
          s = await r.json();
        } catch (e) { s = null; }
        if (s && !s.error) {
          if (s.phase === 'done' && s.result) {
            resumePendingUpload({ ...pend, result: s.result });
          } else if (s.phase === 'error') {
            toast('上次上传失败：' + (s.error || '未知原因') + '，请重新上传', 'err');
            clearPendingUpload();
          } else if (s.phase === 'canceled') {
            toast('上次上传已取消，请重新上传', '');
            clearPendingUpload();
          } else {
            /* 转存仍在进行：后台等它完成，然后恢复向导（期间用户若开始新上传则不打扰） */
            toast('检测到上次上传仍在转存（' + Math.round((s.progress || 0) * 100) + '%），完成后自动恢复…', '');
            (async () => {
              let r = null;
              await new Promise((resolve) => {
                pollTransit(pend.key, (v) => { r = v; resolve(); }, () => resolve(), null, null);
              });
              const cur = readPendingUpload();
              if (r && r.url && cur && cur.key === pend.key) {
                resumePendingUpload({ ...pend, result: r });
              } else {
                clearPendingUpload();
                toast('上次上传未能恢复（可能已取消或失败），请重新上传', 'err');
              }
            })();
          }
        } else {
          /* 服务端重启导致任务丢失等 */
          clearPendingUpload();
          if (s && s.error) toast('上次上传任务已不存在（服务可能已重启），请重新上传', 'err');
        }
      }
    } catch (e) {
      console.warn('[vdu] 恢复上传断点失败', e);
    }
    // 选择一个最近项目
    try {
      if (state.projects.length) {
        const last = state.projects.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];
        await selectProject(last.id);
      } else {
        renderAll();
      }
    } catch (e) {
      console.error('[vdu] init select failed', e);
      state.activeProjectId = null; state.activeConvId = null; state.messages = [];
      renderAll(); // 兜底：即使初始化异常也渲染界面，避免整页空白
    }
  }
})();
