from __future__ import annotations

from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, String
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.core.database import Base


class AzureResource(Base):
    __tablename__ = "azure_resources"

    id = Column(String, primary_key=True)
    subscription_id = Column(String, ForeignKey("azure_subscriptions.id"), nullable=False, index=True)
    resource_group = Column(String, nullable=False)
    resource_type = Column(String, nullable=False)
    name = Column(String, nullable=False)
    region = Column(String, nullable=False)
    sku = Column(String, nullable=True)
    tags = Column(String, nullable=True)
    state = Column(String, nullable=False, default="Running")
    cost_per_month = Column(Float, default=0.0)
    discovered_at = Column(DateTime(timezone=True), server_default=func.now())
    subscription = relationship("AzureSubscription")
    is_active = Column(Boolean, default=True)
