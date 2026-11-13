from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

load_dotenv(Path(__file__).resolve().parents[2] / ".env")

SQLALCHEMY_DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./azure_monitor.db")
engine_options = {"connect_args": {"check_same_thread": False}} if SQLALCHEMY_DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    **engine_options,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def init_db() -> None:
    from app.models import auth, customer, metric, resource, subscription  # noqa: F401

    Base.metadata.create_all(bind=engine)
