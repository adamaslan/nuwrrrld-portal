"""application/problem+json errors (Section 8 conventions)."""
from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

PROBLEM = "application/problem+json"
TITLES = {400: "Bad Request", 401: "Unauthorized", 402: "Subscription Required", 403: "Forbidden", 404: "Not Found",
          409: "Conflict", 422: "Unprocessable Entity", 429: "Too Many Requests", 500: "Internal Server Error",
          503: "Service Unavailable"}


def problem(status: int, code: str, detail: str = "", request_id: str = "", **extra) -> JSONResponse:
    body = {"type": f"https://api.financial.nuwrrrld.com/problems/{code}", "title": TITLES.get(status, "Error"),
            "status": status, "detail": detail or code, "code": code, "request_id": request_id, **extra}
    return JSONResponse(body, status_code=status, media_type=PROBLEM)


def _rid(request: Request) -> str:
    return getattr(request.state, "request_id", "")


def install(app: FastAPI) -> None:
    @app.exception_handler(HTTPException)
    async def http_exc(request: Request, exc: HTTPException):
        d = exc.detail
        if isinstance(d, dict):
            extra = {k: v for k, v in d.items() if k not in ("code", "detail")}
            return problem(exc.status_code, d.get("code", "error"), d.get("detail", ""), _rid(request), **extra)
        return problem(exc.status_code, str(d).lower().replace(" ", "_")[:48], str(d), _rid(request))

    @app.exception_handler(RequestValidationError)
    async def validation_exc(request: Request, exc: RequestValidationError):
        errs = [f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()][:5]
        return problem(422, "validation_error", "; ".join(errs), _rid(request))

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception):
        import logging
        logging.getLogger(__name__).exception("unhandled error request_id=%s", _rid(request))
        try:
            import sentry_sdk
            sentry_sdk.capture_exception(exc)
        except ImportError:
            pass
        return problem(500, "internal_error", "Unexpected error", _rid(request))   # never leak stack traces
