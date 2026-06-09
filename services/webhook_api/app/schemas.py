from decimal import Decimal
from typing import Any, Dict, Optional

from pydantic import BaseModel


class NormalizedJotformPayload(BaseModel):
    submission_id: Optional[str] = None
    applicant_name: Optional[str] = None
    applicant_email: Optional[str] = None
    applicant_phone: Optional[str] = None
    loan_amount: Optional[Decimal] = None
    raw: Dict[str, Any]
