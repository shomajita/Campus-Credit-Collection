import secrets

from fastapi import HTTPException, status

from app.config import Settings


def verify_webhook_secret(
    settings: Settings,
    header_secret: str | None,
    query_token: str | None,
) -> None:
    provided = header_secret or query_token or ""
    if not secrets.compare_digest(provided, settings.jotform_webhook_secret):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid webhook secret.",
        )


def ensure_admin_key(settings: Settings, header_key: str | None) -> None:
    if not settings.admin_api_key:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Admin API is not enabled.",
        )
    if not header_key or not secrets.compare_digest(header_key, settings.admin_api_key):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid admin API key.",
        )
