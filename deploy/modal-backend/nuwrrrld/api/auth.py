"""Clerk session-JWT verification (Section 14): RS256 pinned, iss/exp/nbf checked, azp allow-listed."""
from __future__ import annotations

import os

import jwt
from fastapi import HTTPException, Request, status
from jwt import PyJWKClient

LEEWAY_SECONDS = 10
JWKS_LIFESPAN_SECONDS = 3600
_jwks: PyJWKClient | None = None
_jwks_url: str | None = None


class AuthUser:
    def __init__(self, clerk_user_id: str, session_id: str | None, claims: dict):
        self.clerk_user_id, self.session_id, self.claims = clerk_user_id, session_id, claims


def _client() -> PyJWKClient:
    global _jwks, _jwks_url
    url = os.environ["CLERK_JWKS_URL"]
    if _jwks is None or url != _jwks_url:           # module-level cache: JWK set refetched on unknown kid
        _jwks, _jwks_url = PyJWKClient(url, cache_keys=True, lifespan=JWKS_LIFESPAN_SECONDS), url
    return _jwks


def _bearer(request: Request) -> str:
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token")
    return token.strip()


def verify_clerk_token(token: str, *, key=None) -> AuthUser:
    """`key` lets tests inject a public key instead of fetching JWKS."""
    issuer = os.environ["CLERK_ISSUER"]
    parties = {p.strip() for p in os.environ.get("CLERK_AUTHORIZED_PARTIES", "").split(",") if p.strip()}
    try:
        signing_key = key if key is not None else _client().get_signing_key_from_jwt(token).key
        claims = jwt.decode(token, signing_key, algorithms=["RS256"], issuer=issuer, leeway=LEEWAY_SECONDS,
                            options={"require": ["exp", "iat", "iss", "sub"], "verify_aud": False})
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"Invalid token ({type(exc).__name__})") from exc
    azp = claims.get("azp")
    if azp is not None and azp not in parties:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unauthorized party")
    return AuthUser(claims["sub"], claims.get("sid"), claims)


async def current_auth(request: Request) -> AuthUser:
    return verify_clerk_token(_bearer(request))
