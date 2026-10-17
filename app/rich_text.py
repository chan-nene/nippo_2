"""Limited rich text contract shared by API validation, CSV storage and migration."""
from __future__ import annotations

import json
from typing import Any

RICH_FIELDS = {
    "business_name": "business_name_rich_text",
    "business_detail": "business_detail_rich_text",
    "reply_text": "reply_rich_text",
    "comment": "comment_rich_text",
}
MAX_TEXT_LENGTH = 20_000
MAX_JSON_BYTES = 2_000_000
MAX_NODES = 40_000


def from_plain(text: str) -> dict[str, Any]:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        text = ""
    return {"version": 1, "doc": {"type": "doc", "content": [
        {"type": "paragraph", **({"content": [{"type": "text", "text": line}]} if line else {})}
        for line in text.split("\n")
    ]}}


def normalize(value: Any) -> tuple[dict[str, Any], str]:
    """Reject unsupported nodes/attributes/marks; return canonical JSON and derived text."""
    try:
        if isinstance(value, str):
            if len(value.encode("utf-8")) > MAX_JSON_BYTES:
                raise ValueError("書式データが大きすぎます。")
            value = json.loads(value)
        if not isinstance(value, dict) or set(value) != {"version", "doc"} or type(value["version"]) is not int or value["version"] != 1:
            raise ValueError("書式データの版または項目が不正です。")
        doc = value["doc"]
        if not isinstance(doc, dict) or set(doc) != {"type", "content"} or doc["type"] != "doc" or not isinstance(doc["content"], list) or not doc["content"]:
            raise ValueError("文章データが不正です。")
        paragraphs, texts, count = [], [], 0
        for paragraph in doc["content"]:
            if not isinstance(paragraph, dict) or not set(paragraph) <= {"type", "content"} or paragraph.get("type") != "paragraph" or not isinstance(paragraph.get("content", []), list):
                raise ValueError("段落データが不正です。")
            content, parts = [], []
            count += 1
            if count > MAX_NODES:
                raise ValueError("文章データの要素が多すぎます。")
            for node in paragraph.get("content", []):
                count += 1
                if count > MAX_NODES or not isinstance(node, dict):
                    raise ValueError("文章データの要素が多すぎるか不正です。")
                if node == {"type": "hardBreak"}:
                    content.append(node)
                    parts.append("\n")
                    continue
                if not set(node) <= {"type", "text", "marks"} or node.get("type") != "text" or not isinstance(node.get("text"), str) or not node["text"] or any(c in node["text"] for c in ("\n", "\r", "\x00")):
                    raise ValueError("文字データが不正です。")
                marks = node.get("marks", [])
                if not isinstance(marks, list) or any(not isinstance(m, dict) or set(m) != {"type"} or m["type"] not in {"bold", "underline"} for m in marks):
                    raise ValueError("使用できる書式は太字と下線です。")
                names = sorted({m["type"] for m in marks})
                if len(names) != len(marks):
                    raise ValueError("書式が重複しています。")
                normalized = {"type": "text", "text": node["text"]}
                if names:
                    normalized["marks"] = [{"type": name} for name in names]
                if content and content[-1].get("type") == "text" and content[-1].get("marks", []) == normalized.get("marks", []):
                    content[-1]["text"] += normalized["text"]
                else:
                    content.append(normalized)
                parts.append(node["text"])
            paragraphs.append({"type": "paragraph", **({"content": content} if content else {})})
            texts.append("".join(parts))
        plain = "\n".join(texts)
        if len(plain) > MAX_TEXT_LENGTH:
            raise ValueError("文章が長すぎます。")
        result = {"version": 1, "doc": {"type": "doc", "content": paragraphs}}
        if not plain.strip():
            result, plain = from_plain(""), ""
        if len(json.dumps(result, ensure_ascii=False).encode("utf-8")) > MAX_JSON_BYTES:
            raise ValueError("書式データが大きすぎます。")
        return result, plain
    except (TypeError, KeyError, RecursionError, json.JSONDecodeError) as exc:
        raise ValueError("書式データが不正です。") from exc


def serialize(value: Any) -> tuple[str, str]:
    document, plain = normalize(value)
    return json.dumps(document, ensure_ascii=False, separators=(",", ":")), plain


EMPTY_RICH_TEXT = serialize(from_plain(""))[0]
