from __future__ import annotations

from sqlalchemy import Column, DateTime, String, Text
from sqlalchemy.sql import func

from app.core.database import Base


class AzureAuthSession(Base):
    __tablename__ = "azure_auth_sessions"

    id = Column(String, primary_key=True)
    tenant_id = Column(String, nullable=False, index=True)
    home_account_id = Column(String, nullable=False)
    encrypted_token_cache = Column(Text, nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class CustomerPreference(Base):
    __tablename__ = "customer_preferences"

    tenant_id = Column(String, primary_key=True)
    subscription_id = Column(String, nullable=True)
    resource_group = Column(String, nullable=True)
    enabled_metrics_json = Column(
        Text,
        nullable=False,
        default='["cpu","memory","networkIn","networkOut","diskRead","diskWrite"]',
    )
    resource_ids_json = Column(Text, nullable=False, default="[]")
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
