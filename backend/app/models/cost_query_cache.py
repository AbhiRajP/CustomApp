from __future__ import annotations

from sqlalchemy import Column, Float, String, Text

from app.core.database import Base


class CostQueryCache(Base):
    __tablename__ = "cost_query_cache"

    cache_key = Column(String(64), primary_key=True)
    response_json = Column(Text, nullable=False)
    expires_at = Column(Float, nullable=False, index=True)
