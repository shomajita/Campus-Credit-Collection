import json
from decimal import Decimal, InvalidOperation
from typing import Any

from fastapi import HTTPException, Request, status

from app.schemas import NormalizedJotformPayload


async def parse_request_payload(request: Request) -> dict[str, Any]:
    content_type = request.headers.get("content-type", "")

    if "application/json" in content_type:
        data = await request.json()
    else:
        form = await request.form()
        data = dict(form)

    if isinstance(data.get("rawRequest"), str):
        try:
            raw_request = json.loads(data["rawRequest"])
            if isinstance(raw_request, dict):
                data = {**data, **raw_request}
        except json.JSONDecodeError:
            pass

    if not isinstance(data, dict):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Webhook payload must be an object.",
        )
    return data


def normalize_jotform_payload(payload: dict[str, Any]) -> NormalizedJotformPayload:
    flat = _flatten_payload(payload)

    return NormalizedJotformPayload(
        submission_id=_pick(flat, "submission_id", "submissionID", "submissionId", "id"),
        applicant_name=_pick(flat, "name", "full_name", "fullName", "Full Name"),
        applicant_email=_pick(flat, "email", "Email"),
        applicant_phone=_pick(flat, "phone", "phone_number", "phoneNumber", "Phone Number"),
        loan_amount=_money(_pick(flat, "loan_amount", "loanAmount", "Loan Amount", "amount")),
        raw=payload,
    )


def _flatten_payload(payload: dict[str, Any]) -> dict[str, Any]:
    flat = dict(payload)
    answers = payload.get("answers")
    if isinstance(answers, dict):
        for answer in answers.values():
            if not isinstance(answer, dict):
                continue
            key = answer.get("name") or answer.get("text")
            value = answer.get("answer") or answer.get("prettyFormat")
            if key and value is not None:
                flat[str(key)] = value
    return flat


def _pick(payload: dict[str, Any], *keys: str) -> str | None:
    lower_lookup = {str(key).lower(): value for key, value in payload.items()}
    for key in keys:
        value = payload.get(key)
        if value is None:
            value = lower_lookup.get(key.lower())
        if value not in (None, ""):
            return str(value).strip()
    return None


def _money(value: str | None) -> Decimal | None:
    if not value:
        return None
    cleaned = "".join(char for char in value if char.isdigit() or char == ".")
    if not cleaned:
        return None
    try:
        return Decimal(cleaned).quantize(Decimal("0.01"))
    except InvalidOperation:
        return None
