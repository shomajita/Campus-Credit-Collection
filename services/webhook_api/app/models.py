import uuid
from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Numeric, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class JotformSubmission(TimestampMixin, Base):
    __tablename__ = "jotform_submissions"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    source: Mapped[str] = mapped_column(String(40), default="jotform", nullable=False)
    submission_id: Mapped[Optional[str]] = mapped_column(
        String(128),
        unique=True,
        index=True,
        nullable=True,
    )
    applicant_name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    applicant_email: Mapped[Optional[str]] = mapped_column(String(254), nullable=True)
    applicant_phone: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    loan_amount: Mapped[Optional[Decimal]] = mapped_column(Numeric(12, 2), nullable=True)
    status: Mapped[str] = mapped_column(String(40), default="received", nullable=False)
    raw_payload: Mapped[dict] = mapped_column(JSONB, nullable=False)


class SyncEvent(TimestampMixin, Base):
    __tablename__ = "sync_events"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    submission_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("jotform_submissions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    target: Mapped[str] = mapped_column(String(80), nullable=False)
    status: Mapped[str] = mapped_column(String(40), nullable=False)
    message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
