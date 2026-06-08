from typing import Any, Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, status
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.db import engine, get_db, init_db
from app.models import JotformSubmission, SyncEvent
from app.security import ensure_admin_key, verify_webhook_secret
from app.services.google_sheets import append_submission_to_sheet
from app.services.jotform import normalize_jotform_payload, parse_request_payload

app = FastAPI(
    title="STUCHA Loans Webhook API",
    version="1.0.0",
    docs_url="/docs",
    redoc_url=None,
)


@app.on_event("startup")
def startup() -> None:
    init_db()


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    with engine.connect() as connection:
        connection.execute(text("select 1"))
    return {"ok": True, "database": "ok"}


@app.post("/webhooks/jotform", status_code=status.HTTP_202_ACCEPTED)
async def jotform_webhook(
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
    x_webhook_secret: Annotated[str | None, Header()] = None,
    token: Annotated[str | None, Query()] = None,
) -> dict[str, Any]:
    verify_webhook_secret(settings, x_webhook_secret, token)

    payload = await parse_request_payload(request)
    normalized = normalize_jotform_payload(payload)

    existing = None
    if normalized.submission_id:
        existing = db.scalar(
            select(JotformSubmission).where(
                JotformSubmission.submission_id == normalized.submission_id
            )
        )

    if existing:
        submission = existing
        submission.applicant_name = normalized.applicant_name
        submission.applicant_email = normalized.applicant_email
        submission.applicant_phone = normalized.applicant_phone
        submission.loan_amount = normalized.loan_amount
        submission.raw_payload = payload
    else:
        submission = JotformSubmission(
            submission_id=normalized.submission_id,
            applicant_name=normalized.applicant_name,
            applicant_email=normalized.applicant_email,
            applicant_phone=normalized.applicant_phone,
            loan_amount=normalized.loan_amount,
            raw_payload=payload,
        )
        db.add(submission)

    db.commit()
    db.refresh(submission)

    sheet_status = "skipped"
    sheet_message = "Google Sheets env vars are not configured."
    try:
        sheet_result = append_submission_to_sheet(settings, submission)
        sheet_status = sheet_result["status"]
        sheet_message = sheet_result["message"]
    except Exception as exc:  # Keep Jotform webhooks reliable even if Sheets fails.
        sheet_status = "failed"
        sheet_message = str(exc)

    db.add(
        SyncEvent(
            submission_id=submission.id,
            target="google_sheets",
            status=sheet_status,
            message=sheet_message,
        )
    )
    db.commit()

    return {
        "ok": True,
        "database_id": str(submission.id),
        "submission_id": submission.submission_id,
        "sheet_sync": sheet_status,
    }


@app.get("/submissions")
def list_submissions(
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
    x_admin_api_key: Annotated[str | None, Header()] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> dict[str, Any]:
    ensure_admin_key(settings, x_admin_api_key)
    rows = db.scalars(
        select(JotformSubmission)
        .order_by(JotformSubmission.created_at.desc())
        .limit(limit)
    ).all()
    return {
        "items": [
            {
                "id": str(row.id),
                "submission_id": row.submission_id,
                "name": row.applicant_name,
                "phone": row.applicant_phone,
                "email": row.applicant_email,
                "loan_amount": float(row.loan_amount) if row.loan_amount else None,
                "status": row.status,
                "created_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in rows
        ]
    }
