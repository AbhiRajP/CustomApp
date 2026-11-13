from __future__ import annotations

from sqlalchemy import Column, DateTime, Float, ForeignKey, String
from sqlalchemy.sql import func

from app.core.database import Base


class MetricSnapshot(Base):
    __tablename__ = "metric_snapshots"

    id = Column(String, primary_key=True)
    subscription_id = Column(String, ForeignKey("azure_subscriptions.id"), nullable=False, index=True)
    resource_id = Column(String, nullable=True, index=True)
    metric_name = Column(String, nullable=False)
    timestamp = Column(DateTime(timezone=True), server_default=func.now())
    value = Column(Float, nullable=False)
    unit = Column(String, nullable=True)
