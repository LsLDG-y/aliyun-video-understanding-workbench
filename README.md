# 🎬 视频理解工作台（阿里云百炼）`v1.0`

[![Python](https://img.shields.io/badge/Python-3.8%2B-blue)](https://www.python.org/downloads/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![No third-party deps](https://img.shields.io/badge/deps-none-orange)]()

一个开箱即用的 **视频理解 + 多分支上下文对话** 前端工具，基于阿里云百炼（DashScope）大模型。

- 选择本地视频 → **直接上传**到百炼临时存储（48h 有效）→ 以原生 `video_url` 交给大模型理解（官方抽帧管道，效果最佳，支持视频里的**声音/音效**理解）
- 每个视频理解完成后成为一个**项目**，项目下可创建**多个分支对话**，围绕同一视频进行不同方向的追问，上下文连续
- 科学 Token 预估：按百炼官方「计算图像与视频 Token」规则实现（抽帧 fps、smart_resize 缩放、总像素预算），发送前即可看到预估消耗与费用
- 对话记录自动保存（浏览器 IndexedDB），可导出/导入 JSON 备份
- 界面支持流式输出、思考过程折叠显示、按模型内置官方单价估算费用
- **纯 Python 标准库**后端 + **零第三方依赖**前端，本地代理仅监听 `127.0.0.1:8686`

> 依据官方文档（2026-08）：[图像与视频理解](https://help.aliyun.com/zh/model-studio/vision) · [全模态 Omni](https://help.aliyun.com/zh/model-studio/omni) · [模型调用计费](https://help.aliyun.com/zh/model-studio/model-pricing)

---

## 一、快速开始

**方式一：源码运行（本仓库）**

1. 安装 **Python 3.8+**（勾选 "Add python.exe to PATH"），无需 pip、无第三方依赖
2. 双击 `启动.cmd`，浏览器自动打开 `http://127.0.0.1:8686/`
3. 右上角 **⚙ 设置** → 填入**你自己的**阿里云百炼 API Key → **测试连接** → 点右下角「**保存**」
4. 点击 **＋ 新建项目**，选择/拖拽一个视频开始理解

> **方式二：免安装（零）** —— 仓库的 [Releases](https://github.com/your-account/your-repo/releases) 页面提供内置便携版 Python 的自包含包，解压即用、目标电脑无需安装 Python。详见文末「发布说明」。

> ⚠ 注意：`config.json`（含 API Key）已被 `.gitignore` 忽略，**不会、也不应提交**；首次运行前请自行创建（可参考 `config.example.json` 模板），或直接在设置页填写，程序会自动生成。

## 二、支持模型与官方单价（华北2·北京，每百万 Token）

| 模型 ID | 输入价（图/视频） | 输出价 | 视频时长限制 | 说明 |
|---|---|---|---|---|
| `qwen3-omni-flash` | 3.3 元 | 6.9 元 | ≤150 秒 | 全模态轻量·**主推**·可听音频 |
| `qwen3.5-omni-flash` | 2.2 元 | 13.3 元 | 与全模态规则一致 | 全模态轻量 |
| `qwen3.5-omni-plus` | 7 元 | 40 元 | ≤1 小时 | 全模态旗舰·音频输出·联网搜索 |
| `qwen3-vl-plus` | 1~3 元（阶梯） | 10 元 | ≤1 小时 | 纯视觉·思考可开关 |
| `qwen3-vl-flash` | 0.15 元 | 1.5 元 | ≤1 小时 | 纯视觉·最便宜 |
| `qwen-vl-max` | 1.6 元 | 4 元 | ≤20 分钟 | 传统视觉主力 |
| `qwen-vl-plus` | 0.8 元 | 2 元 | ≤10 分钟 | 传统视觉 |

- 以上模型均有 **100 万 Token 免费额度**（自开通百炼/模型发布之日起 90 天内，以较晚者为准）
- 实测参考：7.4 秒 720p 短视频 + 一轮追问 ≈ 8,800 Token ≈ **¥0.03**
- 未收录的模型按通用规则估算，界面会提示；实际消耗以每次 API 返回的 `usage` 为准

**选型速查**：短视频（≤150 秒）优先 **Omni 全模态**（能听声音·最划算）；**纯视觉 VL 系列**适合无需声音的较长视频（≤1 小时更省）；理解完成后可切 **纯文本模型**（如 `qwen3.7-plus`）省钱追问。界面内置完整选型指导（第 2 步展示每个模型的场景/限制/单价，对话区 **ⓘ** 可随时查看）。

## 三、如何工作（架构）

```
浏览器 (index.html + assets/)  ──►  本地代理 server.py (127.0.0.1:8686)  ──►  阿里云百炼
                                  │
                                  ├─ /api/upload      两阶段上传：落盘 → 后台转存百炼临时 OSS（48h 有效）
                                  ├─ /api/upload_status 轮询转存进度（支持取消）
                                  └─ /api/chat         转发 OpenAI 兼容接口（流式 SSE 透传，自动带 OSS 解析头）
```

- **为何走本地代理**：百炼 `/api/v1/uploads` 的 OSS 上传与 `oss://` 解析不在浏览器的 CORS 白名单内，且需要携带 `X-DashScope-OssResourceResolve`，故上传与对话转发必须经本地代理（顺带隐藏 API Key）
- **数据持久化**：项目/对话/消息存浏览器 IndexedDB，服务端不落库；API Key 仅存于本机 `config.json`
- **纯标准库**：`http.server` / `urllib` / `threading`，无任何第三方 Python 包

## 四、文件结构

```
视频理解工作台/
├── 启动.cmd               # 双击启动（优先内置 python\python.exe；仓库源码则用系统 Python 3.8+）
├── server.py              # 本地服务：静态托管 + 上传/对话代理（纯标准库）
├── index.html             # 界面
├── assets/
│   ├── style.css          # 样式
│   └── app.js             # 前端逻辑：状态/持久化/流式对话/Token 估算
├── scripts/
│   └── 端到端验证.mjs      # 开发自检脚本（可选，需 config + 一个视频，见下）
├── config.example.json    # 配置模板（复制为 config.json 并填入 API Key）
└── .gitignore             # 忽略 config.json / python/ / 视频 / 缓存等
```

## 五、常见问题

| 问题 | 解决 |
|---|---|
| 双击「启动.cmd」窗口一闪而过 | 启动器为纯 ASCII 版（规避 GBK 控制台解析错乱）。若仍异常，右键「以管理员身份运行」看报错 |
| 提示「Python 3.8+ was not found」 | 按窗口提示安装 Python 3.8+（勾选 Add to PATH）。免安装包见 Releases |
| 页面提示「未检测到本地服务」 | 保持 `启动.cmd` 的黑窗口开启，然后刷新页面；确认 8686 未被占用（脚本会自动换端口） |
| 上传失败 | 检查 API Key 有效性、所选模型与上传绑定是否一致、文件是否超模型上限 |
| 上传成功但理解报错 | 临时链接过期（先「**⬆ 重新上传**」再「**🔄 重新理解**」）；或模型不支持该时长/格式 |
| 费用不准 | 单价取自 2026-08 官方文档，以百炼控制台为准；可在设置中覆盖单价 |
| 换电脑后数据还在吗 | 数据存浏览器 IndexedDB，不自动迁移；可在设置 → 导出全部数据后在新电脑导入 |

## 六、开发自检

可选：本地服务启动且已配置 API Key 后，运行

```bash
node scripts/端到端验证.mjs [模型ID]
# 默认模型 qwen3-omni-flash；需要一个名为 测试.mp4 的视频文件（可在当前目录自备）
```

脚本会：上传视频 → 第一轮视频理解（附带视频）→ 第二轮上下文追问，并打印 token 用量。

## 七、发布说明（自包含免安装包）

仓库源码不含内置 Python。为方便普通用户，可在 **Releases** 附上自包含构建包：在上面源码基础上加入 `python/`（Windows 官方便携版 Python 3.14.7）并清空 `config.json`，`启动.cmd` 会自动优先使用内置 Python，实现目标电脑**免安装双击即用**。打包时请删除 `config.json`（密钥）与测试视频。

## License

[MIT](LICENSE) © 2026
