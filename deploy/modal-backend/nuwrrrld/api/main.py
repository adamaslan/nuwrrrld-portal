"""FastAPI app factory (Section 3.5)."""
from __future__ import annotations

import logging
import os
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from nuwrrrld import db, logging_utils
from nuwrrrld.api import errors
from nuwrrrld.config import settings

log = logging.getLogger(__name__)
DB_POOL_MAX = 5


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging_utils.configure()
    if dsn := os.environ.get("DATABASE_URL"):
        await db.init_pool(min_size=1, max_size=DB_POOL_MAX, dsn=dsn)
    if os.environ.get("SENTRY_DSN"):
        import sentry_sdk
        sentry_sdk.init(dsn=os.environ["SENTRY_DSN"], environment=os.environ.get("MODAL_ENVIRONMENT", "prod"))
    yield
    await db.close_pool()


def create_app() -> FastAPI:
    from nuwrrrld.api.routers import (admin, billing, chat, council, digest, followed, holdfold, me, portfolio,
                                      referrals, webhooks)
    is_staging = os.environ.get("MODAL_ENVIRONMENT") == "staging"
    app = FastAPI(title="NuWrrrld API", version="1", lifespan=lifespan,
                  docs_url="/docs" if is_staging else None, redoc_url=None, openapi_url="/openapi.json" if is_staging else None)
    app.add_middleware(CORSMiddleware, allow_origins=list(settings().cors_origins), allow_credentials=False,
                       allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
                       allow_headers=["Authorization", "Content-Type", "Idempotency-Key"])
    errors.install(app)

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        request.state.request_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:16]
        started = time.perf_counter()
        response = await call_next(request)
        response.headers["X-Request-Id"] = request.state.request_id
        log.info("request", extra={"request_id": request.state.request_id,
                                   "latency_ms": int((time.perf_counter() - started) * 1000)})
        return response

    for r in (me, digest, chat, holdfold, referrals, portfolio, followed, council, billing, webhooks, admin):
        app.include_router(r.router, prefix="/v1")

    @app.get("/healthz")
    async def healthz():
        return {"ok": True}

    return app
