"""Temporary diagnostic: unique objects and mandatory cleanup, no publication."""

import json
import os
from pathlib import Path
import tempfile
import time
from urllib.parse import urlsplit

import requests
from qiniu import Auth, BucketManager, put_file_v2
from qiniu import config
from qiniu.http.default_client import qn_http_client
from qiniu.region import LegacyRegion


def output(**fields):
    print(json.dumps(fields, sort_keys=True), flush=True)


def safe_error(exc):
    """Never emit raw text, headers, paths, bucket names or credentials."""
    chain = []
    seen = set()
    current = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        message = str(current).lower()
        labels = [
            label for needle, label in (
                ("timed out", "timeout"),
                ("name or service not known", "dns-resolution"),
                ("temporary failure in name resolution", "dns-resolution"),
                ("connection refused", "connection-refused"),
                ("remote end closed", "remote-disconnect"),
                ("connection reset", "connection-reset"),
                ("certificate verify failed", "certificate-validation"),
                ("broken pipe", "broken-pipe"),
                ("too many open files", "fd-limit"),
                ("ssl", "tls"),
                ("proxy", "proxy"),
            ) if needle in message
        ]
        entry = {"type": type(current).__name__, "classification": labels}
        if isinstance(getattr(current, "errno", None), int):
            entry["errno"] = current.errno
        chain.append(entry)
        current = current.__cause__ or current.__context__
    return chain


original_send = qn_http_client._wrap_send


def inspect_send(request, **kwargs):
    parsed = urlsplit(request.url)
    stage = "multipart" if "/uploads" in parsed.path else "control-or-form"
    started = time.monotonic()
    metadata = {"method": request.method, "scheme": parsed.scheme,
                "host": parsed.hostname, "stage": stage}
    output(event="request-start", **metadata)
    try:
        response = original_send(request, **kwargs)
    except Exception as exc:
        output(event="request-exception", elapsed=round(time.monotonic() - started, 2),
               error=safe_error(exc), **metadata)
        raise
    output(event="request-result", elapsed=round(time.monotonic() - started, 2),
           status=response.status_code, **metadata)
    return response


qn_http_client._wrap_send = inspect_send
config.set_default(connection_timeout=5, connection_retries=1)
auth = Auth(os.environ["QINIU_ACCESS_KEY"], os.environ["QINIU_SECRET_KEY"])
bucket_name = os.environ["QINIU_BUCKET"]
run_id = os.environ["GITHUB_RUN_ID"]
attempt = os.environ["GITHUB_RUN_ATTEMPT"]
prefix = f"diagnostics/qiniu-{run_id}-{attempt}"
keys = []
results = {}

for scheme in ("http", "https"):
    started = time.monotonic()
    try:
        response = requests.get(f"{scheme}://upload.qiniup.com/", timeout=5)
        output(event="unauthenticated-connectivity", scheme=scheme,
               status=response.status_code, elapsed=round(time.monotonic() - started, 2))
    except Exception as exc:
        output(event="unauthenticated-connectivity", scheme=scheme,
               error=safe_error(exc), elapsed=round(time.monotonic() - started, 2))

cleanup_failed = False
try:
    with tempfile.TemporaryDirectory() as directory:
        fixture = Path(directory) / "transport.bin"
        with fixture.open("wb") as file:
            for _ in range(9):
                file.write(bytes(1024 * 1024))
        for scheme in ("https", "http"):
            config.set_default(default_zone=LegacyRegion(scheme=scheme))
            config.set_default(connection_timeout=(5, 30) if scheme == "https" else (5, 5))
            key = f"{prefix}/{scheme}.bin"
            keys.append(key)
            started = time.monotonic()
            try:
                result, response = put_file_v2(
                    auth.upload_token(bucket_name, key, 900), key, str(fixture),
                    check_crc=True, mime_type="application/octet-stream",
                )
                results[scheme] = response.status_code == 200 and bool(result)
                output(event="upload-result", scheme=scheme,
                       status=response.status_code, success=results[scheme],
                       elapsed=round(time.monotonic() - started, 2),
                       error=safe_error(response.exception))
            except Exception as exc:
                results[scheme] = False
                output(event="upload-exception", scheme=scheme,
                       elapsed=round(time.monotonic() - started, 2), error=safe_error(exc))
finally:
    config.set_default(default_zone=LegacyRegion(scheme="https"))
    manager = BucketManager(auth)
    for index, key in enumerate(keys):
        try:
            _, response = manager.delete(bucket_name, key)
            cleaned = response.status_code in (200, 612)
            cleanup_failed |= not cleaned
            output(event="cleanup", object_index=index, status=response.status_code,
                   success=cleaned, error=safe_error(response.exception))
        except Exception as exc:
            cleanup_failed = True
            output(event="cleanup-exception", object_index=index, error=safe_error(exc))

output(event="summary", results=results, cleanup_success=not cleanup_failed)
if cleanup_failed:
    raise SystemExit(2)
