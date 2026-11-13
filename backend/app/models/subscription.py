from __future__ import annotations

from sqlalchemy import Column, DateTime, ForeignKey, String
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.core.database import Base


class AzureSubscription(Base):
    __tablename__ = "azure_subscriptions"

    id = Column(String, primary_key=True)
    customer_id = Column(String, ForeignKey("customers.id"), nullable=False, index=True)
    subscription_name = Column(String, nullable=False)
    tenant_id = Column(String, nullable=False)
    state = Column(String, nullable=False, default="Enabled")
    region = Column(String, nullable=True)
    last_sync_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    customer = relationship("CustomerProfile")
