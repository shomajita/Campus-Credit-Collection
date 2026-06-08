from decimal import Decimal
from typing import Any

from pydantic import BaseModel


class NormalizedJotformPayload(BaseModel):
    submission_id: str | None = None
    applicant_name: str | None = None
    applicant_email: str | None = None
    applicant_phone: str | None = None
    loan_amount: Decimal | None = None
    raw: dict[str, Any]
