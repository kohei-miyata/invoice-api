import anthropic
import base64
import json
from typing import Any
from ..config import settings

_client: anthropic.AsyncAnthropic | None = None


def get_client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        _client = anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
    return _client


_EXTRACT_SYSTEM = """あなたは請求書・領収書のデータ抽出専門AIです。
提供された文書から構造化されたJSONデータを抽出してください。

【日付の変換ルール】
- 年が1〜2桁の場合は令和（Reiwa）として扱う。令和N年 = 2018 + N 年（例: 令和6年 → 2024年）
- 年が4桁の場合はそのまま西暦として扱う
- すべての日付は最終的に YYYY-MM-DD 形式で出力する

必ず以下のフィールドを含むJSONのみを返してください（コードブロックや説明文は不要）:
{
  "document_type": "文書種別（請求書 or 領収書）",
  "invoice_number": "請求書番号",
  "invoice_date": "発行日 (YYYY-MM-DD形式)",
  "due_date": "支払期限 (YYYY-MM-DD形式)",
  "vendor_name": "発行者・会社名",
  "vendor_address": "発行者住所",
  "vendor_registration_number": "適格請求書登録番号",
  "buyer_name": "宛先・買い手名",
  "subtotal": 小計金額(数値),
  "tax_amount": 消費税額(数値),
  "total_amount": 合計金額(数値),
  "currency": "通貨コード (JPY等)",
  "line_items": [
    {
      "description": "品目説明",
      "quantity": 数量(数値),
      "unit_price": 単価(数値),
      "amount": 金額(数値)
    }
  ],
  "notes": "備考"
}"""

_MATCH_SYSTEM = """あなたは会社マスタ照合専門AIです。
請求書の発行者情報と会社マスタを照合し、一致スコアを算出してください。
必ず以下のJSON配列のみを返してください（上位3件、コードブロックや説明文は不要）:
[
  {
    "company_id": "会社ID",
    "company_name": "会社名",
    "score": 0.0〜1.0の一致スコア,
    "reason": "一致理由の説明"
  }
]
スコアは1.0が完全一致、0.0が全く一致しないことを意味します。"""


def _parse_json_response(text: str) -> Any:
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1]).strip()
    return json.loads(text)


def _usage(response) -> dict:
    return {
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
    }


async def extract_invoice_data(file_content: bytes, file_type: str) -> tuple[dict, dict]:
    client = get_client()
    encoded = base64.standard_b64encode(file_content).decode()

    media_type_map = {
        "pdf": "application/pdf",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "png": "image/png",
        "gif": "image/gif",
        "webp": "image/webp",
    }
    media_type = media_type_map.get(file_type.lower(), "image/jpeg")

    if media_type == "application/pdf":
        content: list = [
            {
                "type": "document",
                "source": {"type": "base64", "media_type": media_type, "data": encoded},
            },
            {"type": "text", "text": "この請求書・領収書からデータを抽出してJSONのみで返してください。"},
        ]
    else:
        content = [
            {
                "type": "image",
                "source": {"type": "base64", "media_type": media_type, "data": encoded},
            },
            {"type": "text", "text": "この請求書・領収書からデータを抽出してJSONのみで返してください。"},
        ]

    response = await client.messages.create(
        model=settings.CLAUDE_MODEL,
        max_tokens=2048,
        system=[{"type": "text", "text": _EXTRACT_SYSTEM, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": content}],
    )

    data = _parse_json_response(response.content[0].text)
    if isinstance(data, list):
        data = data[0] if data else {}
    return data, _usage(response)


async def match_company(extracted_data: dict, companies: list[dict]) -> tuple[list[dict], dict]:
    client = get_client()

    response = await client.messages.create(
        model=settings.CLAUDE_MODEL,
        max_tokens=1024,
        system=[{"type": "text", "text": _MATCH_SYSTEM, "cache_control": {"type": "ephemeral"}}],
        messages=[
            {
                "role": "user",
                "content": (
                    f"請求書情報:\n{json.dumps(extracted_data, ensure_ascii=False, indent=2)}\n\n"
                    f"会社マスタ:\n{json.dumps(companies, ensure_ascii=False, indent=2)}\n\n"
                    "上記の請求書の発行者と会社マスタを照合してください。"
                ),
            }
        ],
    )

    return _parse_json_response(response.content[0].text), _usage(response)
