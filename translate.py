import argparse
import asyncio
import json
import os
import re
import time
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

import pdfplumber
import anthropic


BASE_DIR = Path(__file__).resolve().parent
CARDS_PATH = BASE_DIR / "cards.json"

# Use the same local Anthropic proxy + env the original Opus run used.
BASE_URL = os.environ.get("ANTHROPIC_BASE_URL", "http://127.0.0.1:15721")
AUTH_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN"
MODEL = os.environ.get("ANTHROPIC_DEFAULT_SONNET_MODEL", "claude-sonnet-4-6")

BATCH_SIZE = 5
RPM = 60
MAX_CONCURRENCY = 100
MAX_RETRIES = 8


TRANSLATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["markdown"],
    "properties": {
        "markdown": {
            "type": "string",
            "description": "完整中文 Markdown 译文。必须覆盖输入中的所有页码标记、标题、正文、表格和列表。",
        },
    },
}


SYSTEM_PROMPT = """你是严谨的中英文技术文档翻译专家，正在翻译 Anthropic Claude 系列模型系统卡(System Card)。

你必须只输出一个 JSON 对象：{"markdown": "<完整中文译文>"}。
禁止任何寒暄、说明、前言、致歉、解释或 Markdown 代码围栏；不要输出 "好的"、"以下是" 之类客套话。只输出 JSON 本身。

翻译硬性要求：
- 不得遗漏、合并、总结、扩写或重排原文信息；按输入顺序完整翻译。
- 保留 Markdown 层级、列表、表格、页码分隔符、脚注编号、公式、数值、URL、代码、基准名称和图表编号。
- 每个输入页码标记 `--- Page N ---` 必须在译文中原样保留，并作为该页开头。
- 【标题必须分级】凡是以章节号开头、独立成行的小节标题（如 `2 引言`、`2.1 风险评估流程`、`2.1.1 背景`），必须转成对应层级的 Markdown 标题：一级编号用 `##`、二级用 `###`、三级及以下用 `####`，标题独占一行，且其后必须空一行再接正文。绝不可把标题与正文连成同一段。
- 【保持分段】不同段落、不同列表项、标题与正文之间必须各自独立成行/成段；只有当同一段落因 PDF 提取被错误截断成多行时，才把这些碎行合并为一段。切勿把多个段落或标题揉成一大段连续文字。
- 模型名、产品名、机构名、数据集名、基准名、政策名首现时采用“中文译名(English Original)”；模型名称本身保留英文。
- 专业术语尽量统一，例如 alignment=对齐(alignment)、prompt injection=提示注入(prompt injection)、safeguards=安全防护(safeguards)、Responsible Scaling Policy=负责任扩展政策(Responsible Scaling Policy)。
- 表格尽量输出 Markdown 表格；表格内容过宽时也要保留全部单元格信息。
- 译文使用简体中文，风格自然、准确、适合技术白皮书。
"""


class RateLimiter:
    def __init__(self, rpm: int):
        self.interval = 60.0 / rpm
        self._lock = asyncio.Lock()
        self._next_at = 0.0

    async def wait(self) -> None:
        async with self._lock:
            now = time.monotonic()
            if now < self._next_at:
                await asyncio.sleep(self._next_at - now)
            self._next_at = max(now, self._next_at) + self.interval


def load_cards() -> list[dict[str, str]]:
    with CARDS_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def slug_dir(card: dict[str, str]) -> Path:
    return BASE_DIR / card["id"]


def download_pdf(card: dict[str, str], force: bool = False) -> Path:
    out_dir = slug_dir(card)
    out_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = out_dir / "source.pdf"
    if pdf_path.exists() and pdf_path.stat().st_size > 0 and not force:
        return pdf_path

    req = Request(card["url"], headers={"User-Agent": "Mozilla/5.0"})
    print(f"Downloading {card['title']} -> {pdf_path}")
    with urlopen(req, timeout=120) as resp:
        content_type = resp.headers.get("content-type", "")
        data = resp.read()
    if not data.startswith(b"%PDF"):
        raise RuntimeError(f"{card['title']} did not download as a PDF; content-type={content_type!r}")
    pdf_path.write_bytes(data)
    return pdf_path


def extract_pages(pdf_path: Path) -> list[tuple[int, str]]:
    pages_text: list[tuple[int, str]] = []
    with pdfplumber.open(str(pdf_path)) as pdf:
        for i, page in enumerate(pdf.pages):
            text = page.extract_text(x_tolerance=1.5, y_tolerance=3)
            if text and text.strip():
                pages_text.append((i + 1, text.strip()))
    return pages_text


def build_batches(pages: list[tuple[int, str]], batch_size: int) -> list[dict[str, Any]]:
    batches: list[dict[str, Any]] = []
    for i in range(0, len(pages), batch_size):
        batch_pages = pages[i : i + batch_size]
        text = "\n\n".join([f"--- Page {page_no} ---\n{page_text}" for page_no, page_text in batch_pages])
        batches.append(
            {
                "index": len(batches),
                "first_page": batch_pages[0][0],
                "last_page": batch_pages[-1][0],
                "text": text,
            }
        )
    return batches


def extract_json_object(raw: str) -> dict[str, Any]:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        obj = None
        match = re.search(r"\{.*\}", raw, re.S)
        if match:
            try:
                obj = json.loads(match.group(0))
            except json.JSONDecodeError:
                obj = None
    # fallback: model emitted raw newlines/control chars inside the string value,
    # so json.loads fails. Extract the single string value directly.
    if obj is None:
        m = re.search(r'"(?:markdown|translated_text|translation|text|content|result)"\s*:\s*"(.*?)"\s*\}\s*$', raw, re.S)
        if not m:
            # tolerate truncated/unterminated output: grab everything after the opening quote
            m = re.search(r'"(?:markdown|translated_text|translation|text|content|result)"\s*:\s*"(.*)$', raw, re.S)
        if not m:
            raise ValueError("could not extract markdown from response")
        body = m.group(1)
        body = re.sub(r'"\s*\}?\s*$', '', body)  # strip a trailing closing quote/brace if present
        # unescape JSON string escapes (backslash first to avoid double-processing)
        body = body.replace('\\\\', '\x00').replace('\\n', '\n').replace('\\t', '\t').replace('\\"', '"').replace('\x00', '\\')
        return {"markdown": body}
    # normalize: accept alternate key names the gateway model may emit
    if isinstance(obj, dict) and "markdown" not in obj:
        for alt in ("translated_text", "translation", "text", "content", "result"):
            if isinstance(obj.get(alt), str):
                obj = {"markdown": obj[alt]}
                break
    return obj


def validate_payload(payload: dict[str, Any]) -> None:
    if not isinstance(payload, dict):
        raise ValueError("response is not a JSON object")
    if not isinstance(payload.get("markdown"), str) or not payload["markdown"].strip():
        raise ValueError("response.markdown is empty or missing")


def load_state(state_path: Path) -> dict[str, Any]:
    if state_path.exists():
        with state_path.open("r", encoding="utf-8") as f:
            return json.load(f)
    return {"batches": {}}


def save_state(state_path: Path, state: dict[str, Any]) -> None:
    tmp_path = state_path.with_suffix(".tmp")
    with tmp_path.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    tmp_path.replace(state_path)


def make_client() -> "anthropic.AsyncAnthropic":
    token = os.environ.get(AUTH_TOKEN_ENV)
    if not token:
        raise RuntimeError(f"Missing {AUTH_TOKEN_ENV}. Set it before running translation.")
    return anthropic.AsyncAnthropic(base_url=BASE_URL, auth_token=token)


async def translate_batch(
    client: "anthropic.AsyncAnthropic",
    limiter: RateLimiter,
    semaphore: asyncio.Semaphore,
    card: dict[str, str],
    batch: dict[str, Any],
    total_batches: int,
) -> tuple[int, dict[str, Any]]:
    idx = batch["index"]
    user_payload = {
        "document_title": card["title"],
        "document_date": card["date"],
        "batch_index": idx + 1,
        "total_batches": total_batches,
        "page_range": [batch["first_page"], batch["last_page"]],
        "source_text": batch["text"],
    }

    async with semaphore:
        for attempt in range(1, MAX_RETRIES + 1):
            await limiter.wait()
            try:
                print(
                    f"  [{idx + 1}/{total_batches}] {card['title']} pages "
                    f"{batch['first_page']}-{batch['last_page']} attempt {attempt}"
                )
                response = await client.messages.create(
                    model=MODEL,
                    system=SYSTEM_PROMPT,
                    messages=[
                        {
                            "role": "user",
                            "content": "请翻译以下 JSON 中的 source_text，按 {\"markdown\": \"...\"} 返回 JSON：\n"
                            + json.dumps(user_payload, ensure_ascii=False),
                        },
                    ],
                    temperature=0.1,
                    max_tokens=8000,
                )
                content = "".join(
                    block.text for block in response.content if block.type == "text"
                )
                payload = extract_json_object(content)
                validate_payload(payload)
                print(f"  [{idx + 1}/{total_batches}] done")
                return idx, payload
            except Exception as exc:
                msg = str(exc)
                is_rate = "503" in msg or "429" in msg or "rate_limit" in msg
                print(f"  [{idx + 1}/{total_batches}] error: {msg[:80]}")
                if attempt == MAX_RETRIES:
                    raise
                if is_rate:
                    await asyncio.sleep(20)
                else:
                    await asyncio.sleep(min(2**attempt, 20))

    raise RuntimeError("unreachable")


async def translate_card(
    client: "anthropic.AsyncAnthropic",
    limiter: RateLimiter,
    card: dict[str, str],
    batch_size: int,
    concurrency: int,
    force: bool = False,
) -> None:
    card_dir = slug_dir(card)
    card_dir.mkdir(parents=True, exist_ok=True)
    out_path = card_dir / "translated.md"
    if out_path.exists() and not force:
        print(f"{card['title']}: translated.md already exists, skipping (use --force to retranslate)")
        return
    pdf_path = download_pdf(card)
    pages_path = card_dir / "pages.json"
    state_path = card_dir / "translation_state.json"

    if pages_path.exists() and not force:
        with pages_path.open("r", encoding="utf-8") as f:
            pages = [(int(p["page"]), p["text"]) for p in json.load(f)]
    else:
        print(f"Extracting {card['title']} text from {pdf_path}")
        pages = extract_pages(pdf_path)
        with pages_path.open("w", encoding="utf-8", newline="\n") as f:
            json.dump([{"page": p, "text": t} for p, t in pages], f, ensure_ascii=False, indent=2)
    print(f"{card['title']}: extracted {len(pages)} text pages")

    batches = build_batches(pages, batch_size)
    state = {"batches": {}} if force else load_state(state_path)
    done = state.setdefault("batches", {})

    pending = [batch for batch in batches if str(batch["index"]) not in done]
    print(f"{card['title']}: {len(done)}/{len(batches)} batches already done, {len(pending)} pending")

    if pending:
        semaphore = asyncio.Semaphore(concurrency)
        tasks = [
            translate_batch(client, limiter, semaphore, card, batch, len(batches))
            for batch in pending
        ]
        for coro in asyncio.as_completed(tasks):
            try:
                idx, payload = await coro
            except Exception as exc:
                print(f"{card['title']}: batch failed permanently: {exc}")
                continue
            done[str(idx)] = payload
            save_state(state_path, state)

    parts: list[str] = []
    missing = []
    for batch in batches:
        payload = done.get(str(batch["index"]))
        if not payload:
            missing.append(batch["index"])
            parts.append(f"<!-- 批次 {batch['index']} (页 {batch['first_page']}-{batch['last_page']}) 翻译失败，未包含 -->")
            continue
        parts.append(payload["markdown"].strip())

    if missing:
        print(f"{card['title']}: INCOMPLETE — {len(missing)} batches failed: {missing}. translated.md not written; rerun to retry.")
        return

    with out_path.open("w", encoding="utf-8", newline="\n") as f:
        f.write(f"# {card['title']} 系统卡片(System Card) 中文翻译\n\n")
        f.write(f"原文档日期：{card['date']}\n\n")
        f.write(f"原文 PDF：{card['url']}\n\n")
        f.write(f"翻译模型：{MODEL}\n\n")
        f.write("---\n\n")
        f.write("\n\n---\n\n".join(parts))

    print(f"{card['title']}: wrote {out_path}")


# Batches detected as low-quality (un-marked headings / paragraphs mashed together).
FIX_BATCHES: dict[str, list[int]] = {
    "claude-opus-4-6": [16, 37],
    "claude-opus-4-7": [21],
    "claude-sonnet-4-6": [3, 24],
}


def write_card_md(card: dict[str, str], batches: list[dict[str, Any]], done: dict[str, Any]) -> None:
    out_path = slug_dir(card) / "translated.md"
    parts: list[str] = []
    for batch in batches:
        payload = done.get(str(batch["index"]))
        if payload:
            parts.append(payload["markdown"].strip())
    with out_path.open("w", encoding="utf-8", newline="\n") as f:
        f.write(f"# {card['title']} 系统卡片(System Card) 中文翻译\n\n")
        f.write(f"原文档日期：{card['date']}\n\n")
        f.write(f"原文 PDF：{card['url']}\n\n")
        f.write(f"翻译模型：{MODEL}\n\n")
        f.write("---\n\n")
        f.write("\n\n---\n\n".join(parts))
    print(f"{card['title']}: rewrote {out_path}")


async def fix_card_batches(
    client: "anthropic.AsyncAnthropic",
    limiter: RateLimiter,
    card: dict[str, str],
    indices: list[int],
    batch_size: int,
    concurrency: int,
) -> None:
    card_dir = slug_dir(card)
    pages_path = card_dir / "pages.json"
    state_path = card_dir / "translation_state.json"
    with pages_path.open("r", encoding="utf-8") as f:
        pages = [(int(p["page"]), p["text"]) for p in json.load(f)]
    batches = build_batches(pages, batch_size)
    state = load_state(state_path)
    done = state.setdefault("batches", {})

    targets = [b for b in batches if b["index"] in indices]
    print(f"{card['title']}: re-translating {len(targets)} batches: {indices}")
    semaphore = asyncio.Semaphore(concurrency)
    tasks = [translate_batch(client, limiter, semaphore, card, b, len(batches)) for b in targets]
    for coro in asyncio.as_completed(tasks):
        try:
            idx, payload = await coro
        except Exception as exc:
            print(f"{card['title']}: fix batch failed: {exc}")
            continue
        done[str(idx)] = payload
        save_state(state_path, state)
    write_card_md(card, batches, done)


async def main() -> None:
    parser = argparse.ArgumentParser(description="Translate Claude system card PDFs to Chinese Markdown.")
    parser.add_argument("--only", nargs="*", help="Only process these card ids.")
    parser.add_argument("--download-only", action="store_true", help="Download PDFs but do not translate.")
    parser.add_argument("--force", action="store_true", help="Re-extract pages and retranslate batches.")
    parser.add_argument("--fix-batches", action="store_true", help="Re-translate the known low-quality batches in FIX_BATCHES.")
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    parser.add_argument("--rpm", type=int, default=RPM)
    parser.add_argument("--concurrency", type=int, default=MAX_CONCURRENCY)
    args = parser.parse_args()

    cards = load_cards()
    if args.only:
        wanted = set(args.only)
        cards = [card for card in cards if card["id"] in wanted]
        missing = wanted - {card["id"] for card in cards}
        if missing:
            raise RuntimeError(f"Unknown card ids: {', '.join(sorted(missing))}")

    for card in cards:
        download_pdf(card, force=args.force)

    if args.download_only:
        print("Download complete.")
        return

    client = make_client()
    limiter = RateLimiter(args.rpm)

    if args.fix_batches:
        by_id = {c["id"]: c for c in cards}
        for cid, indices in FIX_BATCHES.items():
            card = by_id.get(cid)
            if not card:
                continue
            try:
                await fix_card_batches(client, limiter, card, indices, args.batch_size, args.concurrency)
            except Exception as exc:
                import traceback
                print(f"{cid}: FIX FAILED: {exc}")
                traceback.print_exc()
        return

    for card in cards:
        try:
            await translate_card(
                client=client,
                limiter=limiter,
                card=card,
                batch_size=args.batch_size,
                concurrency=args.concurrency,
                force=args.force,
            )
        except Exception as exc:
            import traceback
            print(f"{card['title']}: CARD FAILED: {exc}")
            traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(main())
