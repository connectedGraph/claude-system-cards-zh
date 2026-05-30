# Claude 系列系统卡片大陆简体中文翻译

批量下载 Anthropic Claude 4 系列系统卡片及 Mythos Preview 的官方 PDF，提取文本与配图、AI 翻译为大陆简体中文(zh-CN)Markdown，并渲染成一个带模型/卡片切换的共享 HTML 阅读器。

## 在线阅读

**🔗 [在线查看器 https://connectedgraph.github.io/claude-system-cards-zh/](https://connectedgraph.github.io/claude-system-cards-zh/)**

左侧下拉切换卡片，自动生成目录导航、页码跳转、夜间模式，正文内嵌原文配图。

## 收录的系统卡片

| 卡片 | 原文日期 | 官方 PDF |
|---|---|---|
| Claude Opus 4.8 | 2026-05-28 | [PDF](https://cdn.sanity.io/files/4zrzovbb/website/c886650a2e96fc0925c805a1a7ca77314ccbf4a6.pdf) |
| Claude Opus 4.7 | 2026-04 | [PDF](https://cdn.sanity.io/files/4zrzovbb/website/037f06850df7fbe871e206dad004c3db5fd50340.pdf) |
| Claude Mythos Preview | 2026-04 | [PDF](https://cdn.sanity.io/files/4zrzovbb/website/7624816413e9b4d2e3ba620c5a5e091b98b190a5.pdf) |
| Claude Sonnet 4.6 | 2026-02 | [PDF](https://www-cdn.anthropic.com/bbd8ef16d70b7a1665f14f306ee88b53f686aa75.pdf) |
| Claude Opus 4.6 | 2026-02 | [PDF](https://www-cdn.anthropic.com/6a5fa276ac68b9aeb0c8b6af5fa36326e0e166dd.pdf) |
| Claude Opus 4.5 | 2025-11 | [PDF](https://www-cdn.anthropic.com/bf10f64990cfda0ba858290be7b8cc6317685f47.pdf) |
| Claude Haiku 4.5 | 2025-10 | [PDF](https://www-cdn.anthropic.com/7aad69bf12627d42234e01ee7c36305dc2f6a970.pdf) |
| Claude Sonnet 4.5 | 2025-09 | [PDF](https://www-cdn.anthropic.com/963373e433e489a87a10c823c52a0a013e9172dd.pdf) |
| Claude Opus 4.1 | 2025-08 | [PDF](https://www-cdn.anthropic.com/9fa30625273bafdf5af82c93719d7ca606485a16.pdf) |
| Claude Sonnet 4 and Opus 4 | 2025-05 | [PDF](https://www-cdn.anthropic.com/07b2a3f9902ee19fe39a36ca638e5ae987bc64dd.pdf) |

## 文件

| 文件 | 说明 |
|---|---|
| `cards.json` | 待处理系统卡清单和官方 PDF raw URL |
| `translate.py` | 下载 PDF、提取文本、调用 Anthropic Messages API 翻译 |
| `extract_images.py` | 用 PyMuPDF 从各 `source.pdf` 提取内嵌配图到 `<card-id>/images/`，生成 `map.json`（页码→图片）|
| `render.mjs` | 把所有 `translated.md` 渲染为单个共享阅读器 `index.html`（顶部下拉切换卡片，按页码标记内嵌配图）|
| `pdfs/` | 一次性批量下载的全部原文 PDF |
| `<card-id>/source.pdf` | 各卡片原文 PDF |
| `<card-id>/translated.md` | 中文 Markdown 译文（头部记录 `翻译模型`）|
| `<card-id>/images/` | 从该卡片 PDF 提取的配图及 `map.json` |
| `<card-id>/translation_state.json` | 分批翻译进度，支持断点续跑 |
| `index.html` | 共享阅读器，浏览器直接打开 |

## 使用

脚本复用原 Opus 翻译同一套本地 Anthropic 代理环境变量：`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_DEFAULT_SONNET_MODEL`。

```bash
python translate.py --concurrency 100      # 翻译全部（已完成的卡片自动跳过）
python extract_images.py                   # 从 PDF 提取配图（可选传 card-id 只处理部分）
node render.mjs                            # 生成共享阅读器 index.html
```

只处理某几张卡：

```bash
python translate.py --only claude-opus-4-8 claude-mythos-preview --concurrency 100
```

只下载 PDF：

```bash
python translate.py --download-only
```

## API

- API style: Anthropic Messages（`anthropic` SDK，`auth_token`）
- Base URL: `ANTHROPIC_BASE_URL`（默认本地代理 `http://127.0.0.1:15721`）
- Model: `ANTHROPIC_DEFAULT_SONNET_MODEL`（默认 `claude-sonnet-4-6`）
- 输出约束：提示词强制只输出 `{"markdown": "..."}` JSON；解析端容错代码围栏、备用键名、未转义换行和被截断的输出
- 重试：默认最多 8 次，限流（503/429）按 20s 退避；单批次多次失败不写出该卡，重跑续翻

## 备注

- 配图按译文中保留的 `--- Page N ---` 页码标记精确插入对应章节；`claude-opus-4-8` 复用旧译文（无页码标记），改用按比例的页→章节映射。
- `claude-opus-4-8` 复用了原 `PDF_Translation` 的旧译文（同样由 `claude-sonnet-4-6` 翻译），未重译。
- 翻译与配图为机器自动处理，可能存在错漏；以官方英文 PDF 为准。
