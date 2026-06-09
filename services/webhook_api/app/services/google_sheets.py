import base64
import json
from typing import Any, Dict

from google.oauth2 import service_account
from googleapiclient.discovery import build

from app.config import Settings
from app.models import JotformSubmission

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]


def append_submission_to_sheet(
    settings: Settings,
    submission: JotformSubmission,
) -> Dict[str, str]:
    if not settings.google_sheet_id or not settings.google_service_account_json_b64:
        return {"status": "skipped", "message": "Google Sheets is not configured."}

    decoded = base64.b64decode(settings.google_service_account_json_b64)
    service_account_info: Dict[str, Any] = json.loads(decoded)
    credentials = service_account.Credentials.from_service_account_info(
        service_account_info,
        scopes=SCOPES,
    )
    service = build("sheets", "v4", credentials=credentials, cache_discovery=False)

    values = [
        [
            submission.created_at.isoformat() if submission.created_at else "",
            submission.applicant_name or "",
            submission.applicant_phone or "",
            submission.applicant_email or "",
            str(submission.loan_amount or ""),
            submission.submission_id or "",
            submission.status,
            "Jotform",
        ]
    ]
    result = (
        service.spreadsheets()
        .values()
        .append(
            spreadsheetId=settings.google_sheet_id,
            range=f"{settings.google_sheet_tab}!A:H",
            valueInputOption="USER_ENTERED",
            insertDataOption="INSERT_ROWS",
            body={"values": values},
        )
        .execute()
    )
    return {
        "status": "success",
        "message": result.get("updates", {}).get("updatedRange", "Row appended."),
    }
